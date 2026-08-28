import { Worker } from "node:worker_threads";
import type { MemorySender } from "./config.ts";
import type {
	ExtractableMemoryExchange,
	ExtractedMemoryFact,
	NewMemoryExchange,
	OpenMemoryExchange,
} from "./queue.ts";
import type {
	MemoryWorkerConfig,
	MemoryWorkerMethod,
	MemoryWorkerParams,
	MemoryWorkerRequest,
	MemoryWorkerResponse,
	MemoryWorkerResult,
} from "./worker-protocol.ts";

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

export class MemoryWorkerClient {
	private readonly worker: Worker;
	private readonly startup: Promise<void>;
	private readonly exit: Promise<number>;
	private readonly pending = new Map<number, PendingRequest>();
	private nextRequestId = 1;
	private started = false;
	private closing = false;
	private closed = false;
	private closePromise: Promise<void> | null = null;
	private resolveStartup!: () => void;
	private rejectStartup!: (error: Error) => void;

	constructor(config: MemoryWorkerConfig) {
		this.startup = new Promise<void>((resolve, reject) => {
			this.resolveStartup = resolve;
			this.rejectStartup = reject;
		});
		void this.startup.catch(() => undefined);

		this.worker = new Worker(new URL("./worker-entry.mjs", import.meta.url), { workerData: config });
		this.exit = new Promise<number>((resolve) => this.worker.once("exit", resolve));
		this.worker.on("message", (message: unknown) => this.handleMessage(message));
		this.worker.on("error", (error) => this.fail(error));
		this.worker.on("exit", (code) => {
			if (!this.started || !this.closing) {
				this.fail(new Error(code === 0 ? "Memory worker exited unexpectedly" : `Memory worker exited with code ${code}`));
			}
		});
	}

	startExchange(exchange: NewMemoryExchange, userContent: string): Promise<OpenMemoryExchange> {
		return this.request("start-exchange", { exchange, userContent });
	}

	async appendMessage(
		exchangeId: bigint,
		sentBy: MemorySender,
		content: string,
		createdAt: string,
	): Promise<void> {
		await this.request("append-message", { exchangeId, sentBy, content, createdAt });
	}

	async settleExchange(exchangeId: bigint, settledAt: string): Promise<void> {
		await this.request("settle-exchange", { exchangeId, settledAt });
	}

	nextUnextractedExchange(): Promise<ExtractableMemoryExchange | null> {
		return this.request("next-unextracted-exchange", null);
	}

	completeExtraction(
		exchange: ExtractableMemoryExchange,
		facts: readonly ExtractedMemoryFact[],
		extractedAt: string,
	): Promise<bigint[]> {
		return this.request("complete-extraction", { exchange, facts: [...facts], extractedAt });
	}

	listTopics(): Promise<string[]> {
		return this.request("list-topics", null);
	}

	async logError(entry: Record<string, unknown>): Promise<void> {
		await this.request("log-error", entry);
	}

	close(): Promise<void> {
		if (!this.closePromise) {
			this.closing = true;
			this.closePromise = this.closeWorker();
		}
		return this.closePromise;
	}

	private async request<M extends MemoryWorkerMethod>(
		method: M,
		params: MemoryWorkerParams<M>,
	): Promise<MemoryWorkerResult<M>> {
		if (this.closing || this.closed) {
			throw new Error("Memory worker is closed");
		}
		await this.startup;
		if (this.closing || this.closed) {
			throw new Error("Memory worker is closed");
		}
		return this.sendRequest(method, params);
	}

	private sendRequest<M extends MemoryWorkerMethod>(
		method: M,
		params: MemoryWorkerParams<M>,
	): Promise<MemoryWorkerResult<M>> {
		const id = this.nextRequestId++;
		const request = { type: "request", id, method, params } as MemoryWorkerRequest;
		return new Promise<MemoryWorkerResult<M>>((resolve, reject) => {
			this.pending.set(id, {
				resolve: (value) => resolve(value as MemoryWorkerResult<M>),
				reject,
			});
			try {
				this.worker.postMessage(request);
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private async closeWorker(): Promise<void> {
		let shutdownSucceeded = false;
		try {
			await this.startup;
			await this.sendRequest("shutdown", null);
			shutdownSucceeded = true;
		} catch {
			// Memory shutdown must not interrupt the main Pi session.
		} finally {
			this.closed = true;
			if (shutdownSucceeded) {
				await this.exit;
			} else {
				await this.worker.terminate();
			}
			this.rejectPending(new Error("Memory worker is closed"));
		}
	}

	private handleMessage(message: unknown): void {
		if (!isMemoryWorkerResponse(message)) {
			this.fail(new Error("Memory worker returned an invalid response"));
			return;
		}
		if (message.type === "ready") {
			this.started = true;
			this.resolveStartup();
			return;
		}
		if (message.type === "startup-error") {
			this.fail(new Error(message.error));
			return;
		}

		const pending = this.pending.get(message.id);
		if (!pending) {
			return;
		}
		this.pending.delete(message.id);
		if (message.ok) {
			pending.resolve(message.result);
		} else {
			pending.reject(new Error(message.error));
		}
	}

	private fail(error: Error): void {
		this.rejectStartup(error);
		this.rejectPending(error);
	}

	private rejectPending(error: Error): void {
		for (const request of this.pending.values()) {
			request.reject(error);
		}
		this.pending.clear();
	}
}

function isMemoryWorkerResponse(value: unknown): value is MemoryWorkerResponse {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}
	if (value.type === "ready") {
		return true;
	}
	if (value.type === "startup-error") {
		return typeof value.error === "string";
	}
	if (value.type !== "response" || typeof value.id !== "number" || typeof value.ok !== "boolean") {
		return false;
	}
	return value.ok ? "result" in value : typeof value.error === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
