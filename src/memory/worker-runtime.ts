import { MessagePort, parentPort, workerData } from "node:worker_threads";
import { resolveMemoryRoutingContext } from "./collections.ts";
import { MemoryConsumer } from "./consumer.ts";
import { MemoryCurator } from "./curator.ts";
import { recordMemoryError } from "./log.ts";
import { MemoryQueue, type OpenMemoryExchange } from "./queue.ts";
import { MemoryRepository } from "./repository.ts";
import type {
	MemoryWorkerConfig,
	MemoryWorkerRequest,
	MemoryWorkerResponse,
	MemoryWorkerStartupMessage,
} from "./worker-protocol.ts";

class MemoryWorkerRuntime {
	private readonly queue: MemoryQueue;
	private readonly consumer: MemoryConsumer | null;
	private activeExchange: OpenMemoryExchange | null = null;
	private closed = false;

	constructor(private readonly config: MemoryWorkerConfig) {
		this.queue = new MemoryQueue(config.databasePath);

		let consumer: MemoryConsumer | null = null;
		try {
			const repository = new MemoryRepository(config.knowledgeBaseDirectory);
			consumer = new MemoryConsumer(
				this.queue,
				new MemoryCurator((args) => ({
					command: config.piInvocation.command,
					args: [...config.piInvocation.args, ...args],
				})),
				repository,
				`${config.databasePath}.lock`,
			);
			consumer.wake();
		} catch (error) {
			recordMemoryError(this.queue, {
				component: "memory",
				stage: "consumer-start",
				pi_session_id: config.piSessionId,
				cwd: config.cwd,
				error: formatError(error),
			});
		}
		this.consumer = consumer;
	}

	handle(request: MemoryWorkerRequest): unknown | Promise<unknown> {
		this.assertOpen();
		switch (request.method) {
			case "capture-user":
				return this.captureUser(request.params.exchange, request.params.content);
			case "capture-agent":
				return this.captureAgent(request.params.content, request.params.createdAt);
			case "settle-active-exchange":
				return this.settleActiveExchange(request.params.settledAt);
			case "next-extraction":
				return this.nextExtraction();
			case "complete-extraction": {
				const { exchange, facts, extractedAt } = request.params;
				const ids = this.queue.completeExtraction(exchange, facts, extractedAt);
				if (ids.length > 0) this.consumer?.wake();
				return ids;
			}
			case "log-error":
				recordMemoryError(this.queue, request.params);
				return null;
			case "shutdown":
				return this.close();
		}
	}

	private captureUser(exchange: Parameters<MemoryQueue["startExchange"]>[0], content: string): null {
		if (!this.activeExchange) {
			this.activeExchange = this.queue.startExchange(exchange, content);
		} else {
			this.queue.appendMessage(this.activeExchange.id, "user", content, exchange.startedAt);
		}
		return null;
	}

	private captureAgent(content: string, createdAt: string): null {
		if (this.activeExchange) {
			this.queue.appendMessage(this.activeExchange.id, "agent", content, createdAt);
		}
		return null;
	}

	private settleActiveExchange(settledAt: string): boolean {
		if (!this.activeExchange) return false;
		this.queue.settleExchange(this.activeExchange.id, settledAt);
		this.activeExchange = null;
		return true;
	}

	private nextExtraction() {
		const exchange = this.queue.nextUnextractedExchange();
		if (!exchange) return null;
		return {
			exchange,
			routing: resolveMemoryRoutingContext(this.config.knowledgeBaseDirectory, exchange.cwd),
		};
	}

	private async close(): Promise<null> {
		if (this.closed) return null;
		this.closed = true;
		if (this.consumer) {
			await this.consumer.close();
		} else {
			this.queue.close();
		}
		return null;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Memory worker runtime is closed");
	}
}

const port = requireParentPort(parentPort);

let runtime: MemoryWorkerRuntime;
try {
	runtime = new MemoryWorkerRuntime(validateWorkerConfig(workerData));
	postStartup({ type: "ready" });
} catch (error) {
	postStartup({ type: "startup-error", error: formatError(error) });
	port.close();
	throw error;
}

let requestChain = Promise.resolve();
port.on("message", (value: unknown) => {
	requestChain = requestChain.then(() => handleRequest(value));
});

async function handleRequest(value: unknown): Promise<void> {
	if (!isMemoryWorkerRequest(value)) return;
	const { replyPort } = value;
	try {
		const result = await runtime.handle(value);
		postResponse(replyPort, { ok: true, result });
		if (value.method === "shutdown") port.close();
	} catch (error) {
		postResponse(replyPort, { ok: false, error: formatError(error) });
	} finally {
		replyPort.close();
	}
}

function postStartup(message: MemoryWorkerStartupMessage): void {
	port.postMessage(message);
}

function postResponse(replyPort: MessagePort, message: MemoryWorkerResponse): void {
	replyPort.postMessage(message);
}

function requireParentPort(value: typeof parentPort): NonNullable<typeof parentPort> {
	if (!value) throw new Error("Memory worker requires a parent port");
	return value;
}

function validateWorkerConfig(value: unknown): MemoryWorkerConfig {
	if (!isRecord(value)) throw new Error("Memory worker configuration must be an object");
	const dataDirectory = requireNonEmptyString(value.dataDirectory, "dataDirectory");
	const databasePath = requireNonEmptyString(value.databasePath, "databasePath");
	const knowledgeBaseDirectory = requireNonEmptyString(value.knowledgeBaseDirectory, "knowledgeBaseDirectory");
	const piSessionId = requireNonEmptyString(value.piSessionId, "piSessionId");
	const cwd = requireNonEmptyString(value.cwd, "cwd");
	const piInvocation = validatePiInvocation(value.piInvocation);
	return { dataDirectory, databasePath, knowledgeBaseDirectory, piSessionId, cwd, piInvocation };
}

function validatePiInvocation(value: unknown): MemoryWorkerConfig["piInvocation"] {
	if (!isRecord(value)) throw new Error("Memory worker configuration has an invalid piInvocation");
	const command = requireNonEmptyString(value.command, "piInvocation.command");
	if (!Array.isArray(value.args) || value.args.some((argument) => typeof argument !== "string")) {
		throw new Error("Memory worker configuration has invalid piInvocation.args");
	}
	return { command, args: [...value.args] };
}

function requireNonEmptyString(value: unknown, key: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Memory worker configuration has an invalid ${key}`);
	}
	return value;
}

function isMemoryWorkerRequest(value: unknown): value is MemoryWorkerRequest {
	return (
		isRecord(value) &&
		typeof value.method === "string" &&
		[
			"capture-user",
			"capture-agent",
			"settle-active-exchange",
			"next-extraction",
			"complete-extraction",
			"log-error",
			"shutdown",
		].includes(value.method) &&
		"params" in value &&
		value.replyPort instanceof MessagePort
	);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
