import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const CONTEXT_FINDER_MODEL = "openai-codex/gpt-5.6-luna";
export const CONTEXT_FINDER_THINKING_LEVEL = "medium";

const CONTEXT_FINDER_TOOLS = "read,grep,find,ls,bash";
const MAX_REFERENCES = 50;
const SYSTEM_PROMPT = `You are a read-only context finder for a coding project. Investigate the current working directory to identify the files and symbols that are most relevant to the user's prompt.

Use read, grep, find, ls, and read-only shell commands such as rg, git grep, fd, and git log to search fuzzily. Follow imports and call sites when useful. Never modify files or project state.

Return only a Markdown bullet list. Every bullet must contain an exact project-relative file path and, when applicable, a function, class, type, or other symbol. Add a line range when you can verify it and a short explanation of why the reference matters.

Required format:
- \`path/to/file.ts:10-42\` — \`functionName\` — Why this reference is relevant.

Do not include a heading, preamble, summary, code fence, or non-reference bullet. Prefer a small, high-signal set of verified references over broad guesses.`;

export interface ContextFinderProgress {
	toolCalls: number;
	lastTool?: string;
}

export class ContextFinderWorkflow {
	async find(
		prompt: string,
		cwd: string,
		signal: AbortSignal,
		onProgress?: (progress: ContextFinderProgress) => void,
	): Promise<string> {
		const query = prompt.trim();
		if (query.length === 0) {
			throw new Error("Enter a prompt before finding context");
		}

		const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-context-finder-"));
		const systemPromptPath = join(temporaryDirectory, "system.md");

		try {
			await writeFile(systemPromptPath, SYSTEM_PROMPT, { encoding: "utf8", mode: 0o600 });
			const output = await runContextAgent(query, cwd, systemPromptPath, signal, onProgress);
			return normalizeReferenceList(output);
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}
}

export function appendContextReferences(prompt: string, references: string): string {
	return `${prompt.trimEnd()}\n\nRelevant project context:\n${references.trim()}`;
}

async function runContextAgent(
	prompt: string,
	cwd: string,
	systemPromptPath: string,
	signal: AbortSignal,
	onProgress?: (progress: ContextFinderProgress) => void,
): Promise<string> {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-approve",
		"--model",
		CONTEXT_FINDER_MODEL,
		"--thinking",
		CONTEXT_FINDER_THINKING_LEVEL,
		"--tools",
		CONTEXT_FINDER_TOOLS,
		"--append-system-prompt",
		systemPromptPath,
		`Find the project references relevant to this user prompt:\n\n${prompt}`,
	];
	const invocation = getPiInvocation(args);

	return new Promise<string>((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdoutBuffer = "";
		let stderr = "";
		let finalText = "";
		let modelError = "";
		let toolCalls = 0;
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

		const processLine = (line: string) => {
			if (!line.trim()) {
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
			const message = event.message;
			if (message.role !== "assistant" || !Array.isArray(message.content)) {
				return;
			}

			for (const part of message.content) {
				if (!isRecord(part)) {
					continue;
				}
				if (part.type === "toolCall" && typeof part.name === "string") {
					toolCalls++;
					onProgress?.({ toolCalls, lastTool: part.name });
				}
			}

			const text = message.content
				.filter((part): part is { type: "text"; text: string } =>
					isRecord(part) && part.type === "text" && typeof part.text === "string",
				)
				.map((part) => part.text)
				.join("\n")
				.trim();
			if (text) {
				finalText = text;
			}
			if (message.stopReason === "error" && typeof message.errorMessage === "string") {
				modelError = message.errorMessage;
			}
		};

		const abortChild = () => {
			child.kill("SIGTERM");
			forceKillTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
				}
			}, 5_000);
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
			stderr += chunk.toString();
		});
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) => {
			if (stdoutBuffer.trim()) {
				processLine(stdoutBuffer);
			}
			finish(() => {
				if (signal.aborted) {
					reject(new DOMException("Context search cancelled", "AbortError"));
					return;
				}
				if (code !== 0 || modelError) {
					reject(new Error(modelError || stderr.trim() || `Context finder exited with code ${code ?? "unknown"}`));
					return;
				}
				if (!finalText) {
					reject(new Error("Context finder returned no references"));
					return;
				}
				resolve(finalText);
			});
		});

		if (signal.aborted) {
			abortChild();
		} else {
			signal.addEventListener("abort", abortChild, { once: true });
		}
	});
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

function normalizeReferenceList(output: string): string {
	const references = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^(?:[-*•]|\d+[.)])\s+/.test(line))
		.map((line) => line.replace(/^(?:[-*•]|\d+[.)])\s+/, "- "))
		.slice(0, MAX_REFERENCES);

	if (references.length === 0) {
		throw new Error("Context finder did not return the required bullet list");
	}
	return references.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
