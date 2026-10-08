import { homedir } from "node:os";
import { join } from "node:path";

// The memory server runs as a plain Node process without Pi's peer packages,
// so this module must not import @earendil-works/* at runtime.

export const MEMORY_GLOBAL_COLLECTIONS = ["coding", "docs-style", "personal-principles", "team"] as const;
export type MemoryGlobalCollection = (typeof MEMORY_GLOBAL_COLLECTIONS)[number];

export const MEMORY_COLLECTION_ROOTS = [...MEMORY_GLOBAL_COLLECTIONS, "projects"] as const;
export type MemoryCollectionRoot = (typeof MEMORY_COLLECTION_ROOTS)[number];
export type MemoryCollectionPath = string;

export const MEMORY_SENDERS = ["user", "agent"] as const;
export type MemorySender = (typeof MEMORY_SENDERS)[number];

export const MEMORY_FACT_SUPPORT = ["user", "agent", "both"] as const;
export type MemoryFactSupport = (typeof MEMORY_FACT_SUPPORT)[number];

export const MEMORY_BATCH_MAX_FACTS = 10;
export const MEMORY_BATCH_MAX_BYTES = 32 * 1024;
export const MEMORY_CLIENT_VERSION = "pi-toolbox/0.1.0";

export interface MemoryRoutingContext {
	currentProjectCollection: MemoryCollectionPath;
	availableCollections: MemoryCollectionPath[];
}

export interface MemoryConfig {
	dataDirectory: string;
	databasePath: string;
	knowledgeBaseDirectory: string;
}

export interface MemoryServicePaths {
	socketPath: string;
	startupLockPath: string;
	legacyWorkerLockPath: string;
	logPath: string;
}

export function createMemoryServicePaths(dataDirectory: string): MemoryServicePaths {
	return {
		socketPath: join(dataDirectory, "memory.sock"),
		startupLockPath: join(dataDirectory, "memory.start.lock"),
		legacyWorkerLockPath: createLegacyMemoryWorkerLockPath(join(dataDirectory, "memory.sqlite")),
		logPath: join(dataDirectory, "memory-service.log"),
	};
}

export function createLegacyMemoryWorkerLockPath(databasePath: string): string {
	return `${databasePath}.lock`;
}

export function createMemoryConfig(
	agentDirectory: string,
	homeDirectory = homedir(),
): MemoryConfig {
	const dataDirectory = join(agentDirectory, "pi-toolbox");
	return {
		dataDirectory,
		databasePath: join(dataDirectory, "memory.sqlite"),
		knowledgeBaseDirectory: join(homeDirectory, "work-memory"),
	};
}

export function isMemoryCollectionSegment(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export function toMemoryCollectionSegment(value: string): string {
	const segment = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	if (!isMemoryCollectionSegment(segment)) {
		throw new Error(`Memory collection name cannot be converted to lowercase kebab-case: ${value}`);
	}
	return segment;
}

export function isMemoryCollectionRoot(value: unknown): value is MemoryCollectionRoot {
	return typeof value === "string" && MEMORY_COLLECTION_ROOTS.some((root) => root === value);
}

export function isMemoryGlobalCollection(value: unknown): value is MemoryGlobalCollection {
	return typeof value === "string" && MEMORY_GLOBAL_COLLECTIONS.some((collection) => collection === value);
}

export function isMemoryCollectionPath(value: unknown): value is MemoryCollectionPath {
	if (isMemoryGlobalCollection(value)) {
		return true;
	}
	if (typeof value !== "string") {
		return false;
	}
	const parts = value.split("/");
	return parts.length === 2 && parts[0] === "projects" && isMemoryCollectionSegment(parts[1]);
}

export function isMemorySender(value: unknown): value is MemorySender {
	return typeof value === "string" && MEMORY_SENDERS.some((sender) => sender === value);
}

export function isMemoryFactSupport(value: unknown): value is MemoryFactSupport {
	return typeof value === "string" && MEMORY_FACT_SUPPORT.some((support) => support === value);
}
