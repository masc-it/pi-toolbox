import { chmodSync, constants, copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
	MEMORY_BATCH_MAX_FACTS,
	isMemoryCollectionPath,
	isMemoryFactSupport,
	isMemorySender,
	type MemoryCollectionPath,
	type MemoryFactSupport,
	type MemorySender,
} from "./config.ts";
import { canonicalizeWorkingDirectory } from "./paths.ts";
import {
	MemoryRequestReceipts,
	REQUEST_RECEIPT_SCHEMA,
	type MemoryRequestIdentity,
} from "./request-receipts.ts";

export const MEMORY_SCHEMA_VERSION = 4;
const PRE_CLIENT_SERVER_SCHEMA_VERSION = 3;

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

CREATE UNIQUE INDEX IF NOT EXISTS memory_exchanges_open_session_idx
ON memory_exchanges (pi_session_id)
WHERE settled_at IS NULL;

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
    collection_path TEXT NOT NULL,
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
	collectionPath: MemoryCollectionPath;
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

interface DatabaseOpenExchangeRow {
	id: bigint;
	pi_session_id: string;
	cwd: string;
	started_at: string;
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
	collection_path: string;
	fact: string;
	created_at: string;
	processed_at: string | null;
}

export class MemoryQueue {
	private readonly database: Database.Database;
	private readonly insertExchangeStatement: Database.Statement;
	private readonly insertMessageStatement: Database.Statement;
	private readonly openExchangeForSessionStatement: Database.Statement;
	private readonly settleExchangeStatement: Database.Statement;
	private readonly oldestUnextractedExchangeStatement: Database.Statement;
	private readonly exchangeMessagesStatement: Database.Statement;
	private readonly markExtractedStatement: Database.Statement;
	private readonly insertFactStatement: Database.Statement;
	private readonly insertLogStatement: Database.Statement;
	private readonly pendingCwdsStatement: Database.Statement;
	private readonly pendingRowsForCwdStatement: Database.Statement;
	private readonly markProcessedStatement: Database.Statement;
	private readonly receipts: MemoryRequestReceipts;

