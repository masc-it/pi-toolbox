import type { PiInvocation } from "../../pi/invocation.ts";
import { resolveMemoryRoutingContext } from "../collections.ts";
import { recordMemoryError } from "../log.ts";
import {
	MEMORY_PROTOCOL_VERSION,
	parseMemoryConsumerWake,
	type MemoryConsumerMessage,
} from "../protocol/messages.ts";
import { MemoryQueue, type ExtractableMemoryExchange, type ExtractedMemoryFact } from "../queue.ts";
import { toExtractionExchange } from "../extractor.ts";
import { HeadlessMemoryExtractor } from "./extractor.ts";

interface ExtractionQueue {
	nextUnextractedExchange(): ExtractableMemoryExchange | null;
	completeExtraction(
		exchange: ExtractableMemoryExchange,
		facts: readonly ExtractedMemoryFact[],
		extractedAt: string,
	): bigint[];
	logError(msg: string, createdAt: string): void;
	close(): void;
}

interface FactExtractor {
	extract(
		exchange: ReturnType<typeof toExtractionExchange>,
		routing: ReturnType<typeof resolveMemoryRoutingContext>,
		signal: AbortSignal,
	): Promise<ExtractedMemoryFact[]>;
}

export class MemoryExtractionConsumer {
	private readonly abortController = new AbortController();
	private flight: Promise<void> | null = null;
	private wakeRequested = false;
	private closed = false;

	constructor(
		private readonly queue: ExtractionQueue,
		private readonly extractor: FactExtractor,
		private readonly knowledgeBaseDirectory: string,
		private readonly factsReady: () => void,
		private readonly becameIdle: () => void,
	) {}

	wake(): void {
		if (this.closed) return;
		this.wakeRequested = true;
		if (this.flight) return;
		const flight = this.run();
		this.flight = flight;
		void flight.finally(() => {
			if (this.flight !== flight) return;
			this.flight = null;
			this.becameIdle();
			if (this.wakeRequested && !this.closed) this.wake();
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.abortController.abort();
		await this.flight;
		this.queue.close();
	}

	private async run(): Promise<void> {
		try {
			do {
				this.wakeRequested = false;
				await this.drain();
			} while (this.wakeRequested && !this.closed);
		} catch (error) {
			this.wakeRequested = false;
			if (this.closed && isAbortError(error)) return;
			recordMemoryError(this.queue, {
				component: "memory",
				stage: "extract-exchange",
				error: formatError(error),
			});
		}
	}

	private async drain(): Promise<void> {
		while (!this.closed) {
			const exchange = this.queue.nextUnextractedExchange();
			if (!exchange) return;
			const routing = resolveMemoryRoutingContext(this.knowledgeBaseDirectory, exchange.cwd);
			const facts = await this.extractor.extract(
				toExtractionExchange(exchange),
				routing,
				this.abortController.signal,
			);
			this.queue.completeExtraction(exchange, facts, new Date().toISOString());
			this.factsReady();
		}
	}
}

interface ExtractionConsumerConfig {
	databasePath: string;
	knowledgeBaseDirectory: string;
	piInvocation: PiInvocation;
}

export function runExtractionConsumer(): void {
	if (!process.send) throw new Error("Memory extraction consumer requires an IPC channel");
	const config = parseConfig(process.env.PI_TOOLBOX_MEMORY_EXTRACTION_CONFIG);
	const queue = new MemoryQueue(config.databasePath);
	const extractor = new HeadlessMemoryExtractor((args) => ({
		command: config.piInvocation.command,
		args: [...config.piInvocation.args, ...args],
	}));
	const consumer = new MemoryExtractionConsumer(
		queue,
		extractor,
		config.knowledgeBaseDirectory,
		() => post({ type: "facts-ready", version: MEMORY_PROTOCOL_VERSION, consumer: "extraction" }),
		() => post({ type: "drained", version: MEMORY_PROTOCOL_VERSION, consumer: "extraction" }),
	);
	let closing = false;
	const close = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		await consumer.close();
		process.exit(0);
	};
	process.on("message", (value: unknown) => {
		parseMemoryConsumerWake(value, "extraction");
		consumer.wake();
	});
	process.once("SIGINT", () => void close());
	process.once("SIGTERM", () => void close());
	post({ type: "ready", version: MEMORY_PROTOCOL_VERSION, consumer: "extraction" });
	consumer.wake();
}

function parseConfig(value: string | undefined): ExtractionConsumerConfig {
	if (!value) throw new Error("PI_TOOLBOX_MEMORY_EXTRACTION_CONFIG is required");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("PI_TOOLBOX_MEMORY_EXTRACTION_CONFIG must be JSON");
	}
	if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["databasePath", "knowledgeBaseDirectory", "piInvocation"])) {
		throw new Error("Memory extraction consumer configuration is invalid");
	}
	if (!isRecord(parsed.piInvocation) || !hasOnlyKeys(parsed.piInvocation, ["command", "args"])) {
		throw new Error("Memory extraction Pi invocation is invalid");
	}
	const command = requireNonEmptyString(parsed.piInvocation.command, "Pi command");
	if (!Array.isArray(parsed.piInvocation.args) || parsed.piInvocation.args.some((argument) => typeof argument !== "string")) {
		throw new Error("Memory extraction Pi arguments are invalid");
	}
	return {
		databasePath: requireNonEmptyString(parsed.databasePath, "database path"),
		knowledgeBaseDirectory: requireNonEmptyString(parsed.knowledgeBaseDirectory, "knowledge-base directory"),
		piInvocation: { command, args: [...parsed.piInvocation.args] },
	};
}

function post(message: MemoryConsumerMessage): void {
	process.send?.(message);
}

function requireNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Memory extraction ${label} is invalid`);
	return value;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
