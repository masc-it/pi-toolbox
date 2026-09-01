import type { PiInvocation } from "../../pi/invocation.ts";
import { MemoryConsumer } from "../consumer.ts";
import { MemoryCurator } from "../curator.ts";
import {
	MEMORY_PROTOCOL_VERSION,
	parseMemoryConsumerWake,
	type MemoryConsumerMessage,
} from "../protocol/messages.ts";
import { MemoryQueue } from "../queue.ts";
import { MemoryRepository } from "../repository.ts";

interface CurationConsumerConfig {
	databasePath: string;
	knowledgeBaseDirectory: string;
	piInvocation: PiInvocation;
}

export function runCurationConsumer(): void {
	if (!process.send) throw new Error("Memory curation consumer requires an IPC channel");
	const config = parseConfig(process.env.PI_TOOLBOX_MEMORY_CURATION_CONFIG);
	const queue = new MemoryQueue(config.databasePath);
	const repository = new MemoryRepository(config.knowledgeBaseDirectory);
	const curator = new MemoryCurator((args) => ({
		command: config.piInvocation.command,
		args: [...config.piInvocation.args, ...args],
	}));
	const consumer = new MemoryConsumer(
		queue,
		curator,
		repository,
		() => post({ type: "drained", version: MEMORY_PROTOCOL_VERSION, consumer: "curation" }),
	);
	let closing = false;
	const close = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		await consumer.close();
		process.exit(0);
	};
	process.on("message", (value: unknown) => {
		parseMemoryConsumerWake(value, "curation");
		consumer.wake();
	});
	process.once("SIGINT", () => void close());
	process.once("SIGTERM", () => void close());
	post({ type: "ready", version: MEMORY_PROTOCOL_VERSION, consumer: "curation" });
	consumer.wake();
}

function parseConfig(value: string | undefined): CurationConsumerConfig {
	if (!value) throw new Error("PI_TOOLBOX_MEMORY_CURATION_CONFIG is required");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("PI_TOOLBOX_MEMORY_CURATION_CONFIG must be JSON");
	}
	if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["databasePath", "knowledgeBaseDirectory", "piInvocation"])) {
		throw new Error("Memory curation consumer configuration is invalid");
	}
	if (!isRecord(parsed.piInvocation) || !hasOnlyKeys(parsed.piInvocation, ["command", "args"])) {
		throw new Error("Memory curation Pi invocation is invalid");
	}
	const command = requireNonEmptyString(parsed.piInvocation.command, "Pi command");
	if (!Array.isArray(parsed.piInvocation.args) || parsed.piInvocation.args.some((argument) => typeof argument !== "string")) {
		throw new Error("Memory curation Pi arguments are invalid");
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
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Memory curation ${label} is invalid`);
	return value;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
