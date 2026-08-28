import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
	MEMORY_BATCH_MAX_FACTS,
	isMemoryFactSupport,
	isMemorySender,
	isMemoryTopic,
	type MemoryFactSupport,
	type MemorySender,
	type MemoryTopic,
} from "./config.ts";
import { canonicalizeWorkingDirectory } from "./paths.ts";

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_exchanges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pi_session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    started_at TEXT NOT NULL,
    settled_at TEXT,
    extracted_at TEXT,
    CHECK (extracted_at IS NULL OR settled_at IS NOT NULL)
) STRICT;

CREATE INDEX IF NOT EXISTS memory_exchanges_pending_extraction_idx
ON memory_exchanges (id)
WHERE settled_at IS NOT NULL AND extracted_at IS NULL;

CREATE TABLE IF NOT EXISTS memory_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange_id INTEGER NOT NULL
        REFERENCES memory_exchanges (id),
    position INTEGER NOT NULL
        CHECK (position >= 0),
    sent_by TEXT NOT NULL
        CHECK (sent_by IN ('user', 'agent')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (exchange_id, position)
) STRICT;

CREATE INDEX IF NOT EXISTS memory_messages_exchange_idx
ON memory_messages (exchange_id, position);

CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    msg TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memory_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange_id INTEGER NOT NULL
        REFERENCES memory_exchanges (id),
    pi_session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    supported_by TEXT NOT NULL
        CHECK (supported_by IN ('user', 'agent', 'both')),
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

