import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WorkflowModelClient } from "../model/client.ts";
import { createMemoryConfig } from "./config.ts";
import { listMemoryTopics, MemoryExtractor, toExtractionExchange } from "./extractor.ts";
import { recordMemoryError, type MemoryErrorWriter } from "./log.ts";
import {
	MemoryQueue,
	type ExtractableMemoryExchange,
	type ExtractedMemoryFact,
	type NewMemoryExchange,
	type OpenMemoryExchange,
} from "./queue.ts";

export const MEMORY_QUEUE_WAKE_EVENT = "pi-toolbox:memory-queue-wake";

interface CapturedUserMessage extends NewMemoryExchange {
	content: string;
}

interface MemoryFactExtractor {
	extract(exchange: ReturnType<typeof toExtractionExchange>, signal: AbortSignal): Promise<ExtractedMemoryFact[]>;
}

interface MemoryExchangeStore extends MemoryErrorWriter {
	startExchange(exchange: NewMemoryExchange, userContent: string): OpenMemoryExchange;
	appendMessage(exchangeId: bigint, sentBy: "user" | "agent", content: string, createdAt: string): unknown;
	settleExchange(exchangeId: bigint, settledAt: string): void;
	nextUnextractedExchange(): ExtractableMemoryExchange | null;
	completeExtraction(
		exchange: ExtractableMemoryExchange,
		facts: readonly ExtractedMemoryFact[],
		extractedAt: string,
	): bigint[];
	close(): void;
}

export class MemoryCaptureRuntime {
	private readonly abortController = new AbortController();
	private activeExchange: OpenMemoryExchange | undefined;
	private flight: Promise<void> | null = null;
	private wakeRequested = false;
	private accepting = true;
	private failed = false;

	constructor(
		private readonly extractor: MemoryFactExtractor,
		private readonly queue: MemoryExchangeStore,
		private readonly wakeConsumer: () => void,
	) {}

	captureUserMessage(message: CapturedUserMessage): void {
		if (!this.accepting) {
			throw new Error("Memory capture runtime is closed");
		}

		try {
			if (!this.activeExchange) {
				this.activeExchange = this.queue.startExchange(message, message.content);
				return;
			}
			this.queue.appendMessage(this.activeExchange.id, "user", message.content, message.startedAt);
		} catch (error) {
			logCaptureFailure(this.queue, "capture-user", message, error, this.activeExchange?.id);
		}
	}

	captureAgentResponse(content: string, createdAt: string): void {
		if (!this.accepting) {
			throw new Error("Memory capture runtime is closed");
		}
		if (!this.activeExchange) {
			return;
		}

		try {
			this.queue.appendMessage(this.activeExchange.id, "agent", content, createdAt);
		} catch (error) {
			logCaptureFailure(this.queue, "capture-agent", this.activeExchange, error, this.activeExchange.id);
		}
	}

	settleActiveExchange(settledAt: string): void {
		if (!this.activeExchange) {
			return;
		}
		const exchange = this.activeExchange;
		try {
			this.queue.settleExchange(exchange.id, settledAt);
			this.activeExchange = undefined;
			this.wake();
		} catch (error) {
			logCaptureFailure(this.queue, "settle-exchange", exchange, error, exchange.id);
		}
	}

	wake(): void {
		if (!this.accepting || this.failed) {
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
			if (this.wakeRequested && this.accepting && !this.failed) {
				this.wake();
			}
		});
	}

	async close(): Promise<void> {
		if (!this.accepting) {
			return;
		}
		this.settleActiveExchange(new Date().toISOString());
		await this.flight;
		this.accepting = false;
		this.abortController.abort();
		this.queue.close();
	}

	private async run(): Promise<void> {
		try {
			do {
				this.wakeRequested = false;
				await this.drainUnextractedExchanges();
			} while (this.wakeRequested && this.accepting);
		} catch (error) {
			this.failed = true;
			recordMemoryError(this.queue, {
				component: "memory",
				stage: "extract-exchange",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async drainUnextractedExchanges(): Promise<void> {
		while (this.accepting) {
			const exchange = this.queue.nextUnextractedExchange();
			if (!exchange) {
				return;
			}
			const facts = await this.extractor.extract(toExtractionExchange(exchange), this.abortController.signal);
			const queuedIds = this.queue.completeExtraction(exchange, facts, new Date().toISOString());
			if (queuedIds.length > 0) {
				this.wakeConsumer();
			}
		}
	}
}

export function registerMemoryCapture(pi: ExtensionAPI): void {
	let runtime: MemoryCaptureRuntime | undefined;

	pi.on("session_start", (_event, ctx) => {
		const config = createMemoryConfig();
		let queue: MemoryQueue | undefined;
		try {
			queue = new MemoryQueue(config.databasePath);
			const extractor = new MemoryExtractor(
				new WorkflowModelClient(ctx.modelRegistry),
				() => listMemoryTopics(config.knowledgeBaseDirectory),
			);
			runtime = new MemoryCaptureRuntime(
				extractor,
				queue,
				() => pi.events.emit(MEMORY_QUEUE_WAKE_EVENT, undefined),
			);
			runtime.wake();
		} catch (error) {
			runtime = undefined;
			if (queue) {
				recordMemoryError(queue, {
					component: "memory",
					stage: "capture-start",
					pi_session_id: ctx.sessionManager.getSessionId(),
					cwd: ctx.cwd,
					error: error instanceof Error ? error.message : String(error),
				});
				queue.close();
			}
		}
	});

	pi.on("message_end", (event, ctx) => {
		const content = getConversationMessageText(event.message);
		if (content.length === 0) {
			return;
		}
		const createdAt = new Date(event.message.timestamp).toISOString();
		if (event.message.role === "user") {
			runtime?.captureUserMessage({
				piSessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				content,
				startedAt: createdAt,
			});
			return;
		}
		if (event.message.role === "assistant" && event.message.stopReason === "stop") {
			runtime?.captureAgentResponse(content, createdAt);
		}
	});

	pi.on("agent_settled", () => {
		runtime?.settleActiveExchange(new Date().toISOString());
	});

	pi.on("session_shutdown", async () => {
		const activeRuntime = runtime;
		runtime = undefined;
		await activeRuntime?.close();
	});
}

export function getConversationMessageText(message: AgentEndEvent["messages"][number]): string {
	if (message.role !== "user" && message.role !== "assistant") {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content.trim();
	}
	return message.content
		.filter((part) => part.type === "text" && part.text.trim().length > 0)
		.map((part) => part.type === "text" ? part.text.trim() : "")
		.join("\n\n");
}

function logCaptureFailure(
	writer: MemoryErrorWriter,
	stage: "capture-user" | "capture-agent" | "settle-exchange",
	exchange: Pick<NewMemoryExchange, "piSessionId" | "cwd">,
	error: unknown,
	exchangeId?: bigint,
): void {
	recordMemoryError(writer, {
		component: "memory",
		stage,
		pi_session_id: exchange.piSessionId,
		cwd: exchange.cwd,
		...(exchangeId === undefined ? {} : { exchange_id: exchangeId.toString() }),
		error: error instanceof Error ? error.message : String(error),
	});
}
