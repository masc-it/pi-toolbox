import { parentPort, workerData } from "node:worker_threads";
import { MemoryConsumer } from "./consumer.ts";
import { MemoryCurator } from "./curator.ts";
import { listMemoryTopics } from "./extractor.ts";
import { recordMemoryError } from "./log.ts";
import { MemoryQueue } from "./queue.ts";
import { MemoryRepository } from "./repository.ts";
import type { MemoryWorkerConfig, MemoryWorkerRequest, MemoryWorkerResponse } from "./worker-protocol.ts";

class MemoryWorkerRuntime {
	private readonly queue: MemoryQueue;
	private readonly consumer: MemoryConsumer | null;
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

	startExchange(request: Extract<MemoryWorkerRequest, { method: "start-exchange" }>) {
		this.assertOpen();
		return this.queue.startExchange(request.params.exchange, request.params.userContent);
	}

	appendMessage(request: Extract<MemoryWorkerRequest, { method: "append-message" }>): null {
		this.assertOpen();
		const { exchangeId, sentBy, content, createdAt } = request.params;
		this.queue.appendMessage(exchangeId, sentBy, content, createdAt);
		return null;
	}

	settleExchange(request: Extract<MemoryWorkerRequest, { method: "settle-exchange" }>): null {
		this.assertOpen();
		this.queue.settleExchange(request.params.exchangeId, request.params.settledAt);
		return null;
	}

	nextUnextractedExchange() {
		this.assertOpen();
		return this.queue.nextUnextractedExchange();
	}

	completeExtraction(request: Extract<MemoryWorkerRequest, { method: "complete-extraction" }>) {
		this.assertOpen();
		const { exchange, facts, extractedAt } = request.params;
		const ids = this.queue.completeExtraction(exchange, facts, extractedAt);
		if (ids.length > 0) {
			this.consumer?.wake();
		}
		return ids;
	}

	listTopics(): string[] {
		this.assertOpen();
		return listMemoryTopics(this.config.knowledgeBaseDirectory);
	}

	logError(request: Extract<MemoryWorkerRequest, { method: "log-error" }>): null {
		this.assertOpen();
		recordMemoryError(this.queue, request.params);
		return null;
	}

	async close(): Promise<null> {
		if (this.closed) {
			return null;
		}
		this.closed = true;
		if (this.consumer) {
			await this.consumer.close();
		} else {
			this.queue.close();
		}
		return null;
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new Error("Memory worker runtime is closed");
		}
	}
}

const port = requireParentPort(parentPort);

let runtime: MemoryWorkerRuntime;
try {
	runtime = new MemoryWorkerRuntime(validateWorkerConfig(workerData));
	post({ type: "ready" });
} catch (error) {
	post({ type: "startup-error", error: formatError(error) });
	port.close();
	throw error;
}

port.on("message", (value: unknown) => {
	void handleRequest(value);
});

async function handleRequest(value: unknown): Promise<void> {
	if (!isMemoryWorkerRequest(value)) {
		return;
	}

	try {
		let result: unknown;
		switch (value.method) {
			case "start-exchange":
				result = runtime.startExchange(value);
				break;
			case "append-message":
				result = runtime.appendMessage(value);
				break;
			case "settle-exchange":
				result = runtime.settleExchange(value);
				break;
			case "next-unextracted-exchange":
				result = runtime.nextUnextractedExchange();
				break;
			case "complete-extraction":
				result = runtime.completeExtraction(value);
				break;
			case "list-topics":
				result = runtime.listTopics();
				break;
			case "log-error":
				result = runtime.logError(value);
				break;
			case "shutdown":
				result = await runtime.close();
				break;
		}
		post({ type: "response", id: value.id, ok: true, result });
		if (value.method === "shutdown") {
			port.close();
		}
	} catch (error) {
		post({ type: "response", id: value.id, ok: false, error: formatError(error) });
	}
}

function post(message: MemoryWorkerResponse): void {
	port.postMessage(message);
}

function requireParentPort(value: typeof parentPort): NonNullable<typeof parentPort> {
	if (!value) {
		throw new Error("Memory worker requires a parent port");
	}
	return value;
}

function validateWorkerConfig(value: unknown): MemoryWorkerConfig {
	if (!isRecord(value)) {
		throw new Error("Memory worker configuration must be an object");
	}
	const dataDirectory = requireNonEmptyString(value.dataDirectory, "dataDirectory");
	const databasePath = requireNonEmptyString(value.databasePath, "databasePath");
	const knowledgeBaseDirectory = requireNonEmptyString(value.knowledgeBaseDirectory, "knowledgeBaseDirectory");
	const piSessionId = requireNonEmptyString(value.piSessionId, "piSessionId");
	const cwd = requireNonEmptyString(value.cwd, "cwd");
	const piInvocation = validatePiInvocation(value.piInvocation);
	return { dataDirectory, databasePath, knowledgeBaseDirectory, piSessionId, cwd, piInvocation };
}

function validatePiInvocation(value: unknown): MemoryWorkerConfig["piInvocation"] {
	if (!isRecord(value)) {
		throw new Error("Memory worker configuration has an invalid piInvocation");
	}
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
		value.type === "request" &&
		typeof value.id === "number" &&
		Number.isSafeInteger(value.id) &&
		value.id > 0 &&
		typeof value.method === "string" &&
		[
			"start-exchange",
			"append-message",
			"settle-exchange",
			"next-unextracted-exchange",
			"complete-extraction",
			"list-topics",
			"log-error",
			"shutdown",
		].includes(value.method) &&
		"params" in value
	);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
