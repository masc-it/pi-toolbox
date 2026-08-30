import { Worker } from "node:worker_threads";
import type {
	MemorySettingsWorkerRequest,
	MemorySettingsWorkerResponse,
	MemoryStatus,
} from "./settings-protocol.ts";

const SETTINGS_OPERATION_TIMEOUT_MS = 30_000;

export class MemorySettingsClient {
	constructor(private readonly databasePath: string) {}

	async isEnabled(): Promise<boolean> {
		return (await this.getStatus()).enabled;
	}

	getStatus(): Promise<MemoryStatus> {
		return this.run({ databasePath: this.databasePath, operation: "get" });
	}

	async setEnabled(enabled: boolean): Promise<boolean> {
		return (await this.run({ databasePath: this.databasePath, operation: "set", enabled })).enabled;
	}

	async toggleEnabled(): Promise<boolean> {
		return (await this.run({ databasePath: this.databasePath, operation: "toggle" })).enabled;
	}

	private run(request: MemorySettingsWorkerRequest): Promise<MemoryStatus> {
		const worker = new Worker(new URL("./settings-worker-entry.mjs", import.meta.url), { workerData: request });
		return new Promise<MemoryStatus>((resolve, reject) => {
			let response: MemorySettingsWorkerResponse | undefined;
			let terminalError: Error | undefined;
			const timeout = setTimeout(() => {
				terminalError = new Error(`Memory settings operation timed out: ${request.operation}`);
				void worker.terminate();
			}, SETTINGS_OPERATION_TIMEOUT_MS);

			worker.once("message", (value: unknown) => {
				if (isMemorySettingsWorkerResponse(value)) {
					response = value;
				} else {
					terminalError = new Error("Memory settings worker returned an invalid response");
					void worker.terminate();
				}
			});
			worker.once("error", (error) => {
				terminalError = error;
			});
			worker.once("exit", (code) => {
				clearTimeout(timeout);
				if (terminalError) {
					reject(terminalError);
					return;
				}
				if (code !== 0) {
					reject(new Error(`Memory settings worker exited with code ${code}`));
					return;
				}
				if (!response) {
					reject(new Error("Memory settings worker exited without a response"));
					return;
				}
				if (!response.ok) {
					reject(new Error(response.error));
					return;
				}
				resolve(response.status);
			});
		});
	}
}

function isMemorySettingsWorkerResponse(value: unknown): value is MemorySettingsWorkerResponse {
	if (!isRecord(value) || typeof value.ok !== "boolean") return false;
	return value.ok ? isMemoryStatus(value.status) : typeof value.error === "string";
}

function isMemoryStatus(value: unknown): value is MemoryStatus {
	return isRecord(value) &&
		typeof value.enabled === "boolean" &&
		isCount(value.pending) &&
		isCount(value.processed) &&
		isCount(value.errors);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
