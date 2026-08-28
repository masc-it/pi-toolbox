import { getPiInvocation } from "../pi/invocation.ts";
import { runHeadlessAgent, type HeadlessAgentProgress } from "../pi/headless-agent.ts";

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

export type ContextFinderProgress = HeadlessAgentProgress;

export class ContextFinderWorkflow {
	async find(
		prompt: string,
		cwd: string,
		signal: AbortSignal,
		onProgress?: (progress: ContextFinderProgress) => void,
	): Promise<string> {
		const query = prompt.trim();
		if (query.length === 0) throw new Error("Enter a prompt before finding context");

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
			SYSTEM_PROMPT,
			`Find the project references relevant to this user prompt:\n\n${query}`,
		];
		const result = await runHeadlessAgent({
			invocation: getPiInvocation(args),
			cwd,
			signal,
			abortMessage: "Context search cancelled",
			exitLabel: "Context finder",
			...(onProgress ? { onProgress } : {}),
		});
		if (result.finalText.length === 0) throw new Error("Context finder returned no references");
		return normalizeReferenceList(result.finalText);
	}
}

export function appendContextReferences(prompt: string, references: string): string {
	return `${prompt.trimEnd()}\n\nRelevant project context:\n${references.trim()}`;
}

function normalizeReferenceList(output: string): string {
	const references = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^(?:[-*•]|\d+[.)])\s+/.test(line))
		.map((line) => line.replace(/^(?:[-*•]|\d+[.)])\s+/, "- "))
		.slice(0, MAX_REFERENCES);

	if (references.length === 0) throw new Error("Context finder did not return the required bullet list");
	return references.join("\n");
}
