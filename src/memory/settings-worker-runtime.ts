import { parentPort, workerData } from "node:worker_threads";
import { MemorySettingsStore } from "./settings.ts";
import type { MemorySettingsWorkerRequest, MemorySettingsWorkerResponse } from "./settings-protocol.ts";

const port = requireParentPort(parentPort);
const response = runSettingsOperation(validateRequest(workerData));
port.postMessage(response);
port.close();

function runSettingsOperation(request: MemorySettingsWorkerRequest): MemorySettingsWorkerResponse {
	let settings: MemorySettingsStore | undefined;
	try {
		settings = new MemorySettingsStore(request.databasePath);
		switch (request.operation) {
			case "get":
				break;
			case "set":
				settings.setEnabled(request.enabled);
				break;
			case "toggle":
				settings.toggleEnabled();
				break;
		}
		return { ok: true, status: settings.getStatus() };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		settings?.close();
	}
}

function validateRequest(value: unknown): MemorySettingsWorkerRequest {
	if (!isRecord(value) || typeof value.databasePath !== "string" || value.databasePath.trim().length === 0) {
		throw new Error("Memory settings worker received an invalid database path");
	}
	if (value.operation === "get" || value.operation === "toggle") {
		return { databasePath: value.databasePath, operation: value.operation };
	}
	if (value.operation === "set" && typeof value.enabled === "boolean") {
		return { databasePath: value.databasePath, operation: value.operation, enabled: value.enabled };
	}
	throw new Error("Memory settings worker received an invalid operation");
}

function requireParentPort(value: typeof parentPort): NonNullable<typeof parentPort> {
	if (!value) throw new Error("Memory settings worker requires a parent port");
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
