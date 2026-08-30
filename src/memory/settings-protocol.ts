export interface MemoryStatus {
	enabled: boolean;
	pending: number;
	processed: number;
	errors: number;
}

export type MemorySettingsWorkerRequest =
	| { databasePath: string; operation: "get" }
	| { databasePath: string; operation: "set"; enabled: boolean }
	| { databasePath: string; operation: "toggle" };

export type MemorySettingsWorkerResponse =
	| { ok: true; status: MemoryStatus }
	| { ok: false; error: string };
