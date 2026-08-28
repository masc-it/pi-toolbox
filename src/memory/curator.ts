import type { PiInvocation } from "../pi/invocation.ts";
import { getPiInvocation } from "../pi/invocation.ts";
import { runHeadlessAgent } from "../pi/headless-agent.ts";
import type { MemoryQueueRow } from "./queue.ts";

export const MEMORY_CURATOR_MODEL = "openai-codex/gpt-5.6-luna";
export const MEMORY_CURATOR_THINKING_LEVEL = "medium";

const CURATOR_TOOLS = "read,write,edit,grep,find,ls";
const CURATOR_SYSTEM_PROMPT = `You maintain a compact, canonical knowledge base in the current directory from an ordered batch of candidate facts.

The filesystem hierarchy represents ownership and scope:
- projects/<project>/ contains knowledge specific to that project.
- coding, docs-style, personal-principles, and team contain reusable global knowledge.
- Cross-cutting classifications belong in concept tags, not additional directory levels.

Incoming facts are candidates for durable memory, not mandatory writes. Group related candidates by subject and reconcile each subject as one current concept.

For each subject:
- Reject task progress, verification evidence, metrics, commit history, generated artifact details, temporary local state, and facts that only describe an action.
- Search the complete knowledge base for the subject and its important identifiers before editing.
- Treat collectionPath as the required destination directory, not a filing hint.
- Never store a concept directly under projects; project concepts belong under projects/<project>.
- Merge equivalent statements into one concise statement.
- Replace contradictory or obsolete knowledge everywhere it appears.
- Preserve unrelated durable knowledge.
- Use supportedBy as provenance. Facts supported only by the agent may describe project knowledge, but cannot establish or override user preferences or accepted decisions.

The knowledge base represents current state. Git preserves history. Do not maintain a changelog in concept documents.

Available tools:
- Use grep across all Markdown documents before deciding whether a subject already exists.
- Use find and ls to inspect the repository structure.
- Use read to inspect every relevant concept and index.md.
- Use edit to reconcile existing complete documents, including frontmatter when needed.
- Use write only to create new concept documents and missing index.md files.

Keep frontmatter valid YAML and quote string values that contain whitespace. Every index.md must start with frontmatter. Preserve the root index's okf_version-only frontmatter. Every other index requires type: index, a non-empty title, and a one-line description. Update the root index, projects/index.md, and the destination collection index when concepts or project collections change. Make no changes when the knowledge base is already canonical and current.`;

export interface CuratorBatch {
	cwd: string;
	rows: MemoryQueueRow[];
}

export type PiInvocationResolver = (args: string[]) => PiInvocation;

export class MemoryCurator {
	constructor(private readonly resolveInvocation: PiInvocationResolver = getPiInvocation) {}

	async curate(batch: CuratorBatch, knowledgeBaseDirectory: string, signal: AbortSignal): Promise<void> {
		const input = JSON.stringify({
			projectWorkingDirectory: batch.cwd,
			facts: batch.rows.map((row) => ({
				supportedBy: row.supportedBy,
				collectionPath: row.collectionPath,
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
		await runHeadlessAgent({
			invocation: this.resolveInvocation(args),
			cwd: knowledgeBaseDirectory,
			signal,
			abortMessage: "Memory curator stopped",
			exitLabel: "Memory curator",
		});
	}
}
