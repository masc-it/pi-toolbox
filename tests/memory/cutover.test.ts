import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import { MemoryClientRuntime } from "../../src/memory/capture.ts";
import { MemorySessionClient } from "../../src/memory/client/capture.ts";
import { MemoryServerConnection } from "../../src/memory/client/connection.ts";
import {
	MEMORY_SCHEMA_VERSION,
	MemoryQueue,
	memoryDatabaseBackupPath,
} from "../../src/memory/queue.ts";
import { MemoryServer } from "../../src/memory/server/runtime.ts";
import { MemorySettingsStore } from "../../src/memory/settings.ts";

const CURATOR_FIXTURE = fileURLToPath(new URL("./fixtures/curator.mjs", import.meta.url));

const VERSION_THREE_SCHEMA = `
CREATE TABLE memory_exchanges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pi_session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    started_at TEXT NOT NULL,
    settled_at TEXT,
    extracted_at TEXT,
    CHECK (extracted_at IS NULL OR settled_at IS NOT NULL)
) STRICT;
CREATE TABLE memory_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange_id INTEGER NOT NULL REFERENCES memory_exchanges (id),
    position INTEGER NOT NULL CHECK (position >= 0),
    sent_by TEXT NOT NULL CHECK (sent_by IN ('user', 'agent')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (exchange_id, position)
) STRICT;
CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    msg TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;
CREATE TABLE memory_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange_id INTEGER NOT NULL REFERENCES memory_exchanges (id),
    pi_session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    supported_by TEXT NOT NULL CHECK (supported_by IN ('user', 'agent', 'both')),
    collection_path TEXT NOT NULL,
    fact TEXT NOT NULL,
    created_at TEXT NOT NULL,
    processed_at TEXT
) STRICT;
CREATE TABLE memory_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
) STRICT;
INSERT INTO memory_settings (id, enabled) VALUES (1, 0);
PRAGMA user_version = 3;
`;

