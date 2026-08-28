import type { MessagePort } from "node:worker_threads";
import type { PiInvocation } from "../pi/invocation.ts";
import type { MemoryConfig, MemoryRoutingContext } from "./config.ts";
import type {
	ExtractableMemoryExchange,
	ExtractedMemoryFact,
	NewMemoryExchange,
} from "./queue.ts";

export interface MemoryWorkerConfig extends MemoryConfig {
	piSessionId: string;
	cwd: string;
	piInvocation: PiInvocation;
}

export interface MemoryExtractionWork {
	exchange: ExtractableMemoryExchange;
	routing: MemoryRoutingContext;
}

interface MemoryWorkerMethodMap {
	"capture-user": {
		params: { exchange: NewMemoryExchange; content: string };
		result: null;
	};
	"capture-agent": {
		params: { content: string; createdAt: string };
		result: null;
	};
	"settle-active-exchange": {
		params: { settledAt: string };
		result: boolean;
	};
	"next-extraction": {
		params: null;
		result: MemoryExtractionWork | null;
	};
	"complete-extraction": {
		params: { exchange: ExtractableMemoryExchange; facts: ExtractedMemoryFact[]; extractedAt: string };
		result: bigint[];
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
		method: M;
		params: MemoryWorkerParams<M>;
		replyPort: MessagePort;
	};
}[MemoryWorkerMethod];

export type MemoryWorkerStartupMessage =
	| { type: "ready" }
	| { type: "startup-error"; error: string };

export type MemoryWorkerResponse =
	| { ok: true; result: unknown }
	| { ok: false; error: string };
