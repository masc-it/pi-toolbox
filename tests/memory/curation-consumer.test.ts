import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import { MemoryServerConnection } from "../../src/memory/client/connection.ts";
import { buildBoundedBatch, MemoryConsumer } from "../../src/memory/consumer.ts";
import type { CuratorBatch, CuratorResult } from "../../src/memory/curator.ts";
import { MemoryQueue, type MemoryQueueRow, type PendingMemoryBatch } from "../../src/memory/queue.ts";
import { MemoryServer } from "../../src/memory/server/runtime.ts";

const CURATOR_FIXTURE = fileURLToPath(new URL("./fixtures/curator.mjs", import.meta.url));

class NoChangeRepository {
	readonly path = "/knowledge";
	assertClean(): void {}
	changedPaths(): string[] { return []; }
	validateChanges(): void {}
	commit(): void { throw new Error("Unexpected commit"); }
	rollback(): void {}
}

class GatedCurator {
	readonly batches: bigint[][] = [];
	active = 0;
	maxActive = 0;
	private releaseFirst!: () => void;
	private readonly firstGate = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

	async curate(batch: CuratorBatch): Promise<CuratorResult> {
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		this.batches.push(batch.rows.map((row) => row.id));
		try {
			if (this.batches.length === 1) await this.firstGate;
			return { commitMessage: null };
		} finally {
			this.active--;
		}
	}

	release(): void {
		this.releaseFirst();
	}
}

