import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ProcessInvocation, ProcessResult } from "../../src/process/runner.ts";
import {
	ComplexityCancelledError,
	ComplexityTimeoutError,
	runComplexityAnalyzer,
} from "../../src/workflows/complexity-runner.ts";
import {
	analyzeRepository,
	buildComplexityPrompt,
	formatPythonExitError,
	formatPythonSpawnError,
} from "../../src/workflows/complexity.ts";
import {
	analyzeJavaScriptTypeScriptRepository,
	buildJavaScriptTypeScriptComplexityPrompt,
	formatJavaScriptTypeScriptExitError,
	JAVASCRIPT_TYPESCRIPT_ANALYSIS_TIMEOUT_MS,
	formatJavaScriptTypeScriptSpawnError,
} from "../../src/workflows/javascript-typescript-complexity.ts";

const execFileAsync = promisify(execFile);
const JAVASCRIPT_ANALYZER = new URL("../../scripts/javascript_typescript_complexity.mjs", import.meta.url);
const PYTHON_ANALYZER = new URL("../../scripts/python_complexity.py", import.meta.url);

interface FixtureRunOptions {
	script: string;
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	timeoutError?: () => Error;
	invocation?: (path: string) => ProcessInvocation;
	formatExitError?: (result: ProcessResult, stderr: string) => string;
	formatSpawnError?: (error: unknown) => Error;
}

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-toolbox complexity Ω "));
	try {
		return await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function runFixture(options: FixtureRunOptions) {
	const analyzerPath = join(options.cwd, "fixture analyzer.mjs");
	await writeFile(analyzerPath, options.script, "utf8");
	const controller = new AbortController();
	return runComplexityAnalyzer({
		analyzerPath,
		invocation: options.invocation?.(analyzerPath) ?? { command: process.execPath, args: [analyzerPath] },
		cwd: options.cwd,
		signal: options.signal ?? controller.signal,
		formatExitError: options.formatExitError ?? formatJavaScriptTypeScriptExitError,
		formatSpawnError: options.formatSpawnError ?? formatJavaScriptTypeScriptSpawnError,
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		...(options.timeoutError === undefined ? {} : { timeoutError: options.timeoutError }),
	});
}

function processResult(code: number): ProcessResult {
	return { stdout: Buffer.alloc(0), stderr: "", stderrTruncated: false, code, signal: null };
}

test("both public workflows preserve analyzer output from a path containing spaces and Unicode", async () => {
	await withTempDirectory(async (parent) => {
		const repository = join(parent, "project files 漢字");
		await mkdir(repository);
		await writeFile(
			join(repository, "sample.ts"),
			"export function choose(value: boolean) {\n\tif (value) return 1;\n\treturn 0;\n}\n",
			"utf8",
		);
		await writeFile(
			join(repository, "sample.py"),
			"def choose(value: bool):\n    if value:\n        return 1\n    return 0\n",
			"utf8",
		);

		const signal = new AbortController().signal;
		const [javascriptResult, directJavaScript, pythonResult, directPython] = await Promise.all([
			analyzeJavaScriptTypeScriptRepository(repository, signal),
			execFileAsync(process.execPath, [JAVASCRIPT_ANALYZER.pathname, "--repo-root", repository], {
				cwd: repository,
				encoding: "utf8",
			}),
			analyzeRepository(repository, signal),
			execFileAsync("uv", ["run", PYTHON_ANALYZER.pathname, "--repo-root", repository], {
				cwd: repository,
				encoding: "utf8",
			}),
		]);

		assert.equal(javascriptResult.report, directJavaScript.stdout);
		assert.equal(pythonResult.report, directPython.stdout);
		assert.match(javascriptResult.report, /`sample\.ts`/);
		assert.match(pythonResult.report, /`sample\.py`/);
	});
});

test("the workflow prompt builders append reports without changing them", () => {
	assert.equal(JAVASCRIPT_TYPESCRIPT_ANALYSIS_TIMEOUT_MS, 300_000);
	const report = "- `source.ts`\n  - Quality heuristic: 42/100\n";
	assert.equal(
		buildJavaScriptTypeScriptComplexityPrompt(report),
		"Propose how to reduce the code complexity in the highest-offending JavaScript or TypeScript file shown below. Focus on the reported hotspots, preserve behavior and public types, and do not optimize solely for the heuristic.\n\n" +
			report,
	);
	assert.equal(
		buildComplexityPrompt(report),
		"Propose how to reduce the code complexity in the highest-offending Python file shown below.\n\n" + report,
	);
});

test("JavaScript and TypeScript analyzer exit codes have specific reasons", () => {
	const reasons = new Map([
		[2, "Invalid arguments, source discovery failure, or repository boundary failure."],
		[3, "No production JavaScript or TypeScript files were found."],
		[4, "A JavaScript or TypeScript file could not be read, decoded, or parsed."],
		[5, "internal invariant failure."],
		[6, "A source file count or byte limit was exceeded."],
	]);
	for (const [code, reason] of reasons) {
		const message = formatJavaScriptTypeScriptExitError(processResult(code), " detail");
		assert.match(message, new RegExp(`exited with code ${code}\\.`));
		assert.ok(message.includes(reason));
		assert.ok(message.endsWith(" detail"));
	}
});

test("Python analyzer exit codes preserve their previous reasons", () => {
	const reasons = new Map([
		[2, "Invalid repository root or repository boundary failure."],
		[3, "No production Python files were found."],
		[4, "A Python file could not be read, decoded, or parsed."],
		[5, "The complexity analyzer encountered an internal invariant failure."],
	]);
	for (const [code, reason] of reasons) {
		assert.equal(
			formatPythonExitError(processResult(code), " detail"),
			`Complexity analyzer exited with code ${code}. ${reason} detail`,
		);
	}
	const missingUv = Object.assign(new Error("spawn uv ENOENT"), { code: "ENOENT" });
	assert.equal(
		formatPythonSpawnError(missingUv).message,
		"Unable to run the complexity analyzer because the uv executable was not found in PATH",
	);
});

test("non-zero analyzer processes surface each configured exit-code reason", async () => {
	await withTempDirectory(async (directory) => {
		for (const code of [2, 3, 4, 5, 6]) {
			await assert.rejects(
				runFixture({
					script: `process.stderr.write('detail'); process.exit(${code});`,
					cwd: directory,
				}),
				new RegExp(`JavaScript and TypeScript complexity analyzer exited with code ${code}\\..* detail`),
			);
		}
		for (const code of [2, 3, 4, 5]) {
			await assert.rejects(
				runFixture({
					script: `process.stderr.write('detail'); process.exit(${code});`,
					cwd: directory,
					formatExitError: formatPythonExitError,
					formatSpawnError: formatPythonSpawnError,
				}),
				new RegExp(`Complexity analyzer exited with code ${code}\\..* detail`),
			);
		}
	});
});

test("the shared runner rejects missing analyzers, empty output, and output above 50 KB", async () => {
	await withTempDirectory(async (directory) => {
		await assert.rejects(
			runComplexityAnalyzer({
				analyzerPath: join(directory, "missing.mjs"),
				invocation: { command: process.execPath, args: [] },
				cwd: directory,
				signal: new AbortController().signal,
				formatExitError: formatJavaScriptTypeScriptExitError,
				formatSpawnError: formatJavaScriptTypeScriptSpawnError,
			}),
			/Bundled complexity analyzer is missing/,
		);
		await assert.rejects(runFixture({ script: "", cwd: directory }), /returned empty output/);
		await assert.rejects(
			runFixture({ script: "process.stdout.write('x'.repeat(50 * 1024 + 1));", cwd: directory }),
			/output exceeded 50 KB/,
		);
	});
});

test("the shared runner bounds standard error and keeps the exit code", async () => {
	await withTempDirectory(async (directory) => {
		await assert.rejects(
			runFixture({
				script: "process.stderr.write('x'.repeat(60 * 1024)); process.exitCode = 2;",
				cwd: directory,
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /exited with code 2\./);
				assert.match(error.message, /\[standard error truncated\]$/);
				assert.ok(Buffer.byteLength(error.message) < 52 * 1024);
				return true;
			},
		);
	});
});

test("cancellation terminates Node and uv analyzer processes", async () => {
	await withTempDirectory(async (directory) => {
		const nodeScript =
			"import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; " +
			"writeFileSync(join(process.cwd(), 'node.pid'), String(process.pid)); setInterval(() => {}, 1000);";
		await assertCancellation(directory, "node.pid", nodeScript);

		const pythonPath = join(directory, "fixture analyzer.py");
		await writeFile(
			pythonPath,
			"import os, time\nfrom pathlib import Path\nPath('python.pid').write_text(str(os.getpid()))\nwhile True:\n    time.sleep(1)\n",
			"utf8",
		);
		const controller = new AbortController();
		const running = runComplexityAnalyzer({
			analyzerPath: pythonPath,
			invocation: { command: "uv", args: ["run", pythonPath] },
			cwd: directory,
			signal: controller.signal,
			formatExitError: formatPythonExitError,
			formatSpawnError: formatPythonSpawnError,
		});
		const pid = Number(await waitForFile(join(directory, "python.pid")));
		controller.abort();
		await assert.rejects(running, ComplexityCancelledError);
		await waitForProcessExit(pid);
	});
});

test("the wall-clock timeout terminates the analyzer process", async () => {
	await withTempDirectory(async (directory) => {
		const script =
			"import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; " +
			"writeFileSync(join(process.cwd(), 'timeout.pid'), String(process.pid)); setInterval(() => {}, 1000);";
		const running = runFixture({
			script,
			cwd: directory,
			timeoutMs: 1_000,
			timeoutError: () => new ComplexityTimeoutError("test time limit exceeded"),
		});
		const rejected = assert.rejects(running, (error: unknown) => {
			assert.ok(error instanceof ComplexityTimeoutError);
			assert.equal(error.message, "test time limit exceeded");
			return true;
		});
		const pid = Number(await waitForFile(join(directory, "timeout.pid")));
		await rejected;
		await waitForProcessExit(pid);
	});
});

async function assertCancellation(directory: string, pidFile: string, script: string): Promise<void> {
	const controller = new AbortController();
	const running = runFixture({ script, cwd: directory, signal: controller.signal });
	const pid = Number(await waitForFile(join(directory, pidFile)));
	assert.ok(pid > 0);
	controller.abort();
	await assert.rejects(running, ComplexityCancelledError);
	await waitForProcessExit(pid);
}

async function waitForFile(path: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			return await readFile(path, "utf8");
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Process ${pid} remained alive`);
}
