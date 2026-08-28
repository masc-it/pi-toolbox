import { MEMORY_BATCH_MAX_BYTES, MEMORY_BATCH_MAX_FACTS } from "./config.ts";
import { MemoryCurator, type CuratorBatch } from "./curator.ts";
import { acquireMemoryLock } from "./lock.ts";
import { recordMemoryError, type MemoryErrorWriter } from "./log.ts";
import type { PendingMemoryBatch } from "./queue.ts";

const BATCH_RETRY_DELAYS_MS = [5_000, 30_000, 5 * 60_000] as const;
const CONSUMER_RETRY_DELAY_MS = 30_000;

interface ConsumerQueue extends MemoryErrorWriter {
	nextPendingBatch(maxRows?: number, excludedCwds?: ReadonlySet<string>): PendingMemoryBatch | null;
	markProcessed(ids: readonly bigint[], processedAt: string): void;
	close(): void;
}

interface ConsumerCurator {
	curate(batch: CuratorBatch, knowledgeBaseDirectory: string, signal: AbortSignal): Promise<void>;
}

interface ConsumerRepository {
	readonly path: string;
	assertClean(): void;
	changedPaths(): string[];
	validateChanges(paths: readonly string[]): void;
	commit(paths: readonly string[]): void;
	rollback(): void;
}

interface BatchRetryState {
	failures: number;
	retryAt: number | null;
}

type LockAcquirer = typeof acquireMemoryLock;

export class MemoryConsumer {
	private readonly abortController = new AbortController();
	private readonly retries = new Map<string, BatchRetryState>();
	private flight: Promise<void> | null = null;
	private retryTimer: NodeJS.Timeout | null = null;
	private retryWakeAt: number | null = null;
	private wakeRequested = false;
	private closed = false;

	constructor(
		private readonly queue: ConsumerQueue,
		private readonly curator: ConsumerCurator,
		private readonly repository: ConsumerRepository,
		private readonly lockPath: string,
		private readonly acquireLock: LockAcquirer = acquireMemoryLock,
	) {}

	wake(): void {
		if (this.closed) {
			return;
		}
		this.wakeRequested = true;
		if (this.flight) {
			return;
		}

		const flight = this.run();
		this.flight = flight;
		void flight.finally(() => {
			if (this.flight !== flight) {
				return;
			}
			this.flight = null;
			if (this.wakeRequested && !this.closed) {
				this.wake();
			}
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		this.abortController.abort();
		this.clearRetryTimer();
		await this.flight;
		this.queue.close();
	}

	private async run(): Promise<void> {
		try {
			do {
				this.wakeRequested = false;
				await this.drainQueue();
			} while (this.wakeRequested && !this.closed);
		} catch (error) {
			if (this.closed && isAbortError(error)) {
				return;
			}
			logConsumerFailure(this.queue, error);
			this.scheduleWake(CONSUMER_RETRY_DELAY_MS);
		}
	}

	private async drainQueue(): Promise<void> {
		const lock = await this.acquireLock(this.lockPath, this.abortController.signal);
		try {
			while (!this.closed) {
				const pending = this.queue.nextPendingBatch(MEMORY_BATCH_MAX_FACTS, this.excludedCwds());
				if (!pending) {
					this.scheduleNextBatchRetry();
					return;
				}
				const batch = buildBoundedBatch(pending);
				try {
					await this.processBatch(batch);
					this.retries.delete(batch.cwd);
				} catch (error) {
					if (this.closed && isMemoryConsumerAbort(error)) {
						throw error.cause;
					}
					const retry = this.recordBatchFailure(batch.cwd);
					logConsumerFailure(this.queue, error, retry);
				}
			}
		} finally {
			lock.release();
		}
	}

	private async processBatch(batch: CuratorBatch): Promise<void> {
		const rowIds = batch.rows.map((row) => row.id);
		let repositoryWasClean = false;
		let committed = false;
		let stage = "precondition";

		try {
			this.repository.assertClean();
			repositoryWasClean = true;
			stage = "curator";
			await this.curator.curate(batch, this.repository.path, this.abortController.signal);
			stage = "changes";
			const changedPaths = this.repository.changedPaths();
			if (changedPaths.length > 0) {
				stage = "validation";
				this.repository.validateChanges(changedPaths);
				stage = "commit";
				this.repository.commit(changedPaths);
				committed = true;
			}
			stage = "queue-completion";
			this.queue.markProcessed(rowIds, new Date().toISOString());
		} catch (error) {
			if (repositoryWasClean && !committed) {
				try {
					this.repository.rollback();
				} catch (rollbackError) {
					throw new MemoryConsumerFailure(stage, batch, new AggregateError([error, rollbackError], "Batch and rollback failed"));
				}
			}
			throw new MemoryConsumerFailure(stage, batch, error);
		}
	}

	private excludedCwds(): ReadonlySet<string> {
		const now = Date.now();
		return new Set(
			[...this.retries.entries()]
				.filter(([, state]) => state.retryAt === null || state.retryAt > now)
				.map(([cwd]) => cwd),
		);
	}

	private recordBatchFailure(cwd: string): BatchRetryState {
		const failures = (this.retries.get(cwd)?.failures ?? 0) + 1;
		const delay = BATCH_RETRY_DELAYS_MS[failures - 1];
		const state = { failures, retryAt: delay === undefined ? null : Date.now() + delay };
		this.retries.set(cwd, state);
		this.scheduleNextBatchRetry();
		return state;
	}

	private scheduleNextBatchRetry(): void {
		const retryTimes = [...this.retries.values()]
			.map((state) => state.retryAt)
			.filter((retryAt): retryAt is number => retryAt !== null);
		if (retryTimes.length === 0) {
			return;
		}
		this.scheduleWake(Math.max(0, Math.min(...retryTimes) - Date.now()));
	}

	private scheduleWake(delayMs: number): void {
		if (this.closed) {
			return;
		}
		const wakeAt = Date.now() + delayMs;
		if (this.retryTimer && this.retryWakeAt !== null && this.retryWakeAt <= wakeAt) {
			return;
		}
		this.clearRetryTimer();
		this.retryWakeAt = wakeAt;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.retryWakeAt = null;
			this.wake();
		}, delayMs);
	}

