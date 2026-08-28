import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WorkflowModelClient } from "../model/client.ts";
import { getPiInvocation } from "../pi/invocation.ts";
import { createMemoryConfig, type MemoryRoutingContext } from "./config.ts";
import { MemoryExtractor, toExtractionExchange } from "./extractor.ts";
import type { ExtractableMemoryExchange, ExtractedMemoryFact, NewMemoryExchange } from "./queue.ts";
import type { MemoryExtractionWork } from "./worker-protocol.ts";
import { MemoryWorkerClient } from "./worker-client.ts";

interface CapturedUserMessage extends NewMemoryExchange {
	content: string;
}

interface MemoryFactExtractor {
	extract(
		exchange: ReturnType<typeof toExtractionExchange>,
		routing: MemoryRoutingContext,
		signal: AbortSignal,
	): Promise<ExtractedMemoryFact[]>;
}

interface MemoryExchangeStore {
	captureUser(exchange: NewMemoryExchange, content: string): Promise<void>;
	captureAgent(content: string, createdAt: string): Promise<void>;
	settleActiveExchange(settledAt: string): Promise<boolean>;
	nextExtraction(): Promise<MemoryExtractionWork | null>;
	completeExtraction(
		exchange: ExtractableMemoryExchange,
		facts: readonly ExtractedMemoryFact[],
		extractedAt: string,
	): Promise<bigint[]>;
	logError(entry: Record<string, unknown>): Promise<void>;
	close(): Promise<void>;
}

export class MemoryCaptureRuntime {
	private readonly abortController = new AbortController();
	private flight: Promise<void> | null = null;
	private wakeRequested = false;
	private accepting = true;
	private failed = false;

	constructor(
		private readonly extractor: MemoryFactExtractor,
		private readonly store: MemoryExchangeStore,
	) {}

	async captureUserMessage(message: CapturedUserMessage): Promise<void> {
		if (!this.accepting) return;
		try {
			await this.store.captureUser(message, message.content);
		} catch (error) {
			await logCaptureFailure(this.store, "capture-user", error, message);
		}
	}

	async captureAgentResponse(content: string, createdAt: string): Promise<void> {
		if (!this.accepting) return;
		try {
			await this.store.captureAgent(content, createdAt);
		} catch (error) {
			await logCaptureFailure(this.store, "capture-agent", error);
		}
	}

	async settleActiveExchange(settledAt: string): Promise<void> {
		try {
			if (await this.store.settleActiveExchange(settledAt)) this.wake();
		} catch (error) {
			await logCaptureFailure(this.store, "settle-exchange", error);
		}
	}

	wake(): void {
		if (!this.accepting || this.failed) return;
		this.wakeRequested = true;
		if (this.flight) return;

		const flight = this.run();
		this.flight = flight;
		void flight.finally(() => {
			if (this.flight !== flight) return;
			this.flight = null;
			if (this.wakeRequested && this.accepting && !this.failed) this.wake();
		});
	}

	async close(): Promise<void> {
		if (!this.accepting) return;
		await this.settleActiveExchange(new Date().toISOString());
		this.accepting = false;
		this.abortController.abort();
		await this.flight;
		await this.store.close();
	}

	private async run(): Promise<void> {
		try {
			do {
				this.wakeRequested = false;
				await this.drainUnextractedExchanges();
			} while (this.wakeRequested && this.accepting);
		} catch (error) {
			if (!this.accepting && isAbortError(error)) return;
			this.failed = true;
			await recordMemoryFailure(this.store, {
				component: "memory",
				stage: "extract-exchange",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async drainUnextractedExchanges(): Promise<void> {
		while (this.accepting) {
			const work = await this.store.nextExtraction();
			if (!work || !this.accepting) return;
			const facts = await this.extractor.extract(
				toExtractionExchange(work.exchange),
				work.routing,
				this.abortController.signal,
			);
			await this.store.completeExtraction(work.exchange, facts, new Date().toISOString());
		}
	}
}

export function registerMemory(pi: ExtensionAPI): void {
	let runtime: MemoryCaptureRuntime | undefined;

	pi.on("session_start", (_event, ctx) => {
		try {
			const config = createMemoryConfig();
			const worker = new MemoryWorkerClient({
				...config,
				piSessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				piInvocation: getPiInvocation([]),
			});
			runtime = new MemoryCaptureRuntime(
				new MemoryExtractor(new WorkflowModelClient(ctx.modelRegistry)),
				worker,
			);
			runtime.wake();
		} catch {
			runtime = undefined;
		}
	});

	pi.on("message_end", async (event, ctx) => {
		const content = getConversationMessageText(event.message);
		if (content.length === 0) return;
		const createdAt = new Date(event.message.timestamp).toISOString();
		if (event.message.role === "user") {
			await runtime?.captureUserMessage({
				piSessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				content,
				startedAt: createdAt,
			});
			return;
		}
		if (event.message.role === "assistant" && event.message.stopReason === "stop") {
			await runtime?.captureAgentResponse(content, createdAt);
		}
	});

	pi.on("agent_settled", async () => {
		await runtime?.settleActiveExchange(new Date().toISOString());
	});

	pi.on("session_shutdown", async () => {
		const activeRuntime = runtime;
		runtime = undefined;
		await activeRuntime?.close();
	});
}

export function getConversationMessageText(message: AgentEndEvent["messages"][number]): string {
	if (message.role !== "user" && message.role !== "assistant") return "";
	if (typeof message.content === "string") return message.content.trim();
	return message.content
		.filter((part) => part.type === "text" && part.text.trim().length > 0)
		.map((part) => part.type === "text" ? part.text.trim() : "")
		.join("\n\n");
}

async function logCaptureFailure(
	store: Pick<MemoryExchangeStore, "logError">,
	stage: "capture-user" | "capture-agent" | "settle-exchange",
	error: unknown,
	exchange?: Pick<NewMemoryExchange, "piSessionId" | "cwd">,
): Promise<void> {
	await recordMemoryFailure(store, {
		component: "memory",
		stage,
		...(exchange ? { pi_session_id: exchange.piSessionId, cwd: exchange.cwd } : {}),
		error: error instanceof Error ? error.message : String(error),
	});
}

async function recordMemoryFailure(
	store: Pick<MemoryExchangeStore, "logError">,
	entry: Record<string, unknown>,
): Promise<void> {
	try {
		await store.logError(entry);
	} catch {
		// Memory logging must not interrupt the main Pi session.
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}
