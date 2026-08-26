import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const LOCK_RETRY_DELAY_MS = 100;

export interface MemoryLock {
	release(): void;
}

export async function acquireMemoryLock(path: string, signal: AbortSignal): Promise<MemoryLock> {
	while (true) {
		if (signal.aborted) {
			throw new DOMException("Memory consumer stopped", "AbortError");
		}

		try {
			const descriptor = openSync(path, "wx", 0o600);
			try {
				writeFileSync(descriptor, JSON.stringify({ pid: process.pid }), "utf8");
			} finally {
				closeSync(descriptor);
			}
			let released = false;
			return {
				release: () => {
					if (!released) {
						released = true;
						unlinkSync(path);
					}
				},
			};
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

function removeStaleLock(path: string): boolean {
	let owner: unknown;
	try {
		owner = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		if (isMissingFile(error)) {
			return true;
		}
		throw new Error(`Unable to read Memory lock: ${path}`, { cause: error });
	}
	if (!isRecord(owner) || typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid < 1) {
		throw new Error(`Memory lock contains an invalid owner: ${path}`);
	}
	if (isProcessRunning(owner.pid)) {
		return false;
	}

	try {
		unlinkSync(path);
		return true;
	} catch (error) {
		if (isMissingFile(error)) {
			return true;
		}
		throw error;
	}
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ESRCH") {
			return false;
		}
		if (isNodeError(error) && error.code === "EPERM") {
			return true;
		}
		throw error;
	}
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