	constructor(readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const databaseExisted = databaseFileExists(path);
		this.database = new Database(path);
		this.database.defaultSafeIntegers(true);
		this.database.pragma("foreign_keys = ON");
		this.database.pragma("journal_mode = WAL");
		this.database.pragma("busy_timeout = 5000");
		initializeSchema(this.database, path, databaseExisted);
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
		this.openExchangeForSessionStatement = this.database.prepare(`
			SELECT id, pi_session_id, cwd, started_at
			FROM memory_exchanges
			WHERE pi_session_id = ? AND settled_at IS NULL
			ORDER BY id
			LIMIT 2
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
			INSERT INTO memory_queue (exchange_id, pi_session_id, cwd, supported_by, collection_path, fact, created_at)
			VALUES (@exchangeId, @piSessionId, @cwd, @supportedBy, @collectionPath, @fact, @createdAt)
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
			SELECT id, exchange_id, pi_session_id, cwd, supported_by, collection_path, fact, created_at, processed_at
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
		this.receipts = new MemoryRequestReceipts(this.database);
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

	recordRequestResult(
		request: MemoryRequestIdentity,
		result: null | boolean,
		createdAt: string,
	): null | boolean {
		assertIsoUtcTimestamp(createdAt, "Request completion timestamp");
		const record = this.database.transaction(() => {
			const receipt = this.receipts.find(request);
			if (receipt.found) {
				if (receipt.result !== null && typeof receipt.result !== "boolean") {
					throw new Error("Memory request receipt has an invalid result");
				}
				return receipt.result;
			}
			this.receipts.insert(request, result, createdAt);
			return result;
		});
		return record();
	}

	captureUserForSession(
		request: MemoryRequestIdentity,
		exchange: NewMemoryExchange,
		content: string,
	): null {
		const capture = this.database.transaction(() => {
			const receipt = this.receipts.find(request);
			if (receipt.found) {
				if (receipt.result !== null) throw new Error("Memory capture receipt has an invalid result");
				return null;
			}
			const validated = validateNewExchange(exchange);
			assertNonEmpty(content, "User message content");
			const open = this.openExchangeForSession(validated.piSessionId);
			if (open) {
				if (open.cwd !== validated.cwd) {
					throw new Error(`Open Memory exchange uses a different working directory: ${open.cwd}`);
				}
				this.appendMessage(open.id, "user", content, validated.startedAt);
			} else {
				this.startExchange(validated, content);
			}
			this.receipts.insert(request, null, validated.startedAt);
			return null;
		});
		return capture();
	}

	captureAgentForSession(
		request: MemoryRequestIdentity,
		piSessionId: string,
		content: string,
		createdAt: string,
	): null {
		const capture = this.database.transaction(() => {
			const receipt = this.receipts.find(request);
			if (receipt.found) {
				if (receipt.result !== null) throw new Error("Memory capture receipt has an invalid result");
				return null;
			}
			assertNonEmpty(piSessionId, "Pi session ID");
			assertNonEmpty(content, "Agent message content");
			assertIsoUtcTimestamp(createdAt, "Agent message creation timestamp");
			const open = this.openExchangeForSession(piSessionId);
			if (open) this.appendMessage(open.id, "agent", content, createdAt);
			this.receipts.insert(request, null, createdAt);
			return null;
		});
		return capture();
	}

	settleSessionExchange(
		request: MemoryRequestIdentity,
		piSessionId: string,
		settledAt: string,
	): boolean {
		const settle = this.database.transaction(() => {
			const receipt = this.receipts.find(request);
			if (receipt.found) {
				if (typeof receipt.result !== "boolean") throw new Error("Memory settlement receipt has an invalid result");
				return receipt.result;
			}
			const settled = this.settleOpenExchangeForSession(piSessionId, settledAt);
			this.receipts.insert(request, settled, settledAt);
			return settled;
		});
		return settle();
	}

	settleOpenExchangeForSession(piSessionId: string, settledAt: string): boolean {
		assertNonEmpty(piSessionId, "Pi session ID");
		assertIsoUtcTimestamp(settledAt, "Exchange settlement timestamp");
		const open = this.openExchangeForSession(piSessionId);
		if (!open) return false;
		this.settleExchange(open.id, settledAt);
		return true;
	}

	openExchangeForSession(piSessionId: string): OpenMemoryExchange | null {
		assertNonEmpty(piSessionId, "Pi session ID");
		const rows = this.openExchangeForSessionStatement.all(piSessionId) as DatabaseOpenExchangeRow[];
		if (rows.length > 1) throw new Error(`Pi session has multiple open Memory exchanges: ${piSessionId}`);
		const row = rows[0];
		if (!row) return null;
		assertIsoUtcTimestamp(row.started_at, "Exchange start timestamp");
		return {
			id: row.id,
			piSessionId: row.pi_session_id,
			cwd: row.cwd,
			startedAt: row.started_at,
		};
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
					collectionPath: fact.collectionPath,
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

function initializeSchema(database: Database.Database, path: string, databaseExisted: boolean): void {
	const value = database.pragma("user_version", { simple: true }) as number | bigint;
	const version = Number(value);
	if (version === MEMORY_SCHEMA_VERSION) {
		database.exec(SCHEMA);
		database.exec(REQUEST_RECEIPT_SCHEMA);
		return;
	}
	if (version === 0 && !hasOperationalTables(database)) {
		const initialize = database.transaction(() => {
			database.exec(SCHEMA);
			database.exec(REQUEST_RECEIPT_SCHEMA);
			database.pragma(`user_version = ${MEMORY_SCHEMA_VERSION}`);
		});
		initialize();
		return;
	}
	if (version !== PRE_CLIENT_SERVER_SCHEMA_VERSION || !databaseExisted) {
		throw new Error(`Unsupported Memory database schema version: ${version}`);
	}

	createMigrationBackup(database, path);
	const migrate = database.transaction(() => {
		database.prepare(`
			UPDATE memory_exchanges
			SET settled_at = ?
			WHERE settled_at IS NULL
		`).run(new Date().toISOString());
		database.exec(SCHEMA);
		database.exec(REQUEST_RECEIPT_SCHEMA);
		database.pragma(`user_version = ${MEMORY_SCHEMA_VERSION}`);
	});
	migrate();
}

export function memoryDatabaseBackupPath(databasePath: string): string {
	return `${databasePath}.pre-client-server.bak`;
}

function createMigrationBackup(database: Database.Database, path: string): void {
	const backupPath = memoryDatabaseBackupPath(path);
	if (databaseFileExists(backupPath)) {
		const backup = new Database(backupPath, { readonly: true });
		try {
			const version = Number(backup.pragma("user_version", { simple: true }));
			if (version !== PRE_CLIENT_SERVER_SCHEMA_VERSION) {
				throw new Error(`Memory migration backup has an unexpected schema version: ${version}`);
			}
		} finally {
			backup.close();
		}
		return;
	}
	database.pragma("wal_checkpoint(TRUNCATE)");
	copyFileSync(path, backupPath, constants.COPYFILE_EXCL);
	chmodSync(backupPath, 0o600);
}

function hasOperationalTables(database: Database.Database): boolean {
	const row = database.prepare(`
		SELECT COUNT(*) AS count
		FROM sqlite_schema
		WHERE type = 'table'
		  AND name IN ('memory_exchanges', 'memory_messages', 'memory_queue', 'logs')
	`).get() as { count: number | bigint };
	return Number(row.count) > 0;
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
	if (!isMemoryCollectionPath(input.collectionPath)) {
		throw new Error(`Invalid Memory collection path: ${String(input.collectionPath)}`);
	}
	assertNonEmpty(input.fact, "Fact");
	return { supportedBy: input.supportedBy, collectionPath: input.collectionPath, fact: input.fact.trim() };
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
	if (!isMemoryCollectionPath(row.collection_path)) {
		throw new Error(`Queue contains an invalid collection path: ${row.collection_path}`);
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
		collectionPath: row.collection_path,
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
