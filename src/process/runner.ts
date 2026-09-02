import { spawn } from "node:child_process";

const KILL_DELAY_MS = 5_000;
const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;

export interface ProcessInvocation {
	command: string;
	args: string[];
}

export interface ProcessResult {
	stdout: Buffer;
	stderr: string;
	stderrTruncated: boolean;
	code: number | null;
	signal: NodeJS.Signals | null;
}

interface RunProcessOptions {
	invocation: ProcessInvocation;
	cwd: string;
	signal: AbortSignal;
	abortError: () => Error;
	maxStdoutBytes?: number;
	stdoutLimitError?: () => Error;
	maxStderrBytes?: number;
	timeoutMs?: number;
	timeoutError?: () => Error;
	collectStdout?: boolean;
	onStdoutChunk?: (chunk: Buffer) => void;
}

export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
	if (options.signal.aborted) return Promise.reject(options.abortError());

	return new Promise((resolve, reject) => {
		const child = spawn(options.invocation.command, options.invocation.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		const collectStdout = options.collectStdout ?? true;
		const stderrLimit = options.maxStderrBytes ?? DEFAULT_STDERR_LIMIT_BYTES;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let stderrTruncated = false;
		let terminalError: Error | null = null;
		let killTimer: NodeJS.Timeout | null = null;
		let timeoutTimer: NodeJS.Timeout | null = null;
		let settled = false;

		const cleanup = () => {
			options.signal.removeEventListener("abort", abort);
			if (killTimer) clearTimeout(killTimer);
			if (timeoutTimer) clearTimeout(timeoutTimer);
		};
		const finishError = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const terminate = (error: Error) => {
			if (terminalError || settled) return;
			terminalError = error;
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, KILL_DELAY_MS);
		};
		const abort = () => terminate(options.abortError());

		child.stdout.on("data", (value: Buffer | string) => {
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
			stdoutBytes += chunk.length;
			if (options.maxStdoutBytes !== undefined && stdoutBytes > options.maxStdoutBytes) {
				terminate(options.stdoutLimitError?.() ?? new Error("Process output exceeded its size limit"));
				return;
			}
			if (collectStdout) stdoutChunks.push(chunk);
			options.onStdoutChunk?.(chunk);
		});
		child.stderr.on("data", (value: Buffer | string) => {
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
			const remaining = stderrLimit - stderrBytes;
			if (remaining <= 0) {
				stderrTruncated = true;
				return;
			}
			const kept = chunk.subarray(0, remaining);
			stderrChunks.push(kept);
			stderrBytes += kept.length;
			stderrTruncated ||= kept.length < chunk.length;
		});
		child.once("error", (error) => finishError(error));
		child.once("close", (code, processSignal) => {
			if (settled) return;
			if (terminalError) {
				finishError(terminalError);
				return;
			}
			settled = true;
			cleanup();
			resolve({
				stdout: Buffer.concat(stdoutChunks),
				stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
				stderrTruncated,
				code,
				signal: processSignal,
			});
		});

		options.signal.addEventListener("abort", abort, { once: true });
		if (options.timeoutMs !== undefined) {
			timeoutTimer = setTimeout(
				() => terminate(options.timeoutError?.() ?? new Error("Process exceeded its time limit")),
				options.timeoutMs,
			);
		}
		if (options.signal.aborted) abort();
	});
}
