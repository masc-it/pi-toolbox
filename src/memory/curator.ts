import { spawn } from "node:child_process";
import type { PiInvocation } from "../pi/invocation.ts";
import { getPiInvocation } from "../pi/invocation.ts";
import type { MemoryQueueRow } from "./queue.ts";

export const MEMORY_CURATOR_MODEL = "openai-codex/gpt-5.6-luna";
export const MEMORY_CURATOR_THINKING_LEVEL = "medium";

const CURATOR_TOOLS = "read,write,edit,find,ls";
const CURATOR_PROMPT = `You maintain the knowledge base in the current directory.

The input facts belong to one project and are ordered from oldest to newest.

For each fact:
- Add it when it is new.
- Do nothing when it is already current.
- Replace older knowledge when it contradicts a newer fact.
- Keep unrelated current knowledge.
- Put it in its assigned topic and the clearest concept document.

Read the relevant concepts, then use edit to update each complete target document, including its frontmatter when needed. Use write for new concepts. Keep frontmatter valid YAML and quote string values that contain whitespace. Update index.md when concepts change.`;

export interface CuratorBatch {
	cwd: string;
	rows: MemoryQueueRow[];
}

export type PiInvocationResolver = (args: string[]) => PiInvocation;

export class MemoryCurator {
	constructor(private readonly resolveInvocation: PiInvocationResolver = getPiInvocation) {}

	curate(batch: CuratorBatch, knowledgeBaseDirectory: string, signal: AbortSignal): Promise<void> {
		const prompt = `${CURATOR_PROMPT}

Project working directory: ${batch.cwd}

Facts:
${JSON.stringify(
	batch.rows.map((row) => ({ topic: row.topic, fact: row.fact })),
	null,
	2,
)}`;
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-approve",
			"--no-extensions",
			"--model",
			MEMORY_CURATOR_MODEL,
			"--thinking",
			MEMORY_CURATOR_THINKING_LEVEL,
			"--tools",
			CURATOR_TOOLS,
			prompt,
		];
		const invocation = this.resolveInvocation(args);

		return new Promise<void>((resolve, reject) => {
			const child = spawn(invocation.command, invocation.args, {
				cwd: knowledgeBaseDirectory,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdoutBuffer = "";
			let stderr = "";
			let modelError = "";
			let settled = false;
			let forceKillTimer: NodeJS.Timeout | undefined;

			const finish = (callback: () => void) => {
				if (settled) {
					return;
				}
				settled = true;
				signal.removeEventListener("abort", abortChild);
				if (forceKillTimer) {
					clearTimeout(forceKillTimer);
				}
				callback();
			};
			const abortChild = () => {
				child.kill("SIGTERM");
				forceKillTimer = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) {
						child.kill("SIGKILL");
					}
				}, 5_000);
			};

			const processLine = (line: string) => {
				if (line.trim().length === 0) {
					return;
				}
				let event: unknown;
				try {
					event = JSON.parse(line) as unknown;
				} catch {
					return;
				}
				if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) {
					return;
				}
				if (event.message.stopReason === "error" && typeof event.message.errorMessage === "string") {
					modelError = event.message.errorMessage;
				}
			};

			child.stdout.on("data", (chunk: Buffer | string) => {
				stdoutBuffer += chunk.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) {
					processLine(line);
				}
			});
			child.stderr.on("data", (chunk: Buffer | string) => {
				stderr = `${stderr}${chunk.toString()}`.slice(-64 * 1024);
			});
			child.on("error", (error) => finish(() => reject(error)));
			child.on("close", (code) => {
				if (stdoutBuffer.trim().length > 0) {
					processLine(stdoutBuffer);
				}
				finish(() => {
					if (signal.aborted) {
						reject(new DOMException("Memory curator stopped", "AbortError"));
						return;
					}
					if (code !== 0 || modelError) {
						reject(new Error(modelError || stderr.trim() || `Memory curator exited with code ${code ?? "unknown"}`));
						return;
					}
					resolve();
				});
			});

			if (signal.aborted) {
				abortChild();
			} else {
				signal.addEventListener("abort", abortChild, { once: true });
			}
		});
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
