import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import { MemoryServerConnection } from "../../src/memory/client/connection.ts";
import { buildHeadlessExtractorArgs } from "../../src/memory/extraction/extractor.ts";
import { MemoryServer } from "../../src/memory/server/runtime.ts";

const EXTRACTOR_FIXTURE = fileURLToPath(new URL("./fixtures/extractor.mjs", import.meta.url));

interface ExtractionFixtureConfig {
	delayMs: number;
	failAttempts: number;
	facts: Array<{ supportedBy: "user" | "agent" | "both"; collectionPath: string; fact: string }>;
}

interface TestService {
	directory: string;
	databasePath: string;
	socketPath: string;
	projectDirectory: string;
	attemptsPath: string;
	extractorConfigPath: string;
	serverConfig: ConstructorParameters<typeof MemoryServer>[0];
	server: MemoryServer;
}

async function createService(extractor: ExtractionFixtureConfig, graceMs = 100): Promise<TestService> {
	const directory = mkdtempSync(join(tmpdir(), "pi-toolbox-memory-extraction-"));
	const databasePath = join(directory, "memory.sqlite");
	const socketPath = join(directory, "memory.sock");
	const projectDirectory = join(directory, "project");
	const knowledgeBaseDirectory = join(directory, "knowledge");
	const attemptsPath = join(directory, "attempts");
	const extractorConfigPath = join(directory, "extractor.json");
	mkdirSync(projectDirectory);
	writeFileSync(extractorConfigPath, JSON.stringify({ ...extractor, attemptsPath }));
	const serverConfig = {
		databasePath,
		socketPath,
		knowledgeBaseDirectory,
		piInvocation: { command: process.execPath, args: [EXTRACTOR_FIXTURE, extractorConfigPath] },
		disconnectedSessionGraceMs: graceMs,
	};
	const server = new MemoryServer(serverConfig);
	await server.start();
	return {
		directory,
		databasePath,
		socketPath,
		projectDirectory,
		attemptsPath,
		extractorConfigPath,
		serverConfig,
		server,
	};
}

async function destroyService(service: TestService): Promise<void> {
	await service.server.stop();
	rmSync(service.directory, { recursive: true, force: true });
}

function connectClient(service: TestService, sessionId = randomUUID()): Promise<MemoryServerConnection> {
	return MemoryServerConnection.connectSocket(service.socketPath, {
		clientVersion: "test",
		sessionId,
		cwd: service.projectDirectory,
	});
}

test("interleaved sessions persist ordered exchanges and acknowledge before extraction", async () => {
	const service = await createService({ delayMs: 300, failAttempts: 0, facts: [] });
	try {
		const firstSessionId = "11111111-1111-4111-8111-111111111111";
		const secondSessionId = "22222222-2222-4222-8222-222222222222";
		const [first, second] = await Promise.all([
			connectClient(service, firstSessionId),
			connectClient(service, secondSessionId),
		]);
		const firstUserId = randomUUID();
		await Promise.all([
			first.requestWithId(firstUserId, "captureUser", { content: "first user", createdAt: timestamp(0) }),
			second.request("captureUser", { content: "second user", createdAt: timestamp(1) }),
		]);
		await first.requestWithId(firstUserId, "captureUser", { content: "first user", createdAt: timestamp(0) });
		await Promise.all([
			first.request("captureAgent", { content: "first agent", createdAt: timestamp(2) }),
			second.request("captureAgent", { content: "second agent", createdAt: timestamp(3) }),
		]);
		await Promise.all([
			first.request("settleExchange", { settledAt: timestamp(4) }),
			second.request("settleExchange", { settledAt: timestamp(5) }),
		]);

		const database = openDatabase(service.databasePath);
		try {
			const exchanges = database.prepare(`
				SELECT id, pi_session_id, extracted_at
				FROM memory_exchanges
				ORDER BY id
			`).all() as Array<{ id: number; pi_session_id: string; extracted_at: string | null }>;
			assert.equal(exchanges.length, 2);
			assert.equal(exchanges[0]?.extracted_at, null);
			assert.equal(exchanges[1]?.extracted_at, null);
			const messages = database.prepare(`
				SELECT e.pi_session_id, m.position, m.sent_by, m.content
				FROM memory_messages m
				JOIN memory_exchanges e ON e.id = m.exchange_id
				ORDER BY e.pi_session_id, m.position
			`).all();
			assert.deepEqual(messages, [
				{ pi_session_id: firstSessionId, position: 0, sent_by: "user", content: "first user" },
				{ pi_session_id: firstSessionId, position: 1, sent_by: "agent", content: "first agent" },
				{ pi_session_id: secondSessionId, position: 0, sent_by: "user", content: "second user" },
				{ pi_session_id: secondSessionId, position: 1, sent_by: "agent", content: "second agent" },
			]);
		} finally {
			database.close();
		}

		await waitFor(() => readAttempts(service.attemptsPath) === 1);
		first.close();
		second.close();
		await waitFor(() => readCount(service.databasePath, `
			SELECT COUNT(*) AS count FROM memory_exchanges WHERE extracted_at IS NOT NULL
		`) === 2);
		assert.equal(readCount(service.databasePath, "SELECT COUNT(*) AS count FROM memory_queue"), 0);
	} finally {
		await destroyService(service);
	}
});

