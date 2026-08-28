import { StringDecoder } from "node:string_decoder";
import { runProcess, type ProcessInvocation } from "../process/runner.ts";

export interface HeadlessAgentProgress {
	toolCalls: number;
	lastTool?: string;
}

interface RunHeadlessAgentOptions {
	invocation: ProcessInvocation;
	cwd: string;
	signal: AbortSignal;
	abortMessage: string;
	exitLabel: string;
	onProgress?: (progress: HeadlessAgentProgress) => void;
}

export interface HeadlessAgentResult {
	finalText: string;
	toolCalls: number;
}

export async function runHeadlessAgent(options: RunHeadlessAgentOptions): Promise<HeadlessAgentResult> {
	const output = new HeadlessAgentOutput(options.onProgress);
	const result = await runProcess({
		invocation: options.invocation,
		cwd: options.cwd,
		signal: options.signal,
		abortError: () => new DOMException(options.abortMessage, "AbortError"),
		collectStdout: false,
		onStdoutChunk: (chunk) => output.push(chunk),
	});
	output.finish();

	if (result.code !== 0 || output.modelError) {
		const stderr = result.stderr || (result.stderrTruncated ? "Standard error was truncated." : "");
		throw new Error(output.modelError || stderr || `${options.exitLabel} exited with code ${result.code ?? "unknown"}`);
	}
	return { finalText: output.finalText, toolCalls: output.toolCalls };
}

class HeadlessAgentOutput {
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";
	finalText = "";
	modelError = "";
	toolCalls = 0;

	constructor(private readonly onProgress?: (progress: HeadlessAgentProgress) => void) {}

	push(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		this.drainLines();
	}

	finish(): void {
		this.buffer += this.decoder.end();
		if (this.buffer.trim().length > 0) this.processLine(this.buffer);
		this.buffer = "";
	}

	private drainLines(): void {
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) this.processLine(line);
	}

	private processLine(line: string): void {
		if (line.trim().length === 0) return;
		let event: unknown;
		try {
			event = JSON.parse(line) as unknown;
		} catch {
			return;
		}
		if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) return;
		const message = event.message;
		if (message.stopReason === "error" && typeof message.errorMessage === "string") {
			this.modelError = message.errorMessage;
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) return;

		for (const part of message.content) {
			if (isRecord(part) && part.type === "toolCall" && typeof part.name === "string") {
				this.toolCalls++;
				this.onProgress?.({ toolCalls: this.toolCalls, lastTool: part.name });
			}
		}
		const text = message.content
			.filter((part): part is { type: "text"; text: string } =>
				isRecord(part) && part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text.length > 0) this.finalText = text;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
