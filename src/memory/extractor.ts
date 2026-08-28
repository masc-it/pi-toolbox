import type { WorkflowModelProfile } from "../domain.ts";
import type { WorkflowModelClient } from "../model/client.ts";
import {
	isMemoryCollectionPath,
	isMemoryFactSupport,
	type MemoryCollectionPath,
	type MemoryFactSupport,
	type MemoryRoutingContext,
} from "./config.ts";
import type { ExtractableMemoryExchange, MemoryExchangeMessage } from "./queue.ts";

export const MEMORY_EXTRACTOR_PROFILE: WorkflowModelProfile = {
	provider: "openai-codex",
	model: "gpt-5.6-luna",
	thinkingLevel: "off",
};

function buildExtractorSystemPrompt(routing: MemoryRoutingContext): string {
	return `You extract durable current knowledge from a complete conversation exchange between a user and a coding agent.

First identify the exchange purpose and apply the corresponding rule:
- Explanation: store stable, non-obvious project facts explained by the agent.
- Implementation: store only the durable resulting state. Ignore execution narration and verification evidence.
- Advice or design exploration: do not store proposals, recommendations, or hypotheses unless the user explicitly accepts them in the exchange.
- Verification: do not store transient results such as test, lint, build, typecheck, Git status, counts, timings, or metrics.
- Preference or decision: store an explicit durable user preference, accepted decision, convention, or constraint.

Rules:
- Extract only statements directly supported by the exchange.
- A request does not prove that the requested state exists.
- Agent explanations may establish project architecture, behavior, constraints, workflows, terminology, and durable gotchas.
- Agent statements cannot establish user preferences or accepted decisions.
- Ignore task progress, completion narration, commit hashes, generated artifact details, temporary local state, and facts that only say an action happened.
- Ignore one-time instructions unless they also establish a durable preference, convention, decision, or constraint.
- Emit one canonical fact when the user and agent repeat the same information.
- Write each fact as one clear, self-contained sentence. Preserve exact identifiers, qualifiers, scope, and negation.
- Set supportedBy to user, agent, or both according to where the fact is directly supported.
- Store facts about the current project's architecture, behavior, constraints, workflows, and conventions in the current project collection.
- Store reusable user-wide coding practices in coding, documentation preferences in docs-style, personal principles in personal-principles, and team-wide practices in team.
- Use an existing project collection only when the fact explicitly concerns that other project.
- Set collectionPath to exactly one available collection. Never invent a collection or use projects by itself.
- Never duplicate one fact across project and global collections. Use concept tags later for cross-cutting classification.
- Use the working directory only to understand the current project. Never extract the directory itself as a fact.
- Return JSON only. Return an empty facts list when there is no durable knowledge.

Current project collection: ${routing.currentProjectCollection}
Available collections:
${JSON.stringify(routing.availableCollections)}

Output example:
{"facts":[{"supportedBy":"agent","collectionPath":"${routing.currentProjectCollection}","fact":"Memory uses a dedicated worker for synchronous infrastructure."}]}`;
}

export interface ExtractedMemoryFact {
	supportedBy: MemoryFactSupport;
	collectionPath: MemoryCollectionPath;
	fact: string;
}

export interface MemoryExtractionExchange {
	cwd: string;
	messages: Array<Pick<MemoryExchangeMessage, "sentBy" | "content">>;
}

type ExtractorModelClient = Pick<WorkflowModelClient, "completeText">;

export class MemoryExtractor {
	constructor(private readonly modelClient: ExtractorModelClient) {}

	async extract(
		exchange: MemoryExtractionExchange,
		routing: MemoryRoutingContext,
		signal: AbortSignal,
	): Promise<ExtractedMemoryFact[]> {
		validateRoutingContext(routing);
		const output = await this.modelClient.completeText({
			profile: MEMORY_EXTRACTOR_PROFILE,
			systemPrompt: buildExtractorSystemPrompt(routing),
			prompt: buildExtractorExchangePrompt(exchange),
			signal,
		});
		return parseExtractorOutput(output, new Set(routing.availableCollections));
	}
}

export function toExtractionExchange(exchange: ExtractableMemoryExchange): MemoryExtractionExchange {
	return {
		cwd: exchange.cwd,
		messages: exchange.messages.map((message) => ({ sentBy: message.sentBy, content: message.content })),
	};
}

export function buildExtractorExchangePrompt(exchange: MemoryExtractionExchange): string {
	return `Working directory: ${exchange.cwd}

Conversation exchange:
${JSON.stringify(exchange.messages.map((message) => ({ role: message.sentBy, content: message.content })))}`;
}

export function parseExtractorOutput(
	output: string,
	availableCollections?: ReadonlySet<string>,
): ExtractedMemoryFact[] {
	let value: unknown;
	try {
		value = JSON.parse(output) as unknown;
	} catch (error) {
		throw new Error("Memory extractor returned invalid JSON", { cause: error });
	}

	if (!isRecord(value) || !hasOnlyKeys(value, ["facts"]) || !Array.isArray(value.facts)) {
		throw new Error("Memory extractor output must contain only a facts list");
	}

	return value.facts.map((item, index) => {
		if (!isRecord(item) || !hasOnlyKeys(item, ["supportedBy", "collectionPath", "fact"])) {
			throw new Error(`Memory extractor fact ${index + 1} has an invalid shape`);
		}
		if (!isMemoryFactSupport(item.supportedBy)) {
			throw new Error(`Memory extractor fact ${index + 1} has invalid support`);
		}
		if (!isMemoryCollectionPath(item.collectionPath)) {
			throw new Error(`Memory extractor fact ${index + 1} has an invalid collection path`);
		}
		if (availableCollections && !availableCollections.has(item.collectionPath)) {
			throw new Error(`Memory extractor fact ${index + 1} uses an unavailable collection`);
		}
		if (typeof item.fact !== "string" || item.fact.trim().length === 0) {
			throw new Error(`Memory extractor fact ${index + 1} has empty text`);
		}
		return { supportedBy: item.supportedBy, collectionPath: item.collectionPath, fact: item.fact.trim() };
	});
}

function validateRoutingContext(routing: MemoryRoutingContext): void {
	if (!isMemoryCollectionPath(routing.currentProjectCollection)) {
		throw new Error("Memory routing returned an invalid current project collection");
	}
	if (
		routing.availableCollections.length === 0 ||
		new Set(routing.availableCollections).size !== routing.availableCollections.length ||
		routing.availableCollections.some((collection) => !isMemoryCollectionPath(collection)) ||
		!routing.availableCollections.includes(routing.currentProjectCollection)
	) {
		throw new Error("Memory routing returned invalid available collections");
	}
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