test("the client-server migration backs up and preserves version-three queue data", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-toolbox-memory-migration-"));
	const databasePath = join(directory, "memory.sqlite");
	try {
		const database = new Database(databasePath);
		database.exec(VERSION_THREE_SCHEMA);
		insertMigratedExchange(database, 1, "session-processed", "processed fact", timestamp(4));
		insertMigratedExchange(database, 2, "session-pending", "pending fact", null);
		database.close();

		assert.deepEqual(readQueueCounts(databasePath), { pending: 1, processed: 1 });
		const queue = new MemoryQueue(databasePath);
		queue.close();

		const backupPath = memoryDatabaseBackupPath(databasePath);
		assert.equal(existsSync(backupPath), true);
		assert.equal(readSchemaVersion(backupPath), 3);
		assert.deepEqual(readQueueCounts(backupPath), { pending: 1, processed: 1 });
		assert.equal(readSchemaVersion(databasePath), MEMORY_SCHEMA_VERSION);
		assert.deepEqual(readQueueCounts(databasePath), { pending: 1, processed: 1 });
		assert.equal(readCount(databasePath, "SELECT COUNT(*) AS count FROM memory_exchanges"), 2);
		assert.equal(readCount(databasePath, "SELECT COUNT(*) AS count FROM memory_messages"), 2);
		assert.equal(readCount(databasePath, "SELECT COUNT(*) AS count FROM memory_request_receipts"), 0);

		const settings = new MemorySettingsStore(databasePath);
		try {
			assert.equal(settings.getStatus().enabled, false);
			assert.equal(settings.getStatus().pending, 1);
			assert.equal(settings.getStatus().processed, 1);
		} finally {
			settings.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("migration settles orphaned exchanges before adding open-session uniqueness", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-toolbox-memory-open-session-"));
	const databasePath = join(directory, "memory.sqlite");
	try {
		const database = new Database(databasePath);
		database.exec(VERSION_THREE_SCHEMA);
		for (const id of [1, 2]) {
			database.prepare(`
				INSERT INTO memory_exchanges (id, pi_session_id, cwd, started_at)
				VALUES (?, 'shared-session', ?, ?)
			`).run(id, directory, timestamp(id));
			database.prepare(`
				INSERT INTO memory_messages (exchange_id, position, sent_by, content, created_at)
				VALUES (?, 0, 'user', ?, ?)
			`).run(id, `message-${id}`, timestamp(id));
		}
		database.close();

		const queue = new MemoryQueue(databasePath);
		queue.close();
		assert.equal(readCount(databasePath, `
			SELECT COUNT(*) AS count FROM memory_exchanges WHERE settled_at IS NULL
		`), 0);

		const migrated = new Database(databasePath);
		try {
			migrated.prepare(`
				INSERT INTO memory_exchanges (pi_session_id, cwd, started_at)
				VALUES ('shared-session', ?, ?)
			`).run(directory, timestamp(10));
			assert.throws(() => migrated.prepare(`
				INSERT INTO memory_exchanges (pi_session_id, cwd, started_at)
				VALUES ('shared-session', ?, ?)
			`).run(directory, timestamp(11)), /UNIQUE constraint failed/);
		} finally {
			migrated.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the server refuses cutover while a legacy worker lock exists", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-toolbox-memory-legacy-lock-"));
	const databasePath = join(directory, "memory.sqlite");
	const lockPath = `${databasePath}.lock`;
	try {
		writeFileSync(lockPath, "legacy");
		assert.throws(() => new MemoryServer({
			databasePath,
			socketPath: join(directory, "memory.sock"),
			knowledgeBaseDirectory: join(directory, "knowledge"),
			piInvocation: { command: process.execPath, args: ["-e", "process.exit(1)"] },
		}), /old Memory extension/);
		assert.equal(existsSync(databasePath), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("session clients share one service across working directories", async () => {
	const service = await createService();
	const firstProject = join(service.directory, "project-one");
	const secondProject = join(service.directory, "project-two");
	mkdirSync(firstProject);
	mkdirSync(secondProject);
	const first = createRuntime(service.socketPath);
	const second = createRuntime(service.socketPath);
	try {
		await Promise.all([
			first.start({ sessionId: randomUUID(), cwd: firstProject }),
			second.start({ sessionId: randomUUID(), cwd: secondProject }),
		]);
		assert.equal(service.server.connectionCount(), 2);
		await Promise.all([
			first.captureUser("first project", timestamp(20)),
			second.captureUser("second project", timestamp(21)),
		]);
		await Promise.all([
			first.settleExchange(timestamp(22)),
			second.settleExchange(timestamp(23)),
		]);

		assert.deepEqual(readStrings(service.databasePath, `
			SELECT cwd FROM memory_exchanges ORDER BY cwd
		`), [realpathSync(firstProject), realpathSync(secondProject)]);
	} finally {
		await Promise.all([first.close(), second.close()]);
		await destroyService(service);
	}
});

test("global disable stops capture and consumers, and re-enable drains both queues", async () => {
	const service = await createService();
	const firstProject = join(service.directory, "project-one");
	const secondProject = join(service.directory, "project-two");
	mkdirSync(firstProject);
	mkdirSync(secondProject);
	const first = createRuntime(service.socketPath);
	const second = createRuntime(service.socketPath);
	try {
		await first.start({ sessionId: randomUUID(), cwd: firstProject });
		await second.start({ sessionId: randomUUID(), cwd: secondProject });
		assert.equal((await first.changeEnabled("off")).enabled, false);
		assert.equal(service.server.consumerPid("extraction"), null);
		assert.equal(service.server.consumerPid("curation"), null);

		await second.captureUser("ignored while disabled", timestamp(30));
		await second.settleExchange(timestamp(31));
		assert.equal(readCount(service.databasePath, "SELECT COUNT(*) AS count FROM memory_messages"), 0);

		const queue = new MemoryQueue(service.databasePath);
		const curated = queue.startExchange({ piSessionId: "seed-curation", cwd: firstProject, startedAt: timestamp(32) }, "curate");
		queue.settleExchange(curated.id, timestamp(33));
		const extractable = queue.nextUnextractedExchange();
		assert.ok(extractable);
		queue.completeExtraction(extractable, [{ supportedBy: "user", collectionPath: "coding", fact: "queued fact" }], timestamp(34));
		const pendingExtraction = queue.startExchange({ piSessionId: "seed-extraction", cwd: secondProject, startedAt: timestamp(35) }, "extract");
		queue.settleExchange(pendingExtraction.id, timestamp(36));
		queue.close();
		assert.equal((await first.getStatus()).pending, 2);

		assert.equal((await second.changeEnabled("on")).enabled, true);
		assert.ok(service.server.consumerPid("extraction"));
		assert.ok(service.server.consumerPid("curation"));
		await waitFor(async () => (await first.getStatus()).pending === 0);
		assert.equal((await first.getStatus()).processed, 1);
	} finally {
		await Promise.all([first.close(), second.close()]);
		await destroyService(service);
	}
});

interface TestService {
	directory: string;
	databasePath: string;
	socketPath: string;
	server: MemoryServer;
}

async function createService(): Promise<TestService> {
	const directory = mkdtempSync(join(tmpdir(), "pi-toolbox-memory-cutover-"));
	const databasePath = join(directory, "memory.sqlite");
	const socketPath = join(directory, "memory.sock");
	const fixtureConfigPath = join(directory, "curator.json");
	writeFileSync(fixtureConfigPath, JSON.stringify({
		attemptsPath: join(directory, "attempts"),
		delayMs: 0,
		extractionFacts: [],
	}));
	const server = new MemoryServer({
		databasePath,
		socketPath,
		knowledgeBaseDirectory: join(directory, "knowledge"),
		piInvocation: { command: process.execPath, args: [CURATOR_FIXTURE, fixtureConfigPath] },
	});
	await server.start();
	return { directory, databasePath, socketPath, server };
}

function createRuntime(socketPath: string): MemoryClientRuntime {
	return new MemoryClientRuntime(async (identity) => {
		const connection = await MemoryServerConnection.connectSocket(socketPath, {
			clientVersion: "test",
			sessionId: identity.sessionId,
			cwd: identity.cwd,
		});
		await connection.request("connectSession", {});
		return new MemorySessionClient(connection);
	});
}

async function destroyService(service: TestService): Promise<void> {
	await service.server.stop();
	rmSync(service.directory, { recursive: true, force: true });
}

function insertMigratedExchange(
	database: Database.Database,
	id: number,
	sessionId: string,
	fact: string,
	processedAt: string | null,
): void {
	database.prepare(`
		INSERT INTO memory_exchanges (id, pi_session_id, cwd, started_at, settled_at, extracted_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(id, sessionId, process.cwd(), timestamp(id), timestamp(id + 1), timestamp(id + 2));
	database.prepare(`
		INSERT INTO memory_messages (exchange_id, position, sent_by, content, created_at)
		VALUES (?, 0, 'user', ?, ?)
	`).run(id, `message-${id}`, timestamp(id));
	database.prepare(`
		INSERT INTO memory_queue (
			exchange_id, pi_session_id, cwd, supported_by, collection_path, fact, created_at, processed_at
		)
		VALUES (?, ?, ?, 'user', 'coding', ?, ?, ?)
	`).run(id, sessionId, process.cwd(), fact, timestamp(id + 1), processedAt);
}

function readQueueCounts(path: string): { pending: number; processed: number } {
	const database = new Database(path, { readonly: true });
	try {
		return {
			pending: (database.prepare("SELECT COUNT(*) AS count FROM memory_queue WHERE processed_at IS NULL").get() as { count: number }).count,
			processed: (database.prepare("SELECT COUNT(*) AS count FROM memory_queue WHERE processed_at IS NOT NULL").get() as { count: number }).count,
		};
	} finally {
		database.close();
	}
}

function readSchemaVersion(path: string): number {
	const database = new Database(path, { readonly: true });
	try {
		return Number(database.pragma("user_version", { simple: true }));
	} finally {
		database.close();
	}
}

function readCount(path: string, sql: string): number {
	const database = new Database(path, { readonly: true });
	try {
		return (database.prepare(sql).get() as { count: number }).count;
	} finally {
		database.close();
	}
}

function readStrings(path: string, sql: string): string[] {
	const database = new Database(path, { readonly: true });
	try {
		return (database.prepare(sql).all() as Array<{ cwd: string }>).map((row) => row.cwd);
	} finally {
		database.close();
	}
}

function timestamp(offset: number): string {
	return new Date(Date.UTC(2026, 8, 1, 10, 0, 0, offset)).toISOString();
}

async function waitFor(read: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (await read()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Condition was not met before timeout");
}
