import { fileURLToPath } from "node:url";
import type { ProcessResult } from "../process/runner.ts";
import { type ComplexityResult, isNodeError, runComplexityAnalyzer } from "./complexity-runner.ts";

const ANALYZER_PATH = fileURLToPath(new URL("../../scripts/python_complexity.py", import.meta.url));
const PROMPT_PREFIX =
	"Propose how to reduce the code complexity in the highest-offending Python file shown below.\n\n";

export { ComplexityCancelledError, type ComplexityResult } from "./complexity-runner.ts";

export function analyzeRepository(cwd: string, signal: AbortSignal): Promise<ComplexityResult> {
	return runComplexityAnalyzer({
		analyzerPath: ANALYZER_PATH,
		invocation: { command: "uv", args: ["run", ANALYZER_PATH, "--repo-root", cwd] },
		cwd,
		signal,
		formatExitError: formatPythonExitError,
		formatSpawnError: formatPythonSpawnError,
	});
}

export function buildComplexityPrompt(report: string): string {
	return `${PROMPT_PREFIX}${report}`;
}

export function formatPythonSpawnError(error: unknown): Error {
	if (isNodeError(error) && error.code === "ENOENT") {
		return new Error("Unable to run the complexity analyzer because the uv executable was not found in PATH");
	}
	return new Error(`Unable to start the complexity analyzer: ${error instanceof Error ? error.message : String(error)}`);
}

export function formatPythonExitError(result: ProcessResult, stderr: string): string {
	const exitLabel = result.code === null ? `signal ${result.signal ?? "unknown"}` : `code ${result.code}`;
	const reason =
		result.code === 2
			? "Invalid repository root or repository boundary failure."
			: result.code === 3
				? "No production Python files were found."
				: result.code === 4
					? "A Python file could not be read, decoded, or parsed."
					: result.code === 5
						? "The complexity analyzer encountered an internal invariant failure."
						: "The complexity analyzer failed.";
	return `Complexity analyzer exited with ${exitLabel}. ${reason}${stderr}`;
}
