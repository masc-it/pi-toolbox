import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
	MEMORY_BATCH_MAX_FACTS,
	isMemorySender,
	isMemoryTopic,
	type MemorySender,
	type MemoryTopic,
} from "./config.ts";
import { canonicalizeWorkingDirectory } from "./paths.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pi_session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    sent_by TEXT NOT NULL
        CHECK (sent_by IN ('user', 'agent')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS memory_messages_session_idx
ON memory_messages (pi_session_id, id);

CREATE TABLE IF NOT EXISTS memory_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL
        REFERENCES memory_messages (id),
    pi_session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    sent_by TEXT NOT NULL
        CHECK (sent_by IN ('user', 'agent')),
    topic TEXT NOT NULL,
    fact TEXT NOT NULL,
    created_at TEXT NOT NULL,
    processed_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS memory_queue_pending_fifo_idx
ON memory_queue (id)
WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS memory_queue_pending_cwd_idx
ON memory_queue (cwd, id)
WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS memory_queue_message_idx
ON memory_queue (message_id, id);
`;

export interface NewMemoryMessage {
	piSessionId: string;
	cwd: string;
	sentBy: MemorySender;
	content: string;
	createdAt: string;
}

export interface StoredMemoryMessage extends NewMemoryMessage {
	id: bigint;
}

export interface ExtractedMemoryFact {
	topic: MemoryTopic;
	fact: string;
}

export interface MemoryQueueRow extends ExtractedMemoryFact {
	id: bigint;
	messageId: bigint;
	piSessionId: string;
	cwd: string;
	sentBy: MemorySender;
	createdAt: string;
	processedAt: string | null;
}

export interface PendingMemoryBatch {
	cwd: string;
	rows: MemoryQueueRow[];
}

interface DatabaseQueueRow {
	id: bigint;
	message_id: bigint;
	pi_session_id: string;
	cwd: string;
	sent_by: string;
	topic: string;
	fact: string;
	created_at: string;
	processed_at: string | null;
}

export class MemoryQueue {
	private readonly database: Database.Database;
	private readonly insertMessageStatement: Database.Statement;
	private readonly insertFactStatement: Database.Statement;
	private readonly oldestPendingCwdStatement: Database.Statement;
	private readonly pendingRowsForCwdStatement: Database.Statement;
	private readonly markProcessedStatement: Database.Statement;

	constructor(readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const databaseExisted = databaseFileExists(path);
		this.database = new Database(path);
		this.database.defaultSafeIntegers(true);
		this.database.pragma("foreign_keys = ON");
		this.database.pragma("journal_mode = WAL");
		this.database.pragma("busy_timeout = 5000");
		this.database.exec(SCHEMA);
		if (!databaseExisted) {
			chmodSync(path, 0o600);
		}

		this.insertMessageStatement = this.database.prepare(`
			INSERT INTO memory_messages (pi_session_id, cwd, sent_by, content, created_at)
			VALUES (@piSessionId, @cwd, @sentBy, @content, @createdAt)
		`);
		this.insertFactStatement = this.database.prepare(`
			INSERT INTO memory_queue (message_id, pi_session_id, cwd, sent_by, topic, fact, created_at)
			VALUES (@messageId, @piSessionId, @cwd, @sentBy, @topic, @fact, @createdAt)
		`);
		this.oldestPendingCwdStatement = this.database.prepare(`
			SELECT cwd
			FROM memory_queue
			WHERE processed_at IS NULL
			ORDER BY id
			LIMIT 1
		`);
		this.pendingRowsForCwdStatement = this.database.prepare(`
			SELECT id, message_id, pi_session_id, cwd, sent_by, topic, fact, created_at, processed_at
			FROM memory_queue
			WHERE processed_at IS NULL AND cwd = ?
			ORDER BY id
			LIMIT ?
		`);
		this.markProcessedStatement = this.database.prepare(`
			UPDATE memory_queue
			SET processed_at = ?
			WHERE id = ? AND processed_at IS NULL
		`);
	}

	storeMessage(message: NewMemoryMessage): StoredMemoryMessage {
		const validated = validateNewMessage(message);
		const result = this.insertMessageStatement.run(validated);
		return { id: result.lastInsertRowid as bigint, ...validated };
	}

	enqueueFacts(message: StoredMemoryMessage, facts: readonly ExtractedMemoryFact[]): bigint[] {
		if (message.id < 1n) {
			throw new Error(`Invalid Memory message ID: ${message.id}`);
		}
		const validatedFacts = facts.map(validateExtractedFact);
		const insertAll = this.database.transaction((rows: readonly ExtractedMemoryFact[]) =>
			rows.map((fact) =>
				this.insertFactStatement.run({
					messageId: message.id,
					piSessionId: message.piSessionId,
					cwd: message.cwd,
					sentBy: message.sentBy,
					topic: fact.topic,
					fact: fact.fact,
					createdAt: message.createdAt,
				}).lastInsertRowid as bigint,
			),
		);
		return insertAll(validatedFacts);
	}

	nextPendingBatch(maxRows = MEMORY_BATCH_MAX_FACTS): PendingMemoryBatch | null {
		if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MEMORY_BATCH_MAX_FACTS) {
			throw new Error(`Batch row limit must be between 1 and ${MEMORY_BATCH_MAX_FACTS}`);
		}

		const oldest = this.oldestPendingCwdStatement.get() as { cwd: string } | undefined;
		if (!oldest) {
			return null;
		}
		const rows = (this.pendingRowsForCwdStatement.all(oldest.cwd, maxRows) as DatabaseQueueRow[]).map(toQueueRow);
		if (rows.length === 0) {
			throw new Error(`Pending queue invariant failed for working directory: ${oldest.cwd}`);
		}
		return { cwd: oldest.cwd, rows };
	}

	markProcessed(ids: readonly bigint[], processedAt: string): void {
		if (ids.length === 0) {
			throw new Error("A processed batch must contain at least one queue row");
		}
		if (new Set(ids).size !== ids.length) {
			throw new Error("A processed batch must not contain duplicate queue row IDs");
		}
		assertIsoUtcTimestamp(processedAt, "Processed timestamp");

		const updateAll = this.database.transaction((rowIds: readonly bigint[]) => {
			for (const id of rowIds) {
				if (id < 1n) {
					throw new Error(`Invalid queue row ID: ${id}`);
				}
				const result = this.markProcessedStatement.run(processedAt, id);
				if (result.changes !== 1) {
					throw new Error(`Pending queue row does not exist: ${id}`);
				}
			}
		});
		updateAll(ids);
	}

	close(): void {
		this.database.close();
	}
}

function validateNewMessage(input: NewMemoryMessage): NewMemoryMessage {
	assertNonEmpty(input.piSessionId, "Pi session ID");
	if (!isMemorySender(input.sentBy)) {
		throw new Error(`Invalid Memory sender: ${String(input.sentBy)}`);
	}
	assertNonEmpty(input.content, "Message content");
	assertIsoUtcTimestamp(input.createdAt, "Creation timestamp");

	return {
		...input,
		piSessionId: input.piSessionId.trim(),
		cwd: canonicalizeWorkingDirectory(input.cwd),
		content: input.content,
	};
}

function validateExtractedFact(input: ExtractedMemoryFact): ExtractedMemoryFact {
	if (!isMemoryTopic(input.topic)) {
		throw new Error(`Invalid Memory topic: ${String(input.topic)}`);
	}
	assertNonEmpty(input.fact, "Fact");
	return { topic: input.topic, fact: input.fact.trim() };
}

function toQueueRow(row: DatabaseQueueRow): MemoryQueueRow {
	if (!isMemorySender(row.sent_by)) {
		throw new Error(`Queue contains an invalid sender: ${row.sent_by}`);
	}
	if (!isMemoryTopic(row.topic)) {
		throw new Error(`Queue contains an invalid topic: ${row.topic}`);
	}
	assertIsoUtcTimestamp(row.created_at, "Queue creation timestamp");
	if (row.processed_at !== null) {
		assertIsoUtcTimestamp(row.processed_at, "Queue processed timestamp");
	}

	return {
		id: row.id,
		messageId: row.message_id,
		piSessionId: row.pi_session_id,
		cwd: row.cwd,
		sentBy: row.sent_by,
		topic: row.topic,
		fact: row.fact,
		createdAt: row.created_at,
		processedAt: row.processed_at,
	};
}

function assertNonEmpty(value: string, label: string): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must not be empty`);
	}
}

function assertIsoUtcTimestamp(value: string, label: string): void {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
		throw new Error(`${label} must be an ISO 8601 UTC value`);
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new Error(`${label} must be an ISO 8601 UTC value`);
	}
	const canonical = parsed.toISOString();
	if (value !== canonical && value !== canonical.replace(".000Z", "Z")) {
		throw new Error(`${label} must be an ISO 8601 UTC value`);
	}
}

function databaseFileExists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