CREATE INDEX IF NOT EXISTS memory_queue_exchange_idx
ON memory_queue (exchange_id, id);
`;

const RESET_SCHEMA = `
DROP TABLE IF EXISTS memory_queue;
DROP TABLE IF EXISTS memory_messages;
DROP TABLE IF EXISTS memory_exchanges;
DROP TABLE IF EXISTS logs;
`;

export interface NewMemoryExchange {
	piSessionId: string;
	cwd: string;
	startedAt: string;
}

export interface OpenMemoryExchange extends NewMemoryExchange {
	id: bigint;
}

export interface MemoryExchangeMessage {
	id: bigint;
	exchangeId: bigint;
	position: number;
	sentBy: MemorySender;
	content: string;
	createdAt: string;
}

export interface ExtractableMemoryExchange extends OpenMemoryExchange {
	settledAt: string;
	messages: MemoryExchangeMessage[];
}

export interface ExtractedMemoryFact {
	supportedBy: MemoryFactSupport;
	topic: MemoryTopic;
	fact: string;
}

export interface MemoryQueueRow extends ExtractedMemoryFact {
	id: bigint;
	exchangeId: bigint;
	piSessionId: string;
	cwd: string;
	createdAt: string;
	processedAt: string | null;
}

export interface PendingMemoryBatch {
	cwd: string;
	rows: MemoryQueueRow[];
}

interface DatabaseExchangeRow {
	id: bigint;
	pi_session_id: string;
	cwd: string;
	started_at: string;
	settled_at: string;
}

interface DatabaseMessageRow {
	id: bigint;
	exchange_id: bigint;
	position: bigint;
	sent_by: string;
	content: string;
	created_at: string;
}

interface DatabaseQueueRow {
	id: bigint;
	exchange_id: bigint;
	pi_session_id: string;
	cwd: string;
	supported_by: string;
	topic: string;
	fact: string;
	created_at: string;
	processed_at: string | null;
}

export class MemoryQueue {
	private readonly database: Database.Database;
	private readonly insertExchangeStatement: Database.Statement;
	private readonly insertMessageStatement: Database.Statement;
	private readonly settleExchangeStatement: Database.Statement;
	private readonly oldestUnextractedExchangeStatement: Database.Statement;
	private readonly exchangeMessagesStatement: Database.Statement;
	private readonly markExtractedStatement: Database.Statement;
	private readonly insertFactStatement: Database.Statement;
	private readonly insertLogStatement: Database.Statement;
	private readonly pendingCwdsStatement: Database.Statement;
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
		initializeSchema(this.database);
		if (!databaseExisted) {
			chmodSync(path, 0o600);
		}

		this.insertExchangeStatement = this.database.prepare(`
			INSERT INTO memory_exchanges (pi_session_id, cwd, started_at)
			VALUES (@piSessionId, @cwd, @startedAt)
		`);
		this.insertMessageStatement = this.database.prepare(`
			INSERT INTO memory_messages (exchange_id, position, sent_by, content, created_at)
			SELECT @exchangeId,
			       COALESCE((SELECT MAX(position) + 1 FROM memory_messages WHERE exchange_id = @exchangeId), 0),
			       @sentBy,
			       @content,
			       @createdAt
			FROM memory_exchanges
			WHERE id = @exchangeId AND settled_at IS NULL
		`);
		this.settleExchangeStatement = this.database.prepare(`
			UPDATE memory_exchanges
			SET settled_at = ?
			WHERE id = ? AND settled_at IS NULL
		`);
		this.oldestUnextractedExchangeStatement = this.database.prepare(`
			SELECT id, pi_session_id, cwd, started_at, settled_at
			FROM memory_exchanges
			WHERE settled_at IS NOT NULL AND extracted_at IS NULL
			ORDER BY id
			LIMIT 1
		`);
		this.exchangeMessagesStatement = this.database.prepare(`
			SELECT id, exchange_id, position, sent_by, content, created_at
			FROM memory_messages
			WHERE exchange_id = ?
			ORDER BY position
		`);
		this.markExtractedStatement = this.database.prepare(`
			UPDATE memory_exchanges
			SET extracted_at = ?
			WHERE id = ? AND settled_at IS NOT NULL AND extracted_at IS NULL
		`);
		this.insertFactStatement = this.database.prepare(`
			INSERT INTO memory_queue (exchange_id, pi_session_id, cwd, supported_by, topic, fact, created_at)
			VALUES (@exchangeId, @piSessionId, @cwd, @supportedBy, @topic, @fact, @createdAt)
		`);
		this.insertLogStatement = this.database.prepare(`
			INSERT INTO logs (msg, created_at)
			VALUES (?, ?)
		`);
		this.pendingCwdsStatement = this.database.prepare(`
			SELECT cwd, MIN(id) AS first_id
			FROM memory_queue
			WHERE processed_at IS NULL
			GROUP BY cwd
			ORDER BY first_id
		`);
		this.pendingRowsForCwdStatement = this.database.prepare(`
			SELECT id, exchange_id, pi_session_id, cwd, supported_by, topic, fact, created_at, processed_at
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

	startExchange(exchange: NewMemoryExchange, userContent: string): OpenMemoryExchange {
		const validated = validateNewExchange(exchange);
		assertNonEmpty(userContent, "User message content");
		const start = this.database.transaction(() => {
			const result = this.insertExchangeStatement.run(validated);
			const stored = { id: result.lastInsertRowid as bigint, ...validated };
			this.appendMessage(stored.id, "user", userContent, stored.startedAt);
			return stored;
		});
		return start();
	}

	appendMessage(
		exchangeId: bigint,
		sentBy: MemorySender,
		content: string,
		createdAt: string,
	): MemoryExchangeMessage {
		if (exchangeId < 1n) {
			throw new Error(`Invalid Memory exchange ID: ${exchangeId}`);
		}
		if (!isMemorySender(sentBy)) {
			throw new Error(`Invalid Memory sender: ${String(sentBy)}`);
		}
		assertNonEmpty(content, "Message content");
		assertIsoUtcTimestamp(createdAt, "Message creation timestamp");

		const result = this.insertMessageStatement.run({ exchangeId, sentBy, content, createdAt });
		if (result.changes !== 1) {
			throw new Error(`Open Memory exchange does not exist: ${exchangeId}`);
		}
		const row = this.database.prepare(`
			SELECT id, exchange_id, position, sent_by, content, created_at
			FROM memory_messages
			WHERE id = ?
		`).get(result.lastInsertRowid) as DatabaseMessageRow;
		return toExchangeMessage(row);
	}

	settleExchange(exchangeId: bigint, settledAt: string): void {
		if (exchangeId < 1n) {
			throw new Error(`Invalid Memory exchange ID: ${exchangeId}`);
		}
		assertIsoUtcTimestamp(settledAt, "Exchange settlement timestamp");
		const result = this.settleExchangeStatement.run(settledAt, exchangeId);
		if (result.changes !== 1) {
			throw new Error(`Open Memory exchange does not exist: ${exchangeId}`);
		}
	}

	nextUnextractedExchange(): ExtractableMemoryExchange | null {
		const row = this.oldestUnextractedExchangeStatement.get() as DatabaseExchangeRow | undefined;
		if (!row) {
			return null;
		}
		const exchange = toExtractableExchange(row);
		const messages = (this.exchangeMessagesStatement.all(row.id) as DatabaseMessageRow[]).map(toExchangeMessage);
		if (messages.length === 0 || !messages.some((message) => message.sentBy === "user")) {
			throw new Error(`Settled Memory exchange ${row.id} has no user message`);
		}
		return { ...exchange, messages };
	}

	completeExtraction(
		exchange: ExtractableMemoryExchange,
		facts: readonly ExtractedMemoryFact[],
		extractedAt: string,
	): bigint[] {
		assertIsoUtcTimestamp(extractedAt, "Extraction timestamp");
		const validatedFacts = facts.map(validateExtractedFact);
		const complete = this.database.transaction(() => {
			const marked = this.markExtractedStatement.run(extractedAt, exchange.id);
			if (marked.changes === 0) {
				return [];
			}
			return validatedFacts.map((fact) =>
				this.insertFactStatement.run({
					exchangeId: exchange.id,
					piSessionId: exchange.piSessionId,
					cwd: exchange.cwd,
					supportedBy: fact.supportedBy,
					topic: fact.topic,
					fact: fact.fact,
					createdAt: exchange.settledAt,
				}).lastInsertRowid as bigint,
			);
		});
		return complete();
	}

	logError(msg: string, createdAt: string): void {
		assertNonEmpty(msg, "Log message");
		assertIsoUtcTimestamp(createdAt, "Log creation timestamp");
		this.insertLogStatement.run(msg, createdAt);
	}

	nextPendingBatch(maxRows = MEMORY_BATCH_MAX_FACTS, excludedCwds: ReadonlySet<string> = new Set()): PendingMemoryBatch | null {
		if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MEMORY_BATCH_MAX_FACTS) {
			throw new Error(`Batch row limit must be between 1 and ${MEMORY_BATCH_MAX_FACTS}`);
		}

		const pendingCwds = this.pendingCwdsStatement.all() as Array<{ cwd: string }>;
		const oldest = pendingCwds.find((row) => !excludedCwds.has(row.cwd));
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

