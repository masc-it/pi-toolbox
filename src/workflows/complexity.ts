import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runProcess } from "../process/runner.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;
const ANALYZER_PATH = fileURLToPath(new URL("../../scripts/python_complexity.py", import.meta.url));
const PROMPT_PREFIX =
	"Propose how to reduce the code complexity in the highest-offending Python file shown below. Remind of our coding principles.\n\n";

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
	if (signal.aborted) throw new ComplexityCancelledError();
	await assertAnalyzerExists();
	return runAnalyzer(cwd, signal);
}

export function buildComplexityPrompt(report: string): string {
	return `${PROMPT_PREFIX}${report}`;
}

async function assertAnalyzerExists(): Promise<void> {
	try {
		const details = await stat(ANALYZER_PATH);
		if (!details.isFile()) throw new Error("path is not a file");
	} catch (error) {
		throw new Error(
			`Bundled complexity analyzer is missing at ${ANALYZER_PATH}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function runAnalyzer(cwd: string, signal: AbortSignal): Promise<ComplexityResult> {
	const outputLimitError = new Error("Complexity analyzer output exceeded 50 KB");
	let result;
	try {
		result = await runProcess({
			invocation: { command: "uv", args: ["run", ANALYZER_PATH, "--repo-root", cwd] },
			cwd,
			signal,
			abortError: () => new ComplexityCancelledError(),
			maxStdoutBytes: MAX_OUTPUT_BYTES,
			stdoutLimitError: () => outputLimitError,
			maxStderrBytes: MAX_OUTPUT_BYTES,
		});
	} catch (error) {
		if (error instanceof ComplexityCancelledError || error === outputLimitError) throw error;
		throw spawnError(error);
	}

	const stderrDetails = result.stderr
		? ` ${result.stderr}${result.stderrTruncated ? " [standard error truncated]" : ""}`
		: result.stderrTruncated
			? " Standard error was truncated."
			: "";
	if (result.code !== 0) {
		throw new Error(formatExitError(result.code, result.signal, stderrDetails));
	}

	const report = result.stdout.toString("utf8");
	if (report.trim().length === 0) throw new Error("Complexity analyzer returned empty output");
	return { report };
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
