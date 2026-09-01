import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { MemoryFrameDecoder, encodeMemoryFrame } from "../protocol/framing.ts";
import {
	MEMORY_PROTOCOL_VERSION,
	parseMemoryHandshake,
	parseMemoryRequest,
	type MemoryHandshakeResponse,
	type MemoryMethodResult,
	type MemoryProtocolError,
	type MemoryQueueName,
	type MemoryRequest,
	type MemoryResponse,
} from "../protocol/messages.ts";
import { MemorySettingsStore } from "../settings.ts";
import { MemoryServerSettings } from "./settings.ts";
import { MemoryConsumerSupervisor } from "./supervisor.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface MemoryServerConfig {
	socketPath: string;
	databasePath: string;
}

interface Receipt {
	sessionId: string;
	fingerprint: string;
	response: Promise<MemoryResponse>;
}

export class MemoryServer {
	private readonly server: Server;
	private readonly consumers: MemoryConsumerSupervisor;
	private readonly settingsStore: MemorySettingsStore;
	private readonly settings: MemoryServerSettings;
	private readonly sockets = new Set<Socket>();
	private readonly sessionChains = new Map<string, Promise<void>>();
	private readonly receipts = new Map<string, Receipt>();
	private started = false;
	private stopping = false;

	constructor(
		private readonly config: MemoryServerConfig,
		consumers = new MemoryConsumerSupervisor(),
	) {
		this.consumers = consumers;
		this.settingsStore = new MemorySettingsStore(config.databasePath);
		this.settings = new MemoryServerSettings(this.settingsStore, consumers);
		this.server = createServer((socket) => this.accept(socket));
	}

	async start(): Promise<void> {
		if (this.started) return;
		mkdirSync(dirname(this.config.socketPath), { recursive: true, mode: 0o700 });
		chmodSync(dirname(this.config.socketPath), 0o700);
		if (this.settingsStore.isEnabled()) await this.consumers.start();
		try {
			await listen(this.server, this.config.socketPath);
			chmodSync(this.config.socketPath, 0o600);
			this.started = true;
		} catch (error) {
			await this.consumers.stop();
			throw error;
		}
	}

	wake(queue: MemoryQueueName): void {
		this.consumers.wake(queue);
	}

	consumerPid(queue: MemoryQueueName): number | null {
		return this.consumers.consumerPid(queue);
	}

	connectionCount(): number {
		return this.sockets.size;
	}

	async stop(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		for (const socket of this.sockets) socket.destroy();
		if (this.started) await closeServer(this.server);
		await this.consumers.stop();
		this.settingsStore.close();
		rmSync(this.config.socketPath, { force: true });
		this.started = false;
	}

	private accept(socket: Socket): void {
		this.sockets.add(socket);
		let sessionId: string | null = null;
		let closed = false;
		const handshakeTimeout = setTimeout(() => rejectConnection("Memory handshake timed out"), HANDSHAKE_TIMEOUT_MS);
		const decoder = new MemoryFrameDecoder((value) => {
			if (!sessionId) {
				let handshake;
				try {
					handshake = parseMemoryHandshake(value);
				} catch (error) {
					rejectConnection(formatError(error));
					return;
				}
				if (handshake.version !== MEMORY_PROTOCOL_VERSION) {
					const response: MemoryHandshakeResponse = {
						type: "handshake-response",
						version: MEMORY_PROTOCOL_VERSION,
						ok: false,
						error: `Unsupported Memory protocol version: ${handshake.version}`,
					};
					writeFrame(socket, response);
					socket.end();
					return;
				}
				sessionId = handshake.sessionId;
				clearTimeout(handshakeTimeout);
				writeFrame(socket, { type: "handshake-response", version: MEMORY_PROTOCOL_VERSION, ok: true });
				return;
			}

			let request;
			try {
				request = parseMemoryRequest(value);
			} catch (error) {
				rejectConnection(formatError(error));
				return;
			}
			const requestSessionId = sessionId;
			void this.schedule(requestSessionId, async () => {
				const response = await this.respond(requestSessionId, request);
				if (!socket.destroyed) writeFrame(socket, response);
			});
		});

		const rejectConnection = (error: string): void => {
			if (closed) return;
			closed = true;
			clearTimeout(handshakeTimeout);
			const response: MemoryProtocolError = { type: "protocol-error", version: MEMORY_PROTOCOL_VERSION, error };
			try {
				writeFrame(socket, response);
				socket.end();
			} catch {
				socket.destroy();
			}
		};

		socket.on("data", (chunk) => {
			if (closed) return;
			try {
				decoder.push(chunk);
			} catch (error) {
				rejectConnection(formatError(error));
			}
		});
		socket.on("end", () => {
			try {
				decoder.finish();
			} catch {
				socket.destroy();
			}
		});
		socket.on("error", () => undefined);
		socket.on("close", () => {
			closed = true;
			clearTimeout(handshakeTimeout);
			this.sockets.delete(socket);
		});
	}

