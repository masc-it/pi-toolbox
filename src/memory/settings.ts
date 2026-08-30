import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { MemoryStatus } from "./settings-protocol.ts";

const SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
) STRICT;

INSERT OR IGNORE INTO memory_settings (id, enabled)
VALUES (1, 1);
`;

export class MemorySettingsStore {
	private readonly database: Database.Database;
	private readonly readEnabledStatement: Database.Statement;
	private readonly writeEnabledStatement: Database.Statement;
	private readonly toggleEnabledStatement: Database.Statement;

	constructor(readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const databaseExisted = databaseFileExists(path);
		this.database = new Database(path);
		this.database.pragma("busy_timeout = 5000");
		this.database.exec(SETTINGS_SCHEMA);
		if (!databaseExisted) chmodSync(path, 0o600);

		this.readEnabledStatement = this.database.prepare(`
			SELECT enabled
			FROM memory_settings
			WHERE id = 1
		`);
		this.writeEnabledStatement = this.database.prepare(`
			UPDATE memory_settings
			SET enabled = ?
			WHERE id = 1
			RETURNING enabled
		`);
		this.toggleEnabledStatement = this.database.prepare(`
			UPDATE memory_settings
			SET enabled = 1 - enabled
			WHERE id = 1
			RETURNING enabled
		`);
	}

	isEnabled(): boolean {
		return toEnabled(this.readEnabledStatement.get());
	}

	getStatus(): MemoryStatus {
		const enabled = this.isEnabled();
		const operationalTableCount = this.count(`
			SELECT COUNT(*) AS count
			FROM sqlite_schema
			WHERE type = 'table'
			  AND name IN ('memory_exchanges', 'memory_queue', 'logs')
		`);
		if (operationalTableCount !== 3) return { enabled, pending: 0, processed: 0, errors: 0 };

		const pendingExchanges = this.count(`
			SELECT COUNT(*) AS count
			FROM memory_exchanges
			WHERE settled_at IS NOT NULL AND extracted_at IS NULL
		`);
		const pendingFacts = this.count(`
			SELECT COUNT(*) AS count
			FROM memory_queue
			WHERE processed_at IS NULL
		`);
		const pending = pendingExchanges + pendingFacts;
		if (!Number.isSafeInteger(pending)) throw new Error("Memory pending count exceeds the supported range");
		return {
			enabled,
			pending,
			processed: this.count(`
				SELECT COUNT(*) AS count
				FROM memory_queue
				WHERE processed_at IS NOT NULL
			`),
			errors: this.count(`
				SELECT COUNT(*) AS count
				FROM logs
			`),
		};
	}

	setEnabled(enabled: boolean): boolean {
		return toEnabled(this.writeEnabledStatement.get(enabled ? 1 : 0));
	}

	toggleEnabled(): boolean {
		return toEnabled(this.toggleEnabledStatement.get());
	}

	close(): void {
		this.database.close();
	}

	private count(sql: string): number {
		return toCount(this.database.prepare(sql).get());
	}
}

function toEnabled(value: unknown): boolean {
	if (!isRecord(value) || (value.enabled !== 0 && value.enabled !== 1)) {
		throw new Error("Memory settings contain an invalid enabled value");
	}
	return value.enabled === 1;
}

function toCount(value: unknown): number {
	if (!isRecord(value) || !Number.isSafeInteger(value.count) || (value.count as number) < 0) {
		throw new Error("Memory database returned an invalid count");
	}
	return value.count as number;
}

function databaseFileExists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
