import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMemoryConfig, MEMORY_BATCH_MAX_BYTES } from "./config.ts";
import { MEMORY_QUEUE_WAKE_EVENT } from "./capture.ts";
import { MemoryCurator, type CuratorBatch } from "./curator.ts";
import { acquireMemoryLock } from "./lock.ts";
import { recordMemoryError, type MemoryErrorWriter } from "./log.ts";
import { MemoryQueue, type PendingMemoryBatch } from "./queue.ts";
import { MemoryRepository } from "./repository.ts";

interface ConsumerQueue extends MemoryErrorWriter {
	nextPendingBatch(): PendingMemoryBatch | null;
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

type LockAcquirer = typeof acquireMemoryLock;

export class MemoryConsumer {
	private readonly abortController = new AbortController();
	private flight: Promise<void> | null = null;
	private wakeRequested = false;
	private closed = false;
	private failed = false;

	constructor(
		private readonly queue: ConsumerQueue,
		private readonly curator: ConsumerCurator,
		private readonly repository: ConsumerRepository,
		private readonly lockPath: string,
		private readonly acquireLock: LockAcquirer = acquireMemoryLock,
	) {}

	wake(): void {
		if (this.closed || this.failed) {
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
			if (this.wakeRequested && !this.closed && !this.failed) {
				this.wake();
			}
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		this.abortController.abort();
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
			this.failed = true;
			logConsumerFailure(this.queue, error);
		}
	}

	private async drainQueue(): Promise<void> {
		const lock = await this.acquireLock(this.lockPath, this.abortController.signal);
		try {
			while (!this.closed) {
				const pending = this.queue.nextPendingBatch();
				if (!pending) {
					return;
				}
				await this.processBatch(buildBoundedBatch(pending));
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
}

export function buildBoundedBatch(pending: PendingMemoryBatch): CuratorBatch {
	const rows: PendingMemoryBatch["rows"] = [];
	for (const row of pending.rows) {
		const candidate = [...rows, row];
		const bytes = Buffer.byteLength(
			JSON.stringify(candidate.map((item) => ({
				supportedBy: item.supportedBy,
				topic: item.topic,
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

export function registerMemoryConsumer(pi: ExtensionAPI): void {
	let consumer: MemoryConsumer | undefined;
	let unsubscribeWake: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		const config = createMemoryConfig();
		let queue: MemoryQueue | undefined;
		try {
			queue = new MemoryQueue(config.databasePath);
			const repository = new MemoryRepository(config.knowledgeBaseDirectory);
			consumer = new MemoryConsumer(
				queue,
				new MemoryCurator(),
				repository,
				`${config.databasePath}.lock`,
			);
			unsubscribeWake = pi.events.on(MEMORY_QUEUE_WAKE_EVENT, () => consumer?.wake());
			consumer.wake();
		} catch (error) {
			unsubscribeWake?.();
			unsubscribeWake = undefined;
			consumer = undefined;
			if (queue) {
				recordMemoryError(queue, {
					component: "memory",
					stage: "consumer-start",
					pi_session_id: ctx.sessionManager.getSessionId(),
					cwd: ctx.cwd,
					error: error instanceof Error ? error.message : String(error),
				});
				queue.close();
			}
		}
	});

	pi.on("session_shutdown", async () => {
		unsubscribeWake?.();
		unsubscribeWake = undefined;
		const activeConsumer = consumer;
		consumer = undefined;
		await activeConsumer?.close();
	});
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

function logConsumerFailure(writer: MemoryErrorWriter, error: unknown): void {
	if (error instanceof MemoryConsumerFailure) {
		recordMemoryError(writer, {
			component: "memory",
			stage: error.stage,
			pi_session_id: error.batch.rows[0]?.piSessionId,
			cwd: error.batch.cwd,
			queue_row_ids: error.batch.rows.map((row) => row.id.toString()),
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

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}