test("capture receipts remain idempotent after a server restart", async () => {
	const service = await createService({ delayMs: 0, failAttempts: 0, facts: [] }, 1_000);
	try {
		const sessionId = randomUUID();
		const requestId = randomUUID();
		const toggleId = randomUUID();
		const params = { content: "persist once", createdAt: timestamp(0) };
		const first = await connectClient(service, sessionId);
		await first.requestWithId(requestId, "captureUser", params);
		assert.equal((await first.requestWithId(toggleId, "changeEnabled", { action: "toggle" })).enabled, false);
		first.close();
		await service.server.stop();

		service.server = new MemoryServer(service.serverConfig);
		await service.server.start();
		const retry = await connectClient(service, sessionId);
		await retry.requestWithId(requestId, "captureUser", params);
		assert.equal((await retry.requestWithId(toggleId, "changeEnabled", { action: "toggle" })).enabled, false);
		assert.equal(readCount(service.databasePath, "SELECT COUNT(*) AS count FROM memory_messages"), 1);
		assert.equal(readCount(service.databasePath, "SELECT COUNT(*) AS count FROM memory_request_receipts"), 2);
		retry.close();
	} finally {
		await destroyService(service);
	}
});

test("a replacement extraction consumer retries work interrupted before completion", async () => {
	const service = await createService({
		delayMs: 1_000,
		failAttempts: 0,
		facts: [{
			supportedBy: "agent",
			collectionPath: "projects/project",
			fact: "The project has a durable fact.",
		}],
	});
	try {
		const client = await connectClient(service);
		await client.request("captureUser", { content: "Explain the project", createdAt: timestamp(0) });
		await client.request("captureAgent", { content: "The project has a durable fact.", createdAt: timestamp(1) });
		await client.request("settleExchange", { settledAt: timestamp(2) });
		await waitFor(() => readAttempts(service.attemptsPath) === 1);
		const firstPid = service.server.consumerPid("extraction");
		assert.ok(firstPid);
		process.kill(firstPid, "SIGTERM");
		await waitFor(() => {
			const pid = service.server.consumerPid("extraction");
			return pid && pid !== firstPid;
		});
		await waitFor(() => readCount(service.databasePath, `
			SELECT COUNT(*) AS count FROM memory_exchanges WHERE extracted_at IS NOT NULL
		`) === 1);
		assert.ok(readAttempts(service.attemptsPath) >= 2);
		assert.equal(readCount(service.databasePath, "SELECT COUNT(*) AS count FROM memory_queue"), 1);
		client.close();
	} finally {
		await destroyService(service);
	}
});