	private clearRetryTimer(): void {
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
		}
		this.retryTimer = null;
		this.retryWakeAt = null;
	}
}

export function buildBoundedBatch(pending: PendingMemoryBatch): CuratorBatch {
	const rows: PendingMemoryBatch["rows"] = [];
	for (const row of pending.rows) {
		const candidate = [...rows, row];
		const bytes = Buffer.byteLength(
			JSON.stringify(candidate.map((item) => ({
				supportedBy: item.supportedBy,
				collectionPath: item.collectionPath,
				fact: item.fact,
				observedAt: item.createdAt,
			}))),
			"utf8",
		);
		if (bytes > MEMORY_BATCH_MAX_BYTES) {
			if (rows.length === 0) {
				throw new Error(`Queue row ${row.id} exceeds the Memory batch size limit`);
			}
			break;
		}
		rows.push(row);
	}
	if (rows.length === 0) {
		throw new Error("Memory batch must contain at least one row");
	}
	return { cwd: pending.cwd, rows };
}

class MemoryConsumerFailure extends Error {
	constructor(
		readonly stage: string,
		readonly batch: CuratorBatch,
		cause: unknown,
	) {
		super(`Memory batch failed during ${stage}`, { cause });
	}
}

function logConsumerFailure(writer: MemoryErrorWriter, error: unknown, retry?: BatchRetryState): void {
	if (error instanceof MemoryConsumerFailure) {
		recordMemoryError(writer, {
			component: "memory",
			stage: error.stage,
			pi_session_id: error.batch.rows[0]?.piSessionId,
			cwd: error.batch.cwd,
			queue_row_ids: error.batch.rows.map((row) => row.id.toString()),
			...(retry
				? {
					retry_attempt: retry.failures,
					retry_at: retry.retryAt === null ? null : new Date(retry.retryAt).toISOString(),
					blocked: retry.retryAt === null,
				}
				: {}),
			error: formatError(error.cause),
		});
		return;
	}
	recordMemoryError(writer, {
		component: "memory",
		stage: "consumer",
		error: formatError(error),
	});
}

function isMemoryConsumerAbort(error: unknown): error is MemoryConsumerFailure & { cause: DOMException } {
	return error instanceof MemoryConsumerFailure && isAbortError(error.cause);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): error is DOMException {
	return error instanceof DOMException && error.name === "AbortError";
}
