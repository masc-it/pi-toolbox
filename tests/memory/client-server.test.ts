import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryServerConnection } from "../../src/memory/client/connection.ts";
import { MEMORY_MAX_FRAME_BYTES, MemoryFrameDecoder, encodeMemoryFrame } from "../../src/memory/protocol/framing.ts";
import { MEMORY_PROTOCOL_VERSION } from "../../src/memory/protocol/messages.ts";
import { MemoryServer } from "../../src/memory/server/runtime.ts";
import { MemorySettingsStore } from "../../src/memory/settings.ts";

interface TestService {
	directory: string;
	databasePath: string;
	socketPath: string;
	server: MemoryServer;
}

async function createService(): Promise<TestService> {
	const directory = mkdtempSync(join(tmpdir(), "pi-toolbox-memory-"));
	const databasePath = join(directory, "memory.sqlite");
	const socketPath = join(directory, "memory.sock");
	const server = new MemoryServer({ databasePath, socketPath });
	await server.start();
	return { directory, databasePath, socketPath, server };
}

async function destroyService(service: TestService): Promise<void> {
	await service.server.stop();
	rmSync(service.directory, { recursive: true, force: true });
}

function options(sessionId = randomUUID()) {
	return { clientVersion: "test", sessionId, cwd: process.cwd() };
}

test("one server handles concurrent Pi sessions and orders each session's requests", async () => {
	const service = await createService();
	try {
		const [first, second] = await Promise.all([
			MemoryServerConnection.connectSocket(service.socketPath, options()),
			MemoryServerConnection.connectSocket(service.socketPath, options()),
		]);
		assert.equal(service.server.connectionCount(), 2);
		const [firstStatus, secondStatus] = await Promise.all([
			first.request("getStatus", {}),
			second.request("getStatus", {}),
		]);
		assert.equal(firstStatus.enabled, true);
		assert.deepEqual(secondStatus, firstStatus);

		const changes = await Promise.all([
			first.request("changeEnabled", { action: "off" }),
			first.request("changeEnabled", { action: "on" }),
		]);
		assert.equal(changes[0].enabled, false);
		assert.equal(changes[1].enabled, true);
		assert.equal((await first.request("getStatus", {})).enabled, true);
		first.close();
		second.close();
	} finally {
		await destroyService(service);
	}
});

test("the server replaces extraction and curation consumers", async () => {
	const service = await createService();
	try {
		for (const queue of ["extraction", "curation"] as const) {
			const firstPid = service.server.consumerPid(queue);
			assert.ok(firstPid);
			process.kill(firstPid, "SIGTERM");
			const replacementPid = await waitFor(() => {
				const candidate = service.server.consumerPid(queue);
				return candidate && candidate !== firstPid ? candidate : null;
			});
			assert.notEqual(replacementPid, firstPid);
			service.server.wake(queue);
		}
	} finally {
		await destroyService(service);
	}
});

test("the server rejects malformed, oversized, unknown, and incompatible messages", async () => {
	const service = await createService();
	try {
		const malformedPayload = Buffer.from("{", "utf8");
		const malformedHeader = Buffer.alloc(4);
		malformedHeader.writeUInt32BE(malformedPayload.length);
		const malformed = await collectMessages(service.socketPath, [malformedHeader, malformedPayload], 1);
		assert.equal(malformed[0]?.type, "protocol-error");

		const oversizedHeader = Buffer.alloc(4);
		oversizedHeader.writeUInt32BE(MEMORY_MAX_FRAME_BYTES + 1);
		const oversized = await collectMessages(service.socketPath, [oversizedHeader], 1);
		assert.equal(oversized[0]?.type, "protocol-error");

		const incompatible = await collectMessages(service.socketPath, [encodeMemoryFrame({
			type: "handshake",
			version: MEMORY_PROTOCOL_VERSION + 1,
			clientVersion: "test",
			sessionId: randomUUID(),
			cwd: process.cwd(),
		})], 1);
		assert.deepEqual(incompatible[0], {
			type: "handshake-response",
			version: MEMORY_PROTOCOL_VERSION,
			ok: false,
			error: `Unsupported Memory protocol version: ${MEMORY_PROTOCOL_VERSION + 1}`,
		});

		const unknown = await collectMessages(service.socketPath, [
			encodeMemoryFrame({
				type: "handshake",
				version: MEMORY_PROTOCOL_VERSION,
				clientVersion: "test",
				sessionId: randomUUID(),
				cwd: process.cwd(),
			}),
			encodeMemoryFrame({
				type: "request",
				version: MEMORY_PROTOCOL_VERSION,
				id: randomUUID(),
				method: "eraseEverything",
				params: {},
			}),
		], 2);
		assert.equal(unknown[0]?.type, "handshake-response");
		assert.equal(unknown[1]?.type, "protocol-error");
		assert.match(String(unknown[1]?.error), /Unknown Memory method/);
	} finally {
		await destroyService(service);
	}
});