test("curation drains FIFO cwd batches and includes facts produced during a running batch", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-toolbox-curation-batches-"));
	const firstCwd = join(directory, "same-project");
	mkdirSync(firstCwd);
	const queue = new MemoryQueue(join(directory, "memory.sqlite"));
	const firstIds = enqueueFacts(queue, firstCwd, "session-1", ["first"]);
	const curator = new GatedCurator();
	const consumer = new MemoryConsumer(queue, curator, new NoChangeRepository());
	try {
		consumer.wake();
		await waitFor(() => curator.batches.length === 1);
		const laterIds = enqueueFacts(
			queue,
			firstCwd,
			"session-2",
			Array.from({ length: 11 }, (_, index) => `later-${index}`),
		);
		consumer.wake();
		curator.release();
		await waitFor(() => readCount(queue.path, "SELECT COUNT(*) AS count FROM memory_queue WHERE processed_at IS NOT NULL") === 12);

		assert.equal(curator.maxActive, 1);
		assert.deepEqual(curator.batches.map((ids) => ids.length), [1, 10, 1]);
		assert.deepEqual(curator.batches.flat(), [...firstIds, ...laterIds]);
	} finally {
		await consumer.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("curation skips a failed cwd and continues with another working directory", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-toolbox-curation-retry-"));
	const failedCwd = join(directory, "failed-project");
	const healthyCwd = join(directory, "healthy-project");
	mkdirSync(failedCwd);
	mkdirSync(healthyCwd);
	const queue = new MemoryQueue(join(directory, "memory.sqlite"));
	const failedIds = enqueueFacts(queue, failedCwd, "session-failed", ["fails"]);
	const healthyIds = enqueueFacts(queue, healthyCwd, "session-healthy", ["works"]);
	const attempts: string[] = [];
	const curator = {
		async curate(batch: CuratorBatch): Promise<CuratorResult> {
			attempts.push(batch.cwd);
			if (batch.cwd.endsWith("/failed-project")) throw new Error("planned curation failure");
			return { commitMessage: null };
		},
	};
	const consumer = new MemoryConsumer(queue, curator, new NoChangeRepository());
	try {
		consumer.wake();
		await waitFor(() => rowIsProcessed(queue.path, healthyIds[0]!));
		assert.equal(rowIsProcessed(queue.path, failedIds[0]!), false);
		assert.deepEqual(attempts.map((cwd) => cwd.split("/").at(-1)), ["failed-project", "healthy-project"]);
		assert.equal(readCount(queue.path, "SELECT COUNT(*) AS count FROM logs"), 1);
	} finally {
		await consumer.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("curation completes rows after commit or confirmed no-op and rolls back failures", async () => {
	const commitEvents: string[] = [];
	const commitQueue = new SingleBatchQueue(createBatch("/commit", [queueRow(1n, "/commit", "commit")]), commitEvents);
	const commitRepository = new RecordingRepository(["coding/commit.md"], commitEvents);
	const commitConsumer = new MemoryConsumer(
		commitQueue,
		{ curate: async () => ({ commitMessage: "memory(global): record commit fact" }) },
		commitRepository,
	);
	commitConsumer.wake();
	await waitFor(() => commitQueue.processed);
	assert.deepEqual(commitEvents, ["validate", "commit", "processed"]);
	await commitConsumer.close();

	const noOpEvents: string[] = [];
	const noOpQueue = new SingleBatchQueue(createBatch("/noop", [queueRow(2n, "/noop", "noop")]), noOpEvents);
	const noOpConsumer = new MemoryConsumer(
		noOpQueue,
		{ curate: async () => ({ commitMessage: null }) },
		new RecordingRepository([], noOpEvents),
	);
	noOpConsumer.wake();
	await waitFor(() => noOpQueue.processed);
	assert.deepEqual(noOpEvents, ["processed"]);
	await noOpConsumer.close();

	const failureEvents: string[] = [];
	const failureQueue = new SingleBatchQueue(createBatch("/failure", [queueRow(3n, "/failure", "failure")]), failureEvents);
	const failureConsumer = new MemoryConsumer(
		failureQueue,
		{ curate: async () => { throw new Error("planned failure"); } },
		new RecordingRepository(["coding/failure.md"], failureEvents),
	);
	failureConsumer.wake();
	await waitFor(() => failureEvents.includes("rollback"));
	assert.equal(failureQueue.processed, false);
	assert.deepEqual(failureEvents, ["rollback"]);
	await failureConsumer.close();
});

test("batch construction enforces the serialized byte limit", () => {
	const first = queueRow(1n, "/project", "a".repeat(20 * 1024));
	const second = queueRow(2n, "/project", "b".repeat(20 * 1024));
	const batch = buildBoundedBatch(createBatch("/project", [first, second]));
	assert.deepEqual(batch.rows.map((row) => row.id), [1n]);
});

test("an oversized fact does not block another working directory", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-toolbox-curation-oversized-"));
	const oversizedCwd = join(directory, "oversized-project");
	const healthyCwd = join(directory, "healthy-project");
	mkdirSync(oversizedCwd);
	mkdirSync(healthyCwd);
	const queue = new MemoryQueue(join(directory, "memory.sqlite"));
	const oversizedIds = enqueueFacts(queue, oversizedCwd, "session-oversized", ["x".repeat(33 * 1024)]);
	const healthyIds = enqueueFacts(queue, healthyCwd, "session-healthy", ["bounded"]);
	const consumer = new MemoryConsumer(
		queue,
		{ curate: async () => ({ commitMessage: null }) },
		new NoChangeRepository(),
	);
	try {
		consumer.wake();
		await waitFor(() => rowIsProcessed(queue.path, healthyIds[0]!));
		assert.equal(rowIsProcessed(queue.path, oversizedIds[0]!), false);
		assert.equal(readCount(queue.path, "SELECT COUNT(*) AS count FROM logs"), 1);
	} finally {
		await consumer.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("facts from concurrent clients sharing a cwd are serialized by one curation consumer", async () => {
	const service = await createServerService({
		blocked: true,
		extractionFacts: [{ supportedBy: "user", collectionPath: "coding", fact: "shared cwd fact" }],
	});
	try {
		const firstPid = service.server.consumerPid("curation");
		assert.ok(firstPid);
		const [first, second] = await Promise.all([
			MemoryServerConnection.connectSocket(service.socketPath, {
				clientVersion: "test",
				sessionId: randomUUID(),
				cwd: service.projectDirectory,
			}),
			MemoryServerConnection.connectSocket(service.socketPath, {
				clientVersion: "test",
				sessionId: randomUUID(),
				cwd: service.projectDirectory,
			}),
		]);
		await Promise.all([
			first.request("captureUser", { content: "first session", createdAt: timestamp(10) }),
			second.request("captureUser", { content: "second session", createdAt: timestamp(11) }),
		]);
		await Promise.all([
			first.request("settleExchange", { settledAt: timestamp(12) }),
			second.request("settleExchange", { settledAt: timestamp(13) }),
		]);
		await waitFor(() => existsSync(service.activePath));
		await waitFor(() => readCount(service.databasePath, "SELECT COUNT(*) AS count FROM memory_queue") === 2);
		assert.equal(service.server.consumerPid("curation"), firstPid);
		assert.equal(readAttempts(service.attemptsPath).length, 1);

		writeFileSync(service.releasePath, "release");
		await waitFor(() => readCount(service.databasePath, "SELECT COUNT(*) AS count FROM memory_queue WHERE processed_at IS NOT NULL") === 2);
		assert.equal(readAttempts(service.attemptsPath).length, 2);
		first.close();
		second.close();
	} finally {
		if (!existsSync(service.releasePath)) writeFileSync(service.releasePath, "release");
		await destroyServerService(service);
	}
});

test("the curation process marks a row after its Git commit", async () => {
	const service = await createServerService({ commit: true });
	try {
		const queue = new MemoryQueue(service.databasePath);
		const ids = enqueueFacts(queue, service.projectDirectory, "session-commit", ["commit this fact"]);
		queue.close();
		service.server.wake("curation");
		await waitFor(() => rowIsProcessed(service.databasePath, ids[0]!));

		const knowledgeBaseDirectory = join(service.directory, "knowledge");
		assert.equal(runGit(knowledgeBaseDirectory, ["log", "-1", "--format=%s"]), "memory(global): record fixture memory");
		assert.equal(existsSync(join(knowledgeBaseDirectory, "coding", "fixture-memory.md")), true);
	} finally {
		await destroyServerService(service);
	}
});

test("a replacement curation consumer drains facts without a wake", async () => {
	const service = await createServerService({ delayMs: 0 });
	try {
		const queue = new MemoryQueue(service.databasePath);
		const ids = enqueueFacts(queue, service.projectDirectory, "session-restart", ["pending after lost wake"]);
		queue.close();
		const firstPid = service.server.consumerPid("curation");
		assert.ok(firstPid);
		process.kill(firstPid, "SIGTERM");
		await waitFor(() => {
			const pid = service.server.consumerPid("curation");
			return Boolean(pid && pid !== firstPid);
		});
		await waitFor(() => rowIsProcessed(service.databasePath, ids[0]!));
		assert.equal(readAttempts(service.attemptsPath).length, 1);
	} finally {
		await destroyServerService(service);
	}
});

test("the socket server handles capture and status while curation is blocked", async () => {
	const service = await createServerService({ blocked: true });
	try {
		const queue = new MemoryQueue(service.databasePath);
		enqueueFacts(queue, service.projectDirectory, "session-blocked", ["slow curation"]);
		queue.close();
		service.server.wake("curation");
		await waitFor(() => existsSync(service.activePath));

		const client = await MemoryServerConnection.connectSocket(service.socketPath, {
			clientVersion: "test",
			sessionId: randomUUID(),
			cwd: service.projectDirectory,
		});
		await Promise.all([
			client.request("captureUser", { content: "captured during curation", createdAt: timestamp(20) }),
			client.request("getStatus", {}),
		]);
		assert.equal(readCount(service.databasePath, `
			SELECT COUNT(*) AS count FROM memory_messages WHERE content = 'captured during curation'
		`), 1);
		client.close();
		writeFileSync(service.releasePath, "release");
		await waitFor(() => readCount(service.databasePath, "SELECT COUNT(*) AS count FROM memory_queue WHERE processed_at IS NOT NULL") === 1);
	} finally {
		if (!existsSync(service.releasePath)) writeFileSync(service.releasePath, "release");
		await destroyServerService(service);
	}
});

class SingleBatchQueue {
	processed = false;
	constructor(private readonly batch: PendingMemoryBatch, private readonly events: string[]) {}
	nextPendingBatch(_maxRows?: number, excludedCwds: ReadonlySet<string> = new Set()): PendingMemoryBatch | null {
		return this.processed || excludedCwds.has(this.batch.cwd) ? null : this.batch;
	}
	markProcessed(): void {
		this.events.push("processed");
		this.processed = true;
	}
	logError(): void {}
	close(): void {}
}

class RecordingRepository {
	readonly path = "/knowledge";
	constructor(private readonly paths: string[], private readonly events: string[]) {}
	assertClean(): void {}
	changedPaths(): string[] { return this.paths; }
	validateChanges(): void { this.events.push("validate"); }
	commit(): void { this.events.push("commit"); }
	rollback(): void { this.events.push("rollback"); }
}

interface ServerService {
	directory: string;
	databasePath: string;
	socketPath: string;
	projectDirectory: string;
	attemptsPath: string;
	activePath: string;
	releasePath: string;
	server: MemoryServer;
}

async function createServerService(options: {
	delayMs?: number;
	blocked?: boolean;
	commit?: boolean;
	extractionFacts?: Array<{ supportedBy: "user" | "agent" | "both"; collectionPath: string; fact: string }>;
}): Promise<ServerService> {
	const directory = mkdtempSync(join(tmpdir(), "pi-toolbox-curation-service-"));
	const databasePath = join(directory, "memory.sqlite");
	const socketPath = join(directory, "memory.sock");
	const projectDirectory = join(directory, "project");
	const attemptsPath = join(directory, "attempts");
	const activePath = join(directory, "active");
	const releasePath = join(directory, "release");
	const fixtureConfigPath = join(directory, "curator.json");
	mkdirSync(projectDirectory);
	writeFileSync(fixtureConfigPath, JSON.stringify({
		attemptsPath,
		delayMs: options.delayMs ?? 0,
		...(options.blocked ? { activePath, releasePath } : {}),
		...(options.commit ? { commit: true } : {}),
		...(options.extractionFacts ? { extractionFacts: options.extractionFacts } : {}),
	}));
	const server = new MemoryServer({
		databasePath,
		socketPath,
		knowledgeBaseDirectory: join(directory, "knowledge"),
		piInvocation: { command: process.execPath, args: [CURATOR_FIXTURE, fixtureConfigPath] },
	});
	await server.start();
	return { directory, databasePath, socketPath, projectDirectory, attemptsPath, activePath, releasePath, server };
}

async function destroyServerService(service: ServerService): Promise<void> {
	await service.server.stop();
	rmSync(service.directory, { recursive: true, force: true });
}

function enqueueFacts(queue: MemoryQueue, cwd: string, sessionId: string, facts: string[]): bigint[] {
	const exchange = queue.startExchange({ piSessionId: sessionId, cwd, startedAt: timestamp(0) }, "user message");
	queue.settleExchange(exchange.id, timestamp(1));
	const settled = queue.nextUnextractedExchange();
	if (!settled || settled.id !== exchange.id) throw new Error("Expected the newly settled exchange");
	return queue.completeExtraction(
		settled,
		facts.map((fact) => ({ supportedBy: "user" as const, collectionPath: "coding", fact })),
		timestamp(2),
	);
}

function createBatch(cwd: string, rows: MemoryQueueRow[]): PendingMemoryBatch {
	return { cwd, rows };
}

function queueRow(id: bigint, cwd: string, fact: string): MemoryQueueRow {
	return {
		id,
		exchangeId: id,
		piSessionId: `session-${id}`,
		cwd,
		supportedBy: "user",
		collectionPath: "coding",
		fact,
		createdAt: timestamp(Number(id)),
		processedAt: null,
	};
}

function readCount(path: string, sql: string): number {
	const database = new Database(path);
	try {
		database.pragma("busy_timeout = 5000");
		return (database.prepare(sql).get() as { count: number }).count;
	} finally {
		database.close();
	}
}

function rowIsProcessed(path: string, id: bigint): boolean {
	const database = new Database(path);
	try {
		database.defaultSafeIntegers(true);
		const row = database.prepare("SELECT processed_at FROM memory_queue WHERE id = ?").get(id) as { processed_at: string | null };
		return row.processed_at !== null;
	} finally {
		database.close();
	}
}

function readAttempts(path: string): string[] {
	try {
		return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
	if (result.status !== 0) throw new Error(result.stderr.trim() || "Git command failed");
	return result.stdout.trim();
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
