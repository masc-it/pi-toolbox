import { stat } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT_BYTES = 50 * 1024;
const KILL_DELAY_MS = 5_000;
const ANALYZER_PATH = fileURLToPath(new URL("../../scripts/python_complexity.py", import.meta.url));
const PROMPT_PREFIX =
	"Propose how to reduce the code complexity in the highest-offending Python file shown below. Focus on the biggest offenders and follow our coding principles.\n\n";

export interface ComplexityResult {
	report: string;
}

export class ComplexityCancelledError extends Error {
	constructor() {
		super("Repository complexity analysis was cancelled");
		this.name = "ComplexityCancelledError";
	}
}

export async function analyzeRepository(cwd: string, signal: AbortSignal): Promise<ComplexityResult> {
	if (signal.aborted) {
		throw new ComplexityCancelledError();
	}
	await assertAnalyzerExists();
	return runAnalyzer(cwd, signal);
}

export function buildComplexityPrompt(report: string): string {
	return `${PROMPT_PREFIX}${report}`;
}

async function assertAnalyzerExists(): Promise<void> {
	try {
		const details = await stat(ANALYZER_PATH);
		if (!details.isFile()) {
			throw new Error("path is not a file");
		}
	} catch (error) {
		throw new Error(
			`Bundled complexity analyzer is missing at ${ANALYZER_PATH}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function runAnalyzer(cwd: string, signal: AbortSignal): Promise<ComplexityResult> {
	return new Promise((resolve, reject) => {
		let child: ChildProcessByStdio<null, Readable, Readable>;
		try {
			child = spawn("uv", ["run", ANALYZER_PATH, "--repo-root", cwd], {
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			reject(spawnError(error));
			return;
		}

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let stderrTruncated = false;
		let terminalError: Error | null = null;
		let killTimer: NodeJS.Timeout | null = null;
		let settled = false;

		const cleanup = () => {
			signal.removeEventListener("abort", abort);
			if (killTimer) {
				clearTimeout(killTimer);
				killTimer = null;
			}
		};
		const settleError = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const terminate = (error: Error) => {
			if (terminalError) return;
			terminalError = error;
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
				}
			}, KILL_DELAY_MS);
		};
		const abort = () => terminate(new ComplexityCancelledError());

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > MAX_OUTPUT_BYTES) {
				terminate(new Error("Complexity analyzer output exceeded 50 KB"));
				return;
			}
			stdoutChunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const remaining = MAX_OUTPUT_BYTES - stderrBytes;
			if (remaining <= 0) {
				stderrTruncated = true;
				return;
			}
			const kept = chunk.subarray(0, remaining);
			stderrChunks.push(kept);
			stderrBytes += kept.length;
			stderrTruncated ||= kept.length < chunk.length;
		});
		child.once("error", (error) => settleError(spawnError(error)));
		child.once("close", (code, processSignal) => {
			if (settled) return;
			if (terminalError) {
				settleError(terminalError);
				return;
			}

			const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
			const stderrDetails = stderr
				? ` ${stderr}${stderrTruncated ? " [standard error truncated]" : ""}`
				: stderrTruncated
					? " Standard error was truncated."
					: "";
			if (code !== 0) {
				settleError(new Error(formatExitError(code, processSignal, stderrDetails)));
				return;
			}

			const report = Buffer.concat(stdoutChunks).toString("utf8");
			if (report.trim().length === 0) {
				settleError(new Error("Complexity analyzer returned empty output"));
				return;
			}
			settled = true;
			cleanup();
			resolve({ report });
		});

		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}

function spawnError(error: unknown): Error {
	if (isNodeError(error) && error.code === "ENOENT") {
		return new Error("Unable to run the complexity analyzer because the uv executable was not found in PATH");
	}
	return new Error(`Unable to start the complexity analyzer: ${error instanceof Error ? error.message : String(error)}`);
}

function formatExitError(code: number | null, processSignal: NodeJS.Signals | null, stderr: string): string {
	const exitLabel = code === null ? `signal ${processSignal ?? "unknown"}` : `code ${code}`;
	const reason =
		code === 2
			? "Invalid repository root or repository boundary failure."
			: code === 3
				? "No production Python files were found."
				: code === 4
					? "A Python file could not be read, decoded, or parsed."
					: code === 5
						? "The complexity analyzer encountered an internal invariant failure."
						: "The complexity analyzer failed.";
	return `Complexity analyzer exited with ${exitLabel}. ${reason}${stderr}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
