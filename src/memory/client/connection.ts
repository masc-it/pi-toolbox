import { randomUUID } from "node:crypto";
import { connect as connectSocket, type Socket } from "node:net";
import type { MemoryConfig } from "../config.ts";
import { createMemoryServicePaths } from "../config.ts";
import { MemoryFrameDecoder, encodeMemoryFrame } from "../protocol/framing.ts";
import {
	MEMORY_PROTOCOL_VERSION,
	isMemoryStatus,
	parseMemoryResponse,
	type MemoryHandshake,
	type MemoryMethod,
	type MemoryMethodParams,
	type MemoryMethodResult,
	type MemoryRequest,
	type MemoryResponse,
} from "../protocol/messages.ts";
import { connectToMemoryService } from "../server/lifecycle.ts";

const REQUEST_TIMEOUT_MS = 30_000;

export interface MemoryConnectionOptions {
	clientVersion: string;
	sessionId: string;
	cwd: string;
}

interface PendingRequest {
	method: MemoryMethod;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

export class MemoryServerConnection {
	private readonly decoder: MemoryFrameDecoder;
	private readonly pending = new Map<string, PendingRequest>();
	private handshakeResolve!: () => void;
	private handshakeReject!: (error: Error) => void;
	private readonly handshake: Promise<void>;
	private closed = false;

	private constructor(
		private readonly socket: Socket,
		options: MemoryConnectionOptions,
	) {
		this.handshake = new Promise<void>((resolve, reject) => {
			this.handshakeResolve = resolve;
			this.handshakeReject = reject;
		});
		this.decoder = new MemoryFrameDecoder((value) => this.receive(value));
		this.socket.on("data", (chunk) => {
			try {
				this.decoder.push(chunk);
			} catch (error) {
				this.fail(toError(error));
			}
		});
		this.socket.on("error", (error) => this.fail(error));
		this.socket.on("close", () => this.fail(new Error("Memory server connection closed")));

		const handshake: MemoryHandshake = {
			type: "handshake",
			version: MEMORY_PROTOCOL_VERSION,
			clientVersion: options.clientVersion,
			sessionId: options.sessionId,
			cwd: options.cwd,
		};
		this.socket.write(encodeMemoryFrame(handshake));
	}

	static async connect(
		config: MemoryConfig,
		options: MemoryConnectionOptions,
	): Promise<MemoryServerConnection> {
		const socket = await connectToMemoryService(config, createMemoryServicePaths(config.dataDirectory));
		return this.completeConnection(socket, options);
	}

	static async connectSocket(socketPath: string, options: MemoryConnectionOptions): Promise<MemoryServerConnection> {
		const socket = await new Promise<Socket>((resolve, reject) => {
			const candidate = connectSocket(socketPath);
			candidate.once("connect", () => resolve(candidate));
			candidate.once("error", reject);
		});
		return this.completeConnection(socket, options);
	}

	private static async completeConnection(socket: Socket, options: MemoryConnectionOptions): Promise<MemoryServerConnection> {
		const connection = new MemoryServerConnection(socket, options);
		try {
			await connection.handshake;
			return connection;
		} catch (error) {
			connection.close();
			throw error;
		}
	}

	request<M extends MemoryMethod>(
		method: M,
		params: MemoryMethodParams<M>,
	): Promise<MemoryMethodResult<M>> {
		return this.requestWithId(randomUUID(), method, params);
	}

	async requestWithId<M extends MemoryMethod>(
		id: string,
		method: M,
		params: MemoryMethodParams<M>,
	): Promise<MemoryMethodResult<M>> {
		if (this.closed) throw new Error("Memory server connection is closed");
		await this.handshake;
		if (this.pending.has(id)) throw new Error(`Memory request is already pending: ${id}`);

		const request = { type: "request", version: MEMORY_PROTOCOL_VERSION, id, method, params } as MemoryRequest;
		return new Promise<MemoryMethodResult<M>>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Memory server request timed out: ${method}`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, {
				method,
				resolve: (value) => resolve(value as MemoryMethodResult<M>),
				reject,
				timeout,
			});
			this.socket.write(encodeMemoryFrame(request));
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.socket.destroy();
		this.rejectPending(new Error("Memory server connection closed"));
	}

	private receive(value: unknown): void {
		const message = parseMemoryResponse(value);
		if (message.type === "handshake-response") {
			if (message.ok) this.handshakeResolve();
			else this.handshakeReject(new Error(message.error));
			return;
		}
		if (message.type === "protocol-error") {
			this.fail(new Error(message.error));
			return;
		}
		this.completeRequest(message);
	}

	private completeRequest(response: MemoryResponse): void {
		const request = this.pending.get(response.id);
		if (!request) {
			this.fail(new Error(`Memory server returned an unexpected response: ${response.id}`));
			return;
		}
		this.pending.delete(response.id);
		clearTimeout(request.timeout);
		if (!response.ok) {
			request.reject(new Error(response.error));
			return;
		}
		try {
			request.resolve(validateResult(request.method, response.result));
		} catch (error) {
			request.reject(toError(error));
		}
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.handshakeReject(error);
		this.rejectPending(error);
		this.socket.destroy();
	}

	private rejectPending(error: Error): void {
		for (const request of this.pending.values()) {
			clearTimeout(request.timeout);
			request.reject(error);
		}
		this.pending.clear();
	}
}

function validateResult(method: MemoryMethod, value: unknown): unknown {
	switch (method) {
		case "connectSession":
		case "captureUser":
		case "captureAgent":
			if (value !== null) throw new Error(`Memory server returned an invalid ${method} result`);
			return null;
		case "settleExchange":
		case "closeSession":
			if (typeof value !== "boolean") throw new Error(`Memory server returned an invalid ${method} result`);
			return value;
		case "getStatus":
		case "changeEnabled":
			if (!isMemoryStatus(value)) throw new Error(`Memory server returned an invalid ${method} result`);
			return value;
	}
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