test("resending a toggle after dropping its acknowledgement applies it once", async () => {
	const service = await createService();
	try {
		const sessionId = randomUUID();
		const requestId = randomUUID();
		const socket = await openRawConnection(service.socketPath);
		const handshake = await readMessages(socket, 1, () => {
			socket.write(encodeMemoryFrame({
				type: "handshake",
				version: MEMORY_PROTOCOL_VERSION,
				clientVersion: "test",
				sessionId,
				cwd: process.cwd(),
			}));
		});
		assert.equal(handshake[0]?.type, "handshake-response");
		socket.pause();
		socket.write(encodeMemoryFrame({
			type: "request",
			version: MEMORY_PROTOCOL_VERSION,
			id: requestId,
			method: "changeEnabled",
			params: { action: "toggle" },
		}));

		await waitFor(() => {
			const settings = new MemorySettingsStore(service.databasePath);
			try {
				return settings.isEnabled() ? null : true;
			} finally {
				settings.close();
			}
		});
		socket.destroy();

		const retry = await MemoryServerConnection.connectSocket(service.socketPath, options(sessionId));
		const status = await retry.requestWithId(requestId, "changeEnabled", { action: "toggle" });
		assert.equal(status.enabled, false);
		assert.equal((await retry.request("getStatus", {})).enabled, false);
		retry.close();
	} finally {
		await destroyService(service);
	}
});

test("framing handles split and coalesced frames", () => {
	const values: unknown[] = [];
	const decoder = new MemoryFrameDecoder((value) => values.push(value));
	const first = encodeMemoryFrame({ value: 1 });
	const second = encodeMemoryFrame({ value: 2 });
	decoder.push(first.subarray(0, 2));
	decoder.push(Buffer.concat([first.subarray(2), second]));
	decoder.finish();
	assert.deepEqual(values, [{ value: 1 }, { value: 2 }]);
});

async function collectMessages(socketPath: string, chunks: readonly Buffer[], count: number): Promise<Record<string, unknown>[]> {
	const socket = await openRawConnection(socketPath);
	try {
		return await readMessages(socket, count, () => {
			for (const chunk of chunks) socket.write(chunk);
		});
	} finally {
		socket.destroy();
	}
}

function readMessages(socket: Socket, count: number, send: () => void): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		const messages: Record<string, unknown>[] = [];
		const decoder = new MemoryFrameDecoder((value) => {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				reject(new Error("Server returned a non-object message"));
				return;
			}
			messages.push(value as Record<string, unknown>);
			if (messages.length === count) {
				cleanup();
				resolve(messages);
			}
		});
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error("Timed out waiting for server messages"));
		}, 5_000);
		const onData = (chunk: Buffer): void => {
			try {
				decoder.push(chunk);
			} catch (error) {
				cleanup();
				reject(error);
			}
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const cleanup = (): void => {
			clearTimeout(timeout);
			socket.off("data", onData);
			socket.off("error", onError);
		};
		socket.on("data", onData);
		socket.on("error", onError);
		send();
	});
}

function openRawConnection(socketPath: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

async function waitFor<T>(read: () => T | null): Promise<T> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== null) return value;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Condition was not met before timeout");
}
