import { stat } from "node:fs/promises";
import { runProcess, type ProcessInvocation, type ProcessResult } from "../process/runner.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;

export interface ComplexityResult {
	report: string;
}

export class ComplexityCancelledError extends Error {
	constructor() {
		super("Repository complexity analysis was cancelled");
		this.name = "ComplexityCancelledError";
	}
}

export class ComplexityTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ComplexityTimeoutError";
	}
}

export interface ComplexityAnalyzerRunOptions {
	analyzerPath: string;
	invocation: ProcessInvocation;
	cwd: string;
	signal: AbortSignal;
	formatExitError: (result: ProcessResult, stderrDetails: string) => string;
	formatSpawnError: (error: unknown) => Error;
	timeoutMs?: number;
	timeoutError?: () => Error;
}

export async function runComplexityAnalyzer(options: ComplexityAnalyzerRunOptions): Promise<ComplexityResult> {
	if (options.signal.aborted) throw new ComplexityCancelledError();
	await assertAnalyzerExists(options.analyzerPath);

	const cancellationError = new ComplexityCancelledError();
	const outputLimitError = new Error("Complexity analyzer output exceeded 50 KB");
	const timeoutError = options.timeoutError?.();
	let result: ProcessResult;
	try {
		result = await runProcess({
			invocation: options.invocation,
			cwd: options.cwd,
			signal: options.signal,
			abortError: () => cancellationError,
			maxStdoutBytes: MAX_OUTPUT_BYTES,
			stdoutLimitError: () => outputLimitError,
			maxStderrBytes: MAX_OUTPUT_BYTES,
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			...(timeoutError === undefined ? {} : { timeoutError: () => timeoutError }),
		});
	} catch (error) {
		if (error === cancellationError || error === outputLimitError || error === timeoutError) throw error;
		throw options.formatSpawnError(error);
	}

	const stderrDetails = formatStderrDetails(result);
	if (result.code !== 0) throw new Error(options.formatExitError(result, stderrDetails));

	const report = result.stdout.toString("utf8");
	if (report.trim().length === 0) throw new Error("Complexity analyzer returned empty output");
	return { report };
}

async function assertAnalyzerExists(analyzerPath: string): Promise<void> {
	try {
		const details = await stat(analyzerPath);
		if (!details.isFile()) throw new Error("path is not a file");
	} catch (error) {
		throw new Error(
			`Bundled complexity analyzer is missing at ${analyzerPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function formatStderrDetails(result: ProcessResult): string {
	if (result.stderr) {
		return ` ${result.stderr}${result.stderrTruncated ? " [standard error truncated]" : ""}`;
	}
	return result.stderrTruncated ? " Standard error was truncated." : "";
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
