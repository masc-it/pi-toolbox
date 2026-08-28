import type { PiInvocation } from "../pi/invocation.ts";
import type { MemoryConfig, MemorySender } from "./config.ts";
import type {
	ExtractableMemoryExchange,
	ExtractedMemoryFact,
	NewMemoryExchange,
	OpenMemoryExchange,
} from "./queue.ts";

export interface MemoryWorkerConfig extends MemoryConfig {
	piSessionId: string;
	cwd: string;
	piInvocation: PiInvocation;
}

interface MemoryWorkerMethodMap {
	"start-exchange": {
		params: { exchange: NewMemoryExchange; userContent: string };
		result: OpenMemoryExchange;
	};
	"append-message": {
		params: { exchangeId: bigint; sentBy: MemorySender; content: string; createdAt: string };
		result: null;
	};
	"settle-exchange": {
		params: { exchangeId: bigint; settledAt: string };
		result: null;
	};
	"next-unextracted-exchange": {
		params: null;
		result: ExtractableMemoryExchange | null;
	};
	"complete-extraction": {
		params: { exchange: ExtractableMemoryExchange; facts: ExtractedMemoryFact[]; extractedAt: string };
		result: bigint[];
	};
	"list-topics": {
		params: null;
		result: string[];
	};
	"log-error": {
		params: Record<string, unknown>;
		result: null;
	};
	shutdown: {
		params: null;
		result: null;
	};
}

export type MemoryWorkerMethod = keyof MemoryWorkerMethodMap;
export type MemoryWorkerParams<M extends MemoryWorkerMethod> = MemoryWorkerMethodMap[M]["params"];
export type MemoryWorkerResult<M extends MemoryWorkerMethod> = MemoryWorkerMethodMap[M]["result"];

export type MemoryWorkerRequest = {
	[M in MemoryWorkerMethod]: {
		type: "request";
		id: number;
		method: M;
		params: MemoryWorkerParams<M>;
	};
}[MemoryWorkerMethod];

export type MemoryWorkerResponse =
	| { type: "ready" }
	| { type: "startup-error"; error: string }
	| { type: "response"; id: number; ok: true; result: unknown }
	| { type: "response"; id: number; ok: false; error: string };
