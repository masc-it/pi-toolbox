import { randomUUID } from "node:crypto";
import {
	closeSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";

const LOCK_RETRY_DELAY_MS = 100;
const LOCK_HEARTBEAT_INTERVAL_MS = 5_000;
const LOCK_STALE_AFTER_MS = 60_000;

interface LockOwner {
	pid: number;
	token: string;
}

export interface MemoryLock {
	release(): void;
}

export async function acquireMemoryLock(path: string, signal: AbortSignal): Promise<MemoryLock> {
	while (true) {
		if (signal.aborted) {
			throw new DOMException("Memory consumer stopped", "AbortError");
		}

		const owner = { pid: process.pid, token: randomUUID() };
		try {
			const descriptor = openSync(path, "wx", 0o600);
			try {
				writeFileSync(descriptor, JSON.stringify(owner), "utf8");
			} finally {
				closeSync(descriptor);
			}
			return maintainLock(path, owner);
		} catch (error) {
			if (!isAlreadyExists(error)) {
				throw error;
			}
			if (removeStaleLock(path)) {
				continue;
			}
			await waitForRetry(signal);
		}
	}
}

function maintainLock(path: string, owner: LockOwner): MemoryLock {
	const heartbeat = setInterval(() => {
		if (!isOwnedBy(path, owner.token)) {
			clearInterval(heartbeat);
			return;
		}
		const now = new Date();
		try {
			utimesSync(path, now, now);
		} catch (error) {
			if (!isMissingFile(error)) {
				clearInterval(heartbeat);
			}
		}
	}, LOCK_HEARTBEAT_INTERVAL_MS);
	heartbeat.unref();

	let released = false;
	return {
		release: () => {
			if (released) {
				return;
			}
			released = true;
			clearInterval(heartbeat);
			if (!isOwnedBy(path, owner.token)) {
				return;
			}
			try {
				unlinkSync(path);
			} catch (error) {
				if (!isMissingFile(error)) {
					throw error;
				}
			}
		},
	};
}

function removeStaleLock(path: string): boolean {
	let modifiedAt: number;
	try {
		modifiedAt = statSync(path).mtimeMs;
	} catch (error) {
		if (isMissingFile(error)) {
			return true;
		}
		throw new Error(`Unable to inspect Memory lock: ${path}`, { cause: error });
	}
	if (Date.now() - modifiedAt <= LOCK_STALE_AFTER_MS) {
		return false;
	}

	try {
		const latestModifiedAt = statSync(path).mtimeMs;
		if (Date.now() - latestModifiedAt <= LOCK_STALE_AFTER_MS) {
			return false;
		}
		unlinkSync(path);
		return true;
	} catch (error) {
		if (isMissingFile(error)) {
			return true;
		}
		throw new Error(`Unable to remove stale Memory lock: ${path}`, { cause: error });
	}
}

function isOwnedBy(path: string, token: string): boolean {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		if (isMissingFile(error)) {
			return false;
		}
		throw new Error(`Unable to read Memory lock: ${path}`, { cause: error });
	}
	return isRecord(value) && value.token === token;
}

function waitForRetry(signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, LOCK_RETRY_DELAY_MS);
		const abort = () => {
			clearTimeout(timer);
			reject(new DOMException("Memory consumer stopped", "AbortError"));
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

function isAlreadyExists(error: unknown): boolean {
	return isNodeError(error) && error.code === "EEXIST";
}

function isMissingFile(error: unknown): boolean {
	return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