function initializeSchema(database: Database.Database): void {
	const value = database.pragma("user_version", { simple: true }) as number | bigint;
	const version = Number(value);
	if (version === SCHEMA_VERSION) {
		database.exec(SCHEMA);
		return;
	}

	const reset = database.transaction(() => {
		database.exec(RESET_SCHEMA);
		database.exec(SCHEMA);
		database.pragma(`user_version = ${SCHEMA_VERSION}`);
	});
	reset();
}

function validateNewExchange(input: NewMemoryExchange): NewMemoryExchange {
	assertNonEmpty(input.piSessionId, "Pi session ID");
	assertIsoUtcTimestamp(input.startedAt, "Exchange start timestamp");
	return {
		piSessionId: input.piSessionId.trim(),
		cwd: canonicalizeWorkingDirectory(input.cwd),
		startedAt: input.startedAt,
	};
}

function validateExtractedFact(input: ExtractedMemoryFact): ExtractedMemoryFact {
	if (!isMemoryFactSupport(input.supportedBy)) {
		throw new Error(`Invalid Memory fact support: ${String(input.supportedBy)}`);
	}
	if (!isMemoryTopic(input.topic)) {
		throw new Error(`Invalid Memory topic: ${String(input.topic)}`);
	}
	assertNonEmpty(input.fact, "Fact");
	return { supportedBy: input.supportedBy, topic: input.topic, fact: input.fact.trim() };
}

function toExtractableExchange(row: DatabaseExchangeRow): Omit<ExtractableMemoryExchange, "messages"> {
	assertIsoUtcTimestamp(row.started_at, "Exchange start timestamp");
	assertIsoUtcTimestamp(row.settled_at, "Exchange settlement timestamp");
	return {
		id: row.id,
		piSessionId: row.pi_session_id,
		cwd: row.cwd,
		startedAt: row.started_at,
		settledAt: row.settled_at,
	};
}

function toExchangeMessage(row: DatabaseMessageRow): MemoryExchangeMessage {
	if (!isMemorySender(row.sent_by)) {
		throw new Error(`Memory exchange contains an invalid sender: ${row.sent_by}`);
	}
	const position = Number(row.position);
	if (!Number.isSafeInteger(position) || position < 0) {
		throw new Error(`Memory exchange contains an invalid message position: ${row.position}`);
	}
	assertNonEmpty(row.content, "Stored message content");
	assertIsoUtcTimestamp(row.created_at, "Stored message creation timestamp");
	return {
		id: row.id,
		exchangeId: row.exchange_id,
		position,
		sentBy: row.sent_by,
		content: row.content,
		createdAt: row.created_at,
	};
}

function toQueueRow(row: DatabaseQueueRow): MemoryQueueRow {
	if (!isMemoryFactSupport(row.supported_by)) {
		throw new Error(`Queue contains invalid Memory fact support: ${row.supported_by}`);
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
		exchangeId: row.exchange_id,
		piSessionId: row.pi_session_id,
		cwd: row.cwd,
		supportedBy: row.supported_by,
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