test("an extraction failure leaves the exchange pending until a later wake", async () => {
	const service = await createService({ delayMs: 25, failAttempts: 1, facts: [] });
	try {
		const first = await connectClient(service);
		await first.request("captureUser", { content: "first", createdAt: timestamp(0) });
		await first.request("settleExchange", { settledAt: timestamp(1) });
		await waitFor(() => readAttempts(service.attemptsPath) === 1);
		await waitFor(() => readCount(service.databasePath, "SELECT COUNT(*) AS count FROM logs") === 1);
		assert.equal(readCount(service.databasePath, `
			SELECT COUNT(*) AS count FROM memory_exchanges WHERE extracted_at IS NULL
		`), 1);

		const second = await connectClient(service);
		await second.request("captureUser", { content: "second", createdAt: timestamp(2) });
		await second.request("settleExchange", { settledAt: timestamp(3) });
		await waitFor(() => readCount(service.databasePath, `
			SELECT COUNT(*) AS count FROM memory_exchanges WHERE extracted_at IS NOT NULL
		`) === 2);
		assert.ok(readAttempts(service.attemptsPath) >= 3);
		first.close();
		second.close();
	} finally {
		await destroyService(service);
	}
});

test("closeSession and disconnected-session expiry settle open exchanges", async () => {
	const service = await createService({ delayMs: 0, failAttempts: 0, facts: [] }, 100);
	try {
		const closedNormally = await connectClient(service);
		await closedNormally.request("captureUser", { content: "normal close", createdAt: timestamp(0) });
		assert.equal(await closedNormally.request("closeSession", { settledAt: timestamp(1) }), true);
		closedNormally.close();

		const expired = await connectClient(service);
		await expired.request("captureUser", { content: "abrupt close", createdAt: timestamp(2) });
		expired.close();
		await waitFor(() => readCount(service.databasePath, `
			SELECT COUNT(*) AS count FROM memory_exchanges WHERE settled_at IS NOT NULL
		`) === 2);
		await waitFor(() => readCount(service.databasePath, `
			SELECT COUNT(*) AS count FROM memory_exchanges WHERE extracted_at IS NOT NULL
		`) === 2);
	} finally {
		await destroyService(service);
	}
});

test("reconnecting during the grace period keeps the session exchange open", async () => {
	const service = await createService({ delayMs: 0, failAttempts: 0, facts: [] }, 300);
	try {
		const sessionId = randomUUID();
		const first = await connectClient(service, sessionId);
		await first.request("captureUser", { content: "reconnect", createdAt: timestamp(0) });
		first.close();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const reconnected = await connectClient(service, sessionId);
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.equal(readCount(service.databasePath, `
			SELECT COUNT(*) AS count FROM memory_exchanges WHERE settled_at IS NULL
		`), 1);
		reconnected.close();
		await waitFor(() => readCount(service.databasePath, `
			SELECT COUNT(*) AS count FROM memory_exchanges WHERE settled_at IS NOT NULL
		`) === 1);
	} finally {
		await destroyService(service);
	}
});

test("headless extraction disables Memory resources but permits context files", () => {
	const args = buildHeadlessExtractorArgs(
		{ cwd: process.cwd(), messages: [{ sentBy: "user", content: "hello" }] },
		{ currentProjectCollection: "projects/project", availableCollections: ["projects/project"] },
	);
	assert.ok(args.includes("--no-extensions"));
	assert.ok(args.includes("--no-skills"));
	assert.ok(args.includes("--no-prompt-templates"));
	assert.ok(args.includes("--no-tools"));
	assert.ok(!args.includes("--no-context-files"));
	assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), ["--thinking", "off"]);
});

function openDatabase(path: string): Database.Database {
	const database = new Database(path);
	database.pragma("busy_timeout = 5000");
	return database;
}

function readCount(path: string, sql: string): number {
	const database = openDatabase(path);
	try {
		const row = database.prepare(sql).get() as { count: number };
		return row.count;
	} finally {
		database.close();
	}
}

function readAttempts(path: string): number {
	try {
		return Number(readFileSync(path, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
		throw error;
	}
}

function timestamp(offset: number): string {
	return new Date(Date.UTC(2026, 8, 1, 10, 0, 0, offset)).toISOString();
}

async function waitFor(read: () => unknown): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (read()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Condition was not met before timeout");
}
