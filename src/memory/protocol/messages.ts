import type { MemoryStatus } from "../settings-protocol.ts";

export const MEMORY_PROTOCOL_VERSION = 1 as const;
export const MEMORY_MAX_CLIENT_VERSION_BYTES = 128;
export const MEMORY_MAX_SESSION_ID_BYTES = 256;
export const MEMORY_MAX_CWD_BYTES = 16 * 1024;
export const MEMORY_MAX_MESSAGE_BYTES = 512 * 1024;

export interface MemoryHandshake {
	type: "handshake";
	version: number;
	clientVersion: string;
	sessionId: string;
	cwd: string;
}

export type MemoryHandshakeResponse =
	| { type: "handshake-response"; version: typeof MEMORY_PROTOCOL_VERSION; ok: true }
	| { type: "handshake-response"; version: typeof MEMORY_PROTOCOL_VERSION; ok: false; error: string };

export interface MemoryMethodMap {
	connectSession: { params: Record<string, never>; result: null };
	captureUser: { params: { content: string; createdAt: string }; result: null };
	captureAgent: { params: { content: string; createdAt: string }; result: null };
	settleExchange: { params: { settledAt: string }; result: boolean };
	closeSession: { params: { settledAt: string }; result: boolean };
	getStatus: { params: Record<string, never>; result: MemoryStatus };
	changeEnabled: { params: { action: "on" | "off" | "toggle" }; result: MemoryStatus };
}

export type MemoryMethod = keyof MemoryMethodMap;
export type MemoryMethodParams<M extends MemoryMethod> = MemoryMethodMap[M]["params"];
export type MemoryMethodResult<M extends MemoryMethod> = MemoryMethodMap[M]["result"];

export type MemoryRequest = {
	[M in MemoryMethod]: {
		type: "request";
		version: typeof MEMORY_PROTOCOL_VERSION;
		id: string;
		method: M;
		params: MemoryMethodParams<M>;
	};
}[MemoryMethod];

export type MemoryResponse =
	| {
		type: "response";
		version: typeof MEMORY_PROTOCOL_VERSION;
		id: string;
		ok: true;
		result: unknown;
	}
	| {
		type: "response";
		version: typeof MEMORY_PROTOCOL_VERSION;
		id: string;
		ok: false;
		error: string;
	};

export interface MemoryProtocolError {
	type: "protocol-error";
	version: typeof MEMORY_PROTOCOL_VERSION;
	error: string;
}

export type MemoryQueueName = "extraction" | "curation";

export interface MemoryConsumerWake {
	type: "wake";
	version: typeof MEMORY_PROTOCOL_VERSION;
	queue: MemoryQueueName;
}

export type MemoryConsumerMessage =
	| {
		type: "ready";
		version: typeof MEMORY_PROTOCOL_VERSION;
		consumer: MemoryQueueName;
	}
	| {
		type: "drained";
		version: typeof MEMORY_PROTOCOL_VERSION;
		consumer: MemoryQueueName;
	};

export function parseMemoryHandshake(value: unknown): MemoryHandshake {
	const record = requireExactRecord(value, ["type", "version", "clientVersion", "sessionId", "cwd"], "handshake");
	if (record.type !== "handshake") throw new Error("Expected a Memory handshake");
	if (!Number.isInteger(record.version)) throw new Error("Memory handshake has an invalid protocol version");
	return {
		type: "handshake",
		version: record.version as number,
		clientVersion: requireBoundedString(record.clientVersion, "client version", MEMORY_MAX_CLIENT_VERSION_BYTES),
		sessionId: requireBoundedString(record.sessionId, "session ID", MEMORY_MAX_SESSION_ID_BYTES),
		cwd: requireBoundedString(record.cwd, "working directory", MEMORY_MAX_CWD_BYTES),
	};
}

export function parseMemoryRequest(value: unknown): MemoryRequest {
	const record = requireExactRecord(value, ["type", "version", "id", "method", "params"], "request");
	if (record.type !== "request") throw new Error("Expected a Memory request");
	if (record.version !== MEMORY_PROTOCOL_VERSION) throw new Error(`Unsupported Memory protocol version: ${String(record.version)}`);
	if (!isRequestId(record.id)) throw new Error("Memory request has an invalid ID");
	if (typeof record.method !== "string" || !isMemoryMethod(record.method)) {
		throw new Error(`Unknown Memory method: ${String(record.method)}`);
	}
	const params = parseMethodParams(record.method, record.params);
	return { type: "request", version: MEMORY_PROTOCOL_VERSION, id: record.id, method: record.method, params } as MemoryRequest;
}

