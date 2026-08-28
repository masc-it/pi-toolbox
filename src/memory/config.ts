import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MEMORY_TOPICS = ["coding", "docs-style", "personal-principles", "projects", "team"] as const;
export type MemoryTopic = string;

export const MEMORY_SENDERS = ["user", "agent"] as const;
export type MemorySender = (typeof MEMORY_SENDERS)[number];

export const MEMORY_FACT_SUPPORT = ["user", "agent", "both"] as const;
export type MemoryFactSupport = (typeof MEMORY_FACT_SUPPORT)[number];

export const MEMORY_BATCH_MAX_FACTS = 10;
export const MEMORY_BATCH_MAX_BYTES = 32 * 1024;

export interface MemoryConfig {
	dataDirectory: string;
	databasePath: string;
	knowledgeBaseDirectory: string;
}

export function createMemoryConfig(
	agentDirectory = getAgentDir(),
	homeDirectory = homedir(),
): MemoryConfig {
	const dataDirectory = join(agentDirectory, "pi-toolbox");
	return {
		dataDirectory,
		databasePath: join(dataDirectory, "memory.sqlite"),
		knowledgeBaseDirectory: join(homeDirectory, "work-memory"),
	};
}

export function isMemoryTopic(value: unknown): value is MemoryTopic {
	return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export function isMemorySender(value: unknown): value is MemorySender {
	return typeof value === "string" && MEMORY_SENDERS.some((sender) => sender === value);
}

export function isMemoryFactSupport(value: unknown): value is MemoryFactSupport {
	return typeof value === "string" && MEMORY_FACT_SUPPORT.some((support) => support === value);
}
