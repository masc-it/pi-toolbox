import { spawn } from "node:child_process";
import type { PiInvocation } from "../pi/invocation.ts";
import { getPiInvocation } from "../pi/invocation.ts";
import type { MemoryQueueRow } from "./queue.ts";

export const MEMORY_CURATOR_MODEL = "openai-codex/gpt-5.6-luna";
export const MEMORY_CURATOR_THINKING_LEVEL = "medium";

const CURATOR_TOOLS = "read,write,edit,grep,find,ls";
const CURATOR_SYSTEM_PROMPT = `You maintain a compact, canonical knowledge base in the current directory from an ordered batch of candidate facts about one project.

Incoming facts are candidates for durable memory, not mandatory writes. Group related candidates by subject and reconcile each subject as one current concept.

For each subject:
- Reject task progress, verification evidence, metrics, commit history, generated artifact details, temporary local state, and facts that only describe an action.
- Search the complete knowledge base for the subject and its important identifiers before editing.
- Prefer an existing canonical concept even when it is stored under a different topic. The assigned topic is a filing hint for new concepts.
- Merge equivalent statements into one concise statement.
- Replace contradictory or obsolete knowledge everywhere it appears.
- Remove related historical statements that no longer describe current state.
- Preserve unrelated durable knowledge.
- Use supportedBy as provenance. Facts supported only by the agent may describe project knowledge, but cannot establish or override user preferences or accepted decisions.

The knowledge base represents current state. Git preserves history. Do not maintain a changelog in concept documents.

Available tools:
- Use grep across all Markdown documents before deciding where a subject belongs or whether it already exists.
- Use find and ls to inspect the repository structure.
- Use read to inspect every relevant concept and index.md.
- Use edit to reconcile existing complete documents, including frontmatter when needed.
- Use write only to create new concept documents.

Keep frontmatter valid YAML and quote string values that contain whitespace. Update index.md only when a concept is created, renamed, removed, moved, or its summary changes. Make no changes when the knowledge base is already canonical and current.`;

export interface CuratorBatch {
	cwd: string;
	rows: MemoryQueueRow[];
}

export type PiInvocationResolver = (args: string[]) => PiInvocation;

export class MemoryCurator {
	constructor(private readonly resolveInvocation: PiInvocationResolver = getPiInvocation) {}

	curate(batch: CuratorBatch, knowledgeBaseDirectory: string, signal: AbortSignal): Promise<void> {
		const input = JSON.stringify({
			projectWorkingDirectory: batch.cwd,
			facts: batch.rows.map((row) => ({
				supportedBy: row.supportedBy,
				topic: row.topic,
				fact: row.fact,
				observedAt: row.createdAt,
			})),
		});
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-approve",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--system-prompt",
			CURATOR_SYSTEM_PROMPT,
			"--model",
			MEMORY_CURATOR_MODEL,
			"--thinking",
			MEMORY_CURATOR_THINKING_LEVEL,
			"--tools",
			CURATOR_TOOLS,
			input,
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