export function parseMemoryResponse(value: unknown): MemoryHandshakeResponse | MemoryResponse | MemoryProtocolError {
	if (!isRecord(value) || typeof value.type !== "string") throw new Error("Memory server returned an invalid message");
	if (value.type === "handshake-response") {
		if (value.version !== MEMORY_PROTOCOL_VERSION || typeof value.ok !== "boolean") {
			throw new Error("Memory server returned an invalid handshake response");
		}
		if (value.ok) {
			requireExactKeys(value, ["type", "version", "ok"], "handshake response");
			return { type: "handshake-response", version: MEMORY_PROTOCOL_VERSION, ok: true };
		}
		requireExactKeys(value, ["type", "version", "ok", "error"], "handshake response");
		if (typeof value.error !== "string") throw new Error("Memory server returned an invalid handshake error");
		return { type: "handshake-response", version: MEMORY_PROTOCOL_VERSION, ok: false, error: value.error };
	}
	if (value.type === "protocol-error") {
		requireExactKeys(value, ["type", "version", "error"], "protocol error");
		if (value.version !== MEMORY_PROTOCOL_VERSION || typeof value.error !== "string") {
			throw new Error("Memory server returned an invalid protocol error");
		}
		return { type: "protocol-error", version: MEMORY_PROTOCOL_VERSION, error: value.error };
	}
	if (value.type !== "response" || value.version !== MEMORY_PROTOCOL_VERSION || !isRequestId(value.id) || typeof value.ok !== "boolean") {
		throw new Error("Memory server returned an invalid response");
	}
	if (value.ok) {
		requireExactKeys(value, ["type", "version", "id", "ok", "result"], "response");
		return { type: "response", version: MEMORY_PROTOCOL_VERSION, id: value.id, ok: true, result: value.result };
	}
	requireExactKeys(value, ["type", "version", "id", "ok", "error"], "response");
	if (typeof value.error !== "string") throw new Error("Memory server returned an invalid response error");
	return { type: "response", version: MEMORY_PROTOCOL_VERSION, id: value.id, ok: false, error: value.error };
}

export function parseMemoryConsumerWake(value: unknown, queue: MemoryQueueName): MemoryConsumerWake {
	const record = requireExactRecord(value, ["type", "version", "queue"], "consumer wake");
	if (record.type !== "wake" || record.version !== MEMORY_PROTOCOL_VERSION || record.queue !== queue) {
		throw new Error(`Invalid ${queue} consumer wake`);
	}
	return { type: "wake", version: MEMORY_PROTOCOL_VERSION, queue };
}

export function parseMemoryConsumerMessage(value: unknown): MemoryConsumerMessage {
	const record = requireExactRecord(value, ["type", "version", "consumer"], "consumer message");
	if ((record.type !== "ready" && record.type !== "drained") || record.version !== MEMORY_PROTOCOL_VERSION || !isMemoryQueueName(record.consumer)) {
		throw new Error("Invalid Memory consumer message");
	}
	return { type: record.type, version: MEMORY_PROTOCOL_VERSION, consumer: record.consumer };
}

export function isMemoryStatus(value: unknown): value is MemoryStatus {
	return isRecord(value) &&
		typeof value.enabled === "boolean" &&
		isCount(value.pending) &&
		isCount(value.processed) &&
		isCount(value.errors);
}

function parseMethodParams(method: MemoryMethod, value: unknown): MemoryRequest["params"] {
	switch (method) {
		case "connectSession":
		case "getStatus":
			return requireEmptyRecord(value, `${method} parameters`);
		case "captureUser":
		case "captureAgent": {
			const params = requireExactRecord(value, ["content", "createdAt"], `${method} parameters`);
			return {
				content: requireBoundedString(params.content, "message content", MEMORY_MAX_MESSAGE_BYTES),
				createdAt: requireTimestamp(params.createdAt),
			};
		}
		case "settleExchange":
		case "closeSession": {
			const params = requireExactRecord(value, ["settledAt"], `${method} parameters`);
			return { settledAt: requireTimestamp(params.settledAt) };
		}
		case "changeEnabled": {
			const params = requireExactRecord(value, ["action"], "changeEnabled parameters");
			if (params.action !== "on" && params.action !== "off" && params.action !== "toggle") {
				throw new Error("changeEnabled has an invalid action");
			}
			return { action: params.action };
		}
	}
}

function requireTimestamp(value: unknown): string {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
		throw new Error("Memory request has an invalid UTC timestamp");
	}
	return value;
}

function requireBoundedString(value: unknown, label: string, maxBytes: number): string {
	if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
		throw new Error(`Memory ${label} is invalid`);
	}
	return value;
}

function requireEmptyRecord(value: unknown, label: string): Record<string, never> {
	return requireExactRecord(value, [], label) as Record<string, never>;
}

function requireExactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`Memory ${label} must be an object`);
	requireExactKeys(value, keys, label);
	return value;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new Error(`Memory ${label} has invalid fields`);
	}
}

function isMemoryMethod(value: string): value is MemoryMethod {
	return [
		"connectSession",
		"captureUser",
		"captureAgent",
		"settleExchange",
		"closeSession",
		"getStatus",
		"changeEnabled",
	].includes(value);
}

function isMemoryQueueName(value: unknown): value is MemoryQueueName {
	return value === "extraction" || value === "curation";
}

function isRequestId(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
