import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { MemoryConfig, MemoryServicePaths } from "../config.ts";
import { getPiInvocation, type PiInvocation } from "../../pi/invocation.ts";

const SERVER_READY_TIMEOUT_MS = 10_000;
const SOCKET_CONNECT_TIMEOUT_MS = 500;
const SOCKET_RETRY_DELAY_MS = 50;

export async function connectToMemoryService(
	config: MemoryConfig,
	paths: MemoryServicePaths,
	piInvocation: PiInvocation = getPiInvocation([]),
): Promise<Socket> {
	mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
	chmodSync(config.dataDirectory, 0o700);
	const connected = await tryConnect(paths.socketPath);
	if (connected) return connected;
	assertNoLegacyWorker(paths.legacyWorkerLockPath);

	const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const lock = tryAcquireStartupLock(paths.startupLockPath);
		if (lock !== null) {
			try {
				const racedConnection = await tryConnect(paths.socketPath);
				if (racedConnection) return racedConnection;
				rmSync(paths.socketPath, { force: true });
				launchDetachedServer(config, piInvocation, paths.socketPath, paths.logPath);
				return await waitForSocket(paths.socketPath, deadline);
			} finally {
				closeSync(lock);
				rmSync(paths.startupLockPath, { force: true });
			}
		}

		removeDeadStartupLock(paths.startupLockPath);
		const socket = await tryConnect(paths.socketPath);
		if (socket) return socket;
		await delay(SOCKET_RETRY_DELAY_MS);
	}
	throw new Error(`Memory server did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}

async function waitForSocket(socketPath: string, deadline: number): Promise<Socket> {
	while (Date.now() < deadline) {
		const socket = await tryConnect(socketPath);
		if (socket) return socket;
		await delay(SOCKET_RETRY_DELAY_MS);
	}
	throw new Error(`Memory server did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}

function launchDetachedServer(
	config: MemoryConfig,
	piInvocation: PiInvocation,
	socketPath: string,
	logPath: string,
): void {
	const entryPath = fileURLToPath(new URL("./entry.mjs", import.meta.url));
	const log = openSync(logPath, "a", 0o600);
	try {
		const child = spawn(process.execPath, [entryPath], {
			detached: true,
			stdio: ["ignore", log, log],
			env: {
				...process.env,
				PI_TOOLBOX_MEMORY_SERVER_CONFIG: JSON.stringify({
					socketPath,
					databasePath: config.databasePath,
					knowledgeBaseDirectory: config.knowledgeBaseDirectory,
					piInvocation,
				}),
			},
		});
		child.once("error", () => undefined);
		child.unref();
	} finally {
		closeSync(log);
	}
}

function assertNoLegacyWorker(path: string): void {
	if (existsSync(path)) {
		throw new Error(`Close Pi sessions using the old Memory extension and remove its lock before starting Memory: ${path}`);
	}
}

function tryAcquireStartupLock(path: string): number | null {
	let descriptor: number;
	try {
		descriptor = openSync(path, "wx", 0o600);
	} catch (error) {
		if (isNodeError(error) && error.code === "EEXIST") return null;
		throw error;
	}
	try {
		writeFileSync(descriptor, `${process.pid}\n`, "utf8");
		return descriptor;
	} catch (error) {
		closeSync(descriptor);
		rmSync(path, { force: true });
		throw error;
	}
}

function removeDeadStartupLock(path: string): void {
	let owner: number;
	try {
		const value = readFileSync(path, "utf8").trim();
		owner = Number(value);
		if (!Number.isSafeInteger(owner) || owner < 1) {
			rmSync(path, { force: true });
			return;
		}
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return;
		throw error;
	}
	try {
		process.kill(owner, 0);
	} catch (error) {
		if (isNodeError(error) && error.code === "ESRCH") rmSync(path, { force: true });
	}
}

function tryConnect(socketPath: string): Promise<Socket | null> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		const timeout = setTimeout(() => socket.destroy(new Error("Memory socket connection timed out")), SOCKET_CONNECT_TIMEOUT_MS);
		socket.once("connect", () => {
			clearTimeout(timeout);
			socket.removeAllListeners("error");
			resolve(socket);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timeout);
			socket.destroy();
			if (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.message === "Memory socket connection timed out") {
				resolve(null);
			} else {
				reject(error);
			}
		});
	});
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