	private schedule(sessionId: string, operation: () => Promise<void>): Promise<void> {
		const previous = this.sessionChains.get(sessionId) ?? Promise.resolve();
		const current = previous.then(operation, operation).catch(() => undefined);
		this.sessionChains.set(sessionId, current);
		void current.then(() => {
			if (this.sessionChains.get(sessionId) === current) this.sessionChains.delete(sessionId);
		});
		return current;
	}

	private respond(sessionId: string, request: MemoryRequest): Promise<MemoryResponse> {
		if (request.method !== "changeEnabled") return this.execute(request);
		const fingerprint = JSON.stringify({ method: request.method, params: request.params });
		const existing = this.receipts.get(request.id);
		if (existing) {
			if (existing.sessionId !== sessionId || existing.fingerprint !== fingerprint) {
				return Promise.resolve(failureResponse(request.id, "Memory request ID was reused for a different request"));
			}
			return existing.response;
		}

		const response = this.execute(request);
		this.receipts.set(request.id, { sessionId, fingerprint, response });
		return response;
	}

	private async execute(request: MemoryRequest): Promise<MemoryResponse> {
		try {
			let result: unknown;
			switch (request.method) {
				case "connectSession":
					result = null satisfies MemoryMethodResult<"connectSession">;
					break;
				case "getStatus":
					result = this.settings.getStatus() satisfies MemoryMethodResult<"getStatus">;
					break;
				case "changeEnabled":
					result = await this.settings.change(request.params.action) satisfies MemoryMethodResult<"changeEnabled">;
					break;
				case "captureUser":
				case "captureAgent":
				case "settleExchange":
				case "closeSession":
					throw new Error(`Memory method is not available yet: ${request.method}`);
			}
			return { type: "response", version: MEMORY_PROTOCOL_VERSION, id: request.id, ok: true, result };
		} catch (error) {
			return failureResponse(request.id, formatError(error));
		}
	}
}

export async function runMemoryServerFromEnvironment(): Promise<void> {
	const config = parseServerConfig(process.env.PI_TOOLBOX_MEMORY_SERVER_CONFIG);
	const server = new MemoryServer(config);
	const stop = async (): Promise<void> => {
		await server.stop();
		process.exit(0);
	};
	process.once("SIGINT", () => void stop());
	process.once("SIGTERM", () => void stop());
	await server.start();
}

function parseServerConfig(value: string | undefined): MemoryServerConfig {
	if (!value) throw new Error("PI_TOOLBOX_MEMORY_SERVER_CONFIG is required");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("PI_TOOLBOX_MEMORY_SERVER_CONFIG must be JSON");
	}
	if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["socketPath", "databasePath"])) {
		throw new Error("Memory server configuration is invalid");
	}
	return {
		socketPath: requireNonEmptyString(parsed.socketPath, "socketPath"),
		databasePath: requireNonEmptyString(parsed.databasePath, "databasePath"),
	};
}

function failureResponse(id: string, error: string): MemoryResponse {
	return { type: "response", version: MEMORY_PROTOCOL_VERSION, id, ok: false, error };
}

function writeFrame(socket: Socket, value: unknown): void {
	socket.write(encodeMemoryFrame(value));
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(socketPath);
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	});
}

function requireNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Memory server configuration has an invalid ${label}`);
	}
	return value;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
