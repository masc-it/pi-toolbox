import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { PiInvocation } from "../../pi/invocation.ts";
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
import { recordMemoryError } from "../log.ts";
import { MemoryQueue } from "../queue.ts";
import { createMemoryRequestIdentity } from "../request-receipts.ts";
import { MemorySettingsStore } from "../settings.ts";
import { MemoryServerSettings } from "./settings.ts";
import { MemoryConsumerSupervisor } from "./supervisor.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_DISCONNECTED_SESSION_GRACE_MS = 30_000;

export interface MemoryServerConfig {
	socketPath: string;
	databasePath: string;
	knowledgeBaseDirectory: string;
	piInvocation: PiInvocation;
	disconnectedSessionGraceMs?: number;
}

interface ClientSession {
	sessionId: string;
	cwd: string;
}

export class MemoryServer {
	private readonly server: Server;
	private readonly consumers: MemoryConsumerSupervisor;
	private readonly queue: MemoryQueue;
	private readonly settingsStore: MemorySettingsStore;
	private readonly settings: MemoryServerSettings;
	private readonly sockets = new Set<Socket>();
	private readonly sessionChains = new Map<string, Promise<void>>();
	private readonly sessionConnections = new Map<string, number>();
	private readonly sessionExpiryTimers = new Map<string, NodeJS.Timeout>();
	private readonly disconnectedSessionGraceMs: number;
	private started = false;
	private stopping = false;

	constructor(
		private readonly config: MemoryServerConfig,
		consumers?: MemoryConsumerSupervisor,
	) {
		this.disconnectedSessionGraceMs = config.disconnectedSessionGraceMs ?? DEFAULT_DISCONNECTED_SESSION_GRACE_MS;
		if (!Number.isInteger(this.disconnectedSessionGraceMs) || this.disconnectedSessionGraceMs < 0) {
			throw new Error("Memory disconnected-session grace period is invalid");
		}
		this.consumers = consumers ?? new MemoryConsumerSupervisor({
			databasePath: config.databasePath,
			knowledgeBaseDirectory: config.knowledgeBaseDirectory,
			piInvocation: config.piInvocation,
		});
		this.queue = new MemoryQueue(config.databasePath);
		this.settingsStore = new MemorySettingsStore(config.databasePath);
		this.settings = new MemoryServerSettings(this.settingsStore, this.consumers);
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
		for (const timer of this.sessionExpiryTimers.values()) clearTimeout(timer);
		this.sessionExpiryTimers.clear();
		for (const socket of this.sockets) socket.destroy();
		if (this.started) await closeServer(this.server);
		await this.consumers.stop();
		this.settingsStore.close();
		this.queue.close();
		rmSync(this.config.socketPath, { force: true });
		this.started = false;
	}

	private accept(socket: Socket): void {
		this.sockets.add(socket);
		let session: ClientSession | null = null;
		let closed = false;
		const handshakeTimeout = setTimeout(() => rejectConnection("Memory handshake timed out"), HANDSHAKE_TIMEOUT_MS);
		const decoder = new MemoryFrameDecoder((value) => {
			if (!session) {
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
				session = { sessionId: handshake.sessionId, cwd: handshake.cwd };
				this.registerSessionConnection(session.sessionId);
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
			const requestSession = session;
			void this.schedule(requestSession.sessionId, async () => {
				const response = await this.execute(requestSession, request);
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
			if (session) this.unregisterSessionConnection(session.sessionId);
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

	private async execute(session: ClientSession, request: MemoryRequest): Promise<MemoryResponse> {
		try {
			const identity = createMemoryRequestIdentity(request.id, session.sessionId, request.method, request.params);
			let result: unknown;
			switch (request.method) {
				case "connectSession":
					result = null satisfies MemoryMethodResult<"connectSession">;
					break;
				case "captureUser":
					result = this.settingsStore.isEnabled()
						? this.queue.captureUserForSession(identity, {
							piSessionId: session.sessionId,
							cwd: session.cwd,
							startedAt: request.params.createdAt,
						}, request.params.content)
						: this.queue.recordRequestResult(identity, null, request.params.createdAt);
					break;
				case "captureAgent":
					result = this.settingsStore.isEnabled()
						? this.queue.captureAgentForSession(
							identity,
							session.sessionId,
							request.params.content,
							request.params.createdAt,
						)
						: this.queue.recordRequestResult(identity, null, request.params.createdAt);
					break;
				case "settleExchange":
				case "closeSession":
					result = this.queue.settleSessionExchange(
						identity,
						session.sessionId,
						request.params.settledAt,
					) satisfies MemoryMethodResult<"settleExchange">;
					if (result) this.wake("extraction");
					break;
				case "getStatus":
					result = this.settings.getStatus() satisfies MemoryMethodResult<"getStatus">;
					break;
				case "changeEnabled":
					result = await this.settings.change(identity, request.params.action) satisfies MemoryMethodResult<"changeEnabled">;
					break;
			}
			return { type: "response", version: MEMORY_PROTOCOL_VERSION, id: request.id, ok: true, result };
		} catch (error) {
			return failureResponse(request.id, formatError(error));
		}
	}

	private registerSessionConnection(sessionId: string): void {
		const expiry = this.sessionExpiryTimers.get(sessionId);
		if (expiry) clearTimeout(expiry);
		this.sessionExpiryTimers.delete(sessionId);
		this.sessionConnections.set(sessionId, (this.sessionConnections.get(sessionId) ?? 0) + 1);
	}

	private unregisterSessionConnection(sessionId: string): void {
		const connections = this.sessionConnections.get(sessionId);
		if (!connections) return;
		if (connections > 1) {
			this.sessionConnections.set(sessionId, connections - 1);
			return;
		}
		this.sessionConnections.delete(sessionId);
		if (this.stopping) return;
		const timer = setTimeout(() => {
			this.sessionExpiryTimers.delete(sessionId);
			void this.schedule(sessionId, async () => {
				if (this.sessionConnections.has(sessionId) || this.stopping) return;
				try {
					if (this.queue.settleOpenExchangeForSession(sessionId, new Date().toISOString())) {
						this.wake("extraction");
					}
				} catch (error) {
					recordMemoryError(this.queue, {
						component: "memory",
						stage: "expire-session",
						pi_session_id: sessionId,
						error: formatError(error),
					});
				}
			});
		}, this.disconnectedSessionGraceMs);
		this.sessionExpiryTimers.set(sessionId, timer);
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
	if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["socketPath", "databasePath", "knowledgeBaseDirectory", "piInvocation"])) {
		throw new Error("Memory server configuration is invalid");
	}
	if (!isRecord(parsed.piInvocation) || !hasOnlyKeys(parsed.piInvocation, ["command", "args"])) {
		throw new Error("Memory server Pi invocation is invalid");
	}
	const command = requireNonEmptyString(parsed.piInvocation.command, "piInvocation.command");
	if (!Array.isArray(parsed.piInvocation.args) || parsed.piInvocation.args.some((argument) => typeof argument !== "string")) {
		throw new Error("Memory server Pi invocation arguments are invalid");
	}
	return {
		socketPath: requireNonEmptyString(parsed.socketPath, "socketPath"),
		databasePath: requireNonEmptyString(parsed.databasePath, "databasePath"),
		knowledgeBaseDirectory: requireNonEmptyString(parsed.knowledgeBaseDirectory, "knowledgeBaseDirectory"),
		piInvocation: { command, args: [...parsed.piInvocation.args] },
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
