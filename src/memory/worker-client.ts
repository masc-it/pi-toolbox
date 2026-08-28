import { MessageChannel, Worker } from "node:worker_threads";
import type { MemoryRoutingContext } from "./config.ts";
import type {
	ExtractableMemoryExchange,
	ExtractedMemoryFact,
	NewMemoryExchange,
} from "./queue.ts";
import type {
	MemoryExtractionWork,
	MemoryWorkerConfig,
	MemoryWorkerMethod,
	MemoryWorkerParams,
	MemoryWorkerResponse,
	MemoryWorkerResult,
	MemoryWorkerStartupMessage,
} from "./worker-protocol.ts";

const REQUEST_TIMEOUT_MS = 30_000;

export class MemoryWorkerClient {
	private readonly worker: Worker;
	private readonly startup: Promise<void>;
	private readonly exit: Promise<number>;
	private started = false;
	private closing = false;
	private closed = false;
	private terminalError: Error | null = null;
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
		this.worker.on("message", (message: unknown) => this.handleStartupMessage(message));
		this.worker.on("error", (error) => this.fail(error));
		this.worker.on("exit", (code) => {
			this.closed = true;
			if (!this.started || !this.closing) {
				this.fail(new Error(code === 0 ? "Memory worker exited unexpectedly" : `Memory worker exited with code ${code}`));
			}
		});
	}

	async captureUser(exchange: NewMemoryExchange, content: string): Promise<void> {
		await this.request("capture-user", { exchange, content });
	}

	async captureAgent(content: string, createdAt: string): Promise<void> {
		await this.request("capture-agent", { content, createdAt });
	}

	settleActiveExchange(settledAt: string): Promise<boolean> {
		return this.request("settle-active-exchange", { settledAt });
	}

	nextExtraction(): Promise<MemoryExtractionWork | null> {
		return this.request("next-extraction", null);
	}

	completeExtraction(
		exchange: ExtractableMemoryExchange,
		facts: readonly ExtractedMemoryFact[],
		extractedAt: string,
	): Promise<bigint[]> {
		return this.request("complete-extraction", { exchange, facts: [...facts], extractedAt });
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
		this.assertAvailable();
		await this.startup;
		this.assertAvailable();
		return this.sendRequest(method, params);
	}

	private sendRequest<M extends MemoryWorkerMethod>(
		method: M,
		params: MemoryWorkerParams<M>,
	): Promise<MemoryWorkerResult<M>> {
		this.assertAvailableForSend();
		const { port1, port2 } = new MessageChannel();

		return new Promise<MemoryWorkerResult<M>>((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				port1.removeAllListeners();
				port1.close();
				callback();
			};
			const timeout = setTimeout(() => {
				const error = new Error(`Memory worker request timed out: ${method}`);
				finish(() => reject(error));
				this.fail(error);
				void this.worker.terminate();
			}, REQUEST_TIMEOUT_MS);

			port1.once("message", (message: unknown) => {
				if (!isMemoryWorkerResponse(message)) {
					finish(() => reject(new Error("Memory worker returned an invalid response")));
					return;
				}
				if (message.ok) {
					finish(() => resolve(message.result as MemoryWorkerResult<M>));
				} else {
					finish(() => reject(new Error(message.error)));
				}
			});
			port1.once("close", () => {
				finish(() => reject(this.terminalError ?? new Error("Memory worker closed before replying")));
			});

			try {
				this.worker.postMessage({ method, params, replyPort: port2 }, [port2]);
			} catch (error) {
				finish(() => reject(error instanceof Error ? error : new Error(String(error))));
			}
		});
	}

	private async closeWorker(): Promise<void> {
		let shutdownSucceeded = false;
		try {
			if (this.terminalError || this.closed) return;
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
		}
	}

	private handleStartupMessage(message: unknown): void {
		if (!isMemoryWorkerStartupMessage(message)) {
			this.fail(new Error("Memory worker returned an invalid startup message"));
			return;
		}
		if (message.type === "ready") {
			this.started = true;
			this.resolveStartup();
			return;
		}
		this.fail(new Error(message.error));
	}

	private fail(error: Error): void {
		if (!this.terminalError) this.terminalError = error;
		this.closed = true;
		this.rejectStartup(this.terminalError);
	}

	private assertAvailable(): void {
		if (this.terminalError) throw this.terminalError;
		if (this.closing || this.closed) throw new Error("Memory worker is closed");
	}

	private assertAvailableForSend(): void {
		if (this.terminalError) throw this.terminalError;
		if (this.closed) throw new Error("Memory worker is closed");
	}
}

function isMemoryWorkerStartupMessage(value: unknown): value is MemoryWorkerStartupMessage {
	return isRecord(value) && (
		value.type === "ready" ||
		(value.type === "startup-error" && typeof value.error === "string")
	);
}

function isMemoryWorkerResponse(value: unknown): value is MemoryWorkerResponse {
	if (!isRecord(value) || typeof value.ok !== "boolean") return false;
	return value.ok ? "result" in value : typeof value.error === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
