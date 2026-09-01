import type Database from "better-sqlite3";

const REQUEST_RECEIPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_request_receipts (
    request_id TEXT PRIMARY KEY,
    pi_session_id TEXT NOT NULL,
    method TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;
`;

export interface MemoryRequestIdentity {
	id: string;
	sessionId: string;
	method: string;
	fingerprint: string;
}

interface ReceiptRow {
	pi_session_id: string;
	method: string;
	fingerprint: string;
	result_json: string;
}

export class MemoryRequestReceipts {
	private readonly findStatement: Database.Statement;
	private readonly insertStatement: Database.Statement;

	constructor(database: Database.Database) {
		database.exec(REQUEST_RECEIPT_SCHEMA);
		this.findStatement = database.prepare(`
			SELECT pi_session_id, method, fingerprint, result_json
			FROM memory_request_receipts
			WHERE request_id = ?
		`);
		this.insertStatement = database.prepare(`
			INSERT INTO memory_request_receipts (
				request_id, pi_session_id, method, fingerprint, result_json, created_at
			)
			VALUES (@id, @sessionId, @method, @fingerprint, @resultJson, @createdAt)
		`);
	}

	find(identity: MemoryRequestIdentity): { found: false } | { found: true; result: unknown } {
		validateIdentity(identity);
		const row = this.findStatement.get(identity.id) as ReceiptRow | undefined;
		if (!row) return { found: false };
		if (
			row.pi_session_id !== identity.sessionId ||
			row.method !== identity.method ||
			row.fingerprint !== identity.fingerprint
		) {
			throw new Error("Memory request ID was reused for a different request");
		}
		try {
			return { found: true, result: JSON.parse(row.result_json) as unknown };
		} catch (error) {
			throw new Error(`Memory request receipt ${identity.id} contains invalid JSON`, { cause: error });
		}
	}

	insert(identity: MemoryRequestIdentity, result: unknown, createdAt: string): void {
		validateIdentity(identity);
		const resultJson = JSON.stringify(result);
		if (resultJson === undefined) throw new Error("Memory request result is not JSON serializable");
		this.insertStatement.run({ ...identity, resultJson, createdAt });
	}
}

export function createMemoryRequestIdentity(
	id: string,
	sessionId: string,
	method: string,
	params: unknown,
): MemoryRequestIdentity {
	return { id, sessionId, method, fingerprint: JSON.stringify({ method, params }) };
}

function validateIdentity(identity: MemoryRequestIdentity): void {
	if (
		identity.id.length === 0 ||
		identity.sessionId.length === 0 ||
		identity.method.length === 0 ||
		identity.fingerprint.length === 0
	) {
		throw new Error("Memory request identity is invalid");
	}
}
