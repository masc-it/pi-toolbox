import { fileURLToPath } from "node:url";
import type { ProcessResult } from "../process/runner.ts";
import {
	ComplexityTimeoutError,
	type ComplexityResult,
	runComplexityAnalyzer,
} from "./complexity-runner.ts";

const ANALYZER_PATH = fileURLToPath(new URL("../../scripts/javascript_typescript_complexity.mjs", import.meta.url));
export const JAVASCRIPT_TYPESCRIPT_ANALYSIS_TIMEOUT_MS = 5 * 60 * 1_000;
const PROMPT_PREFIX =
	"Propose how to reduce the code complexity in the highest-offending JavaScript or TypeScript file shown below. Focus on the reported hotspots, preserve behavior and public types, and do not optimize solely for the heuristic.\n\n";

export function analyzeJavaScriptTypeScriptRepository(
	cwd: string,
	signal: AbortSignal,
): Promise<ComplexityResult> {
	return runComplexityAnalyzer({
		analyzerPath: ANALYZER_PATH,
		invocation: { command: process.execPath, args: [ANALYZER_PATH, "--repo-root", cwd] },
		cwd,
		signal,
		formatExitError: formatJavaScriptTypeScriptExitError,
		formatSpawnError: formatJavaScriptTypeScriptSpawnError,
		timeoutMs: JAVASCRIPT_TYPESCRIPT_ANALYSIS_TIMEOUT_MS,
		timeoutError: () =>
			new ComplexityTimeoutError("JavaScript and TypeScript complexity analysis exceeded the five-minute time limit"),
	});
}

export function buildJavaScriptTypeScriptComplexityPrompt(report: string): string {
	return `${PROMPT_PREFIX}${report}`;
}

export function formatJavaScriptTypeScriptSpawnError(error: unknown): Error {
	return new Error(
		`Unable to start the JavaScript and TypeScript complexity analyzer: ${error instanceof Error ? error.message : String(error)}`,
	);
}

export function formatJavaScriptTypeScriptExitError(result: ProcessResult, stderr: string): string {
	const exitLabel = result.code === null ? `signal ${result.signal ?? "unknown"}` : `code ${result.code}`;
	const reason =
		result.code === 2
			? "Invalid arguments, source discovery failure, or repository boundary failure."
			: result.code === 3
				? "No production JavaScript or TypeScript files were found."
				: result.code === 4
					? "A JavaScript or TypeScript file could not be read, decoded, or parsed."
					: result.code === 5
						? "The JavaScript and TypeScript complexity analyzer encountered an internal invariant failure."
						: result.code === 6
							? "A source file count or byte limit was exceeded."
							: "The JavaScript and TypeScript complexity analyzer failed.";
	return `JavaScript and TypeScript complexity analyzer exited with ${exitLabel}. ${reason}${stderr}`;
}
