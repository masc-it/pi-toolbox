import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WorkflowModelClient } from "../model/client.ts";
import { createMemoryConfig, type MemorySender, type MemoryTopic } from "./config.ts";
import { MemoryExtractor } from "./extractor.ts";
import { recordMemoryError, type MemoryErrorWriter } from "./log.ts";
import {
	MemoryQueue,
	type ExtractedMemoryFact,
	type NewMemoryMessage,
	type StoredMemoryMessage,
} from "./queue.ts";

export const MEMORY_QUEUE_WAKE_EVENT = "pi-toolbox:memory-queue-wake";

interface MemoryFactExtractor {
	extract(event: Pick<NewMemoryMessage, "cwd" | "sentBy" | "content">, signal: AbortSignal): Promise<
		Array<{ topic: MemoryTopic; fact: string }>
	>;
}

interface MemoryQueueWriter extends MemoryErrorWriter {
	storeMessage(message: NewMemoryMessage): StoredMemoryMessage;
	enqueueFacts(message: StoredMemoryMessage, facts: readonly ExtractedMemoryFact[]): bigint[];
	close(): void;
}

export class MemoryCaptureRuntime {
	private readonly tasks = new Set<Promise<void>>();
	private readonly abortController = new AbortController();
	private closed = false;

	constructor(
		private readonly extractor: MemoryFactExtractor,
		private readonly queue: MemoryQueueWriter,
		private readonly wakeConsumer: () => void,
	) {}

	schedule(event: NewMemoryMessage): void {
		if (this.closed) {
			throw new Error("Memory capture runtime is closed");
		}

		let message: StoredMemoryMessage;
		try {
			message = this.queue.storeMessage(event);
		} catch (error) {
			logMemoryFailure(this.queue, event, "store-message", error);
			return;
		}

		const task = this.extractAndQueue(message).catch((error: unknown) => {
			logMemoryFailure(this.queue, message, "capture", error, message.id);
		});
		this.tasks.add(task);
		void task.finally(() => this.tasks.delete(task));
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.all(this.tasks);
		this.abortController.abort();
		this.queue.close();
	}

	private async extractAndQueue(message: StoredMemoryMessage): Promise<void> {
		let facts: ExtractedMemoryFact[];
		try {
			facts = await this.extractor.extract(message, this.abortController.signal);
		} catch (error) {
			logMemoryFailure(this.queue, message, "extract", error, message.id);
			return;
		}
		if (facts.length === 0) {
			return;
		}

		try {
			this.queue.enqueueFacts(message, facts);
		} catch (error) {
			logMemoryFailure(this.queue, message, "queue-facts", error, message.id);
			return;
		}
		this.wakeConsumer();
	}
}

export function registerMemoryCapture(pi: ExtensionAPI): void {
	let runtime: MemoryCaptureRuntime | undefined;

	pi.on("session_start", (_event, ctx) => {
		const config = createMemoryConfig();
		let queue: MemoryQueue | undefined;
		try {
			queue = new MemoryQueue(config.databasePath);
			const extractor = new MemoryExtractor(new WorkflowModelClient(ctx.modelRegistry));
			runtime = new MemoryCaptureRuntime(
				extractor,
				queue,
				() => pi.events.emit(MEMORY_QUEUE_WAKE_EVENT, undefined),
			);
			pi.events.emit(MEMORY_QUEUE_WAKE_EVENT, undefined);
		} catch (error) {
			runtime = undefined;
			if (queue) {
				logMemoryFailure(
					queue,
					createCapturedMessage(ctx.sessionManager.getSessionId(), ctx.cwd, "agent", "Memory startup"),
					"start",
					error,
				);
				queue.close();
			}
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		runtime?.schedule(createCapturedMessage(ctx.sessionManager.getSessionId(), ctx.cwd, "user", event.prompt));
	});

	pi.on("agent_end", (event, ctx) => {
		const content = getAgentEventText(event.messages);
		if (content.length > 0) {
			runtime?.schedule(createCapturedMessage(ctx.sessionManager.getSessionId(), ctx.cwd, "agent", content));
		}
	});

	pi.on("session_shutdown", async () => {
		const activeRuntime = runtime;
		runtime = undefined;
		await activeRuntime?.close();
	});
}

export function getAgentEventText(messages: AgentEndEvent["messages"]): string {
	const text: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") {
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text" && part.text.trim().length > 0) {
				text.push(part.text.trim());
			}
		}
	}
	return text.join("\n\n");
}

function createCapturedMessage(
	piSessionId: string,
	cwd: string,
	sentBy: MemorySender,
	content: string,
): NewMemoryMessage {
	return {
		piSessionId,
		cwd,
		sentBy,
		content,
		createdAt: new Date().toISOString(),
	};
}

function logMemoryFailure(
	writer: MemoryErrorWriter,
	message: NewMemoryMessage,
	stage: "start" | "store-message" | "extract" | "queue-facts" | "capture",
	error: unknown,
	messageId?: bigint,
): void {
	recordMemoryError(writer, {
		component: "memory",
		stage,
		pi_session_id: message.piSessionId,
		cwd: message.cwd,
		sent_by: message.sentBy,
		...(messageId === undefined ? {} : { message_id: messageId.toString() }),
		error: error instanceof Error ? error.message : String(error),
	});
}
