import { readdirSync } from "node:fs";
import type { WorkflowModelProfile } from "../domain.ts";
import type { WorkflowModelClient } from "../model/client.ts";
import {
	isMemoryFactSupport,
	isMemoryTopic,
	MEMORY_TOPICS,
	type MemoryFactSupport,
	type MemoryTopic,
} from "./config.ts";
import type { ExtractableMemoryExchange, MemoryExchangeMessage } from "./queue.ts";

export const MEMORY_EXTRACTOR_PROFILE: WorkflowModelProfile = {
	provider: "openai-codex",
	model: "gpt-5.6-luna",
	thinkingLevel: "off",
};

function buildExtractorSystemPrompt(memoryTopics: readonly string[]): string {
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
- Assign each fact exactly one available topic when applicable.
- If no topic applies, propose a concise lowercase kebab-case topic.
- Use the working directory only to name a project mentioned in the exchange. Never extract the directory itself as a fact.
- Return JSON only. Return an empty facts list when there is no durable knowledge.

Available topics:
${JSON.stringify(memoryTopics)}

Output example:
{"facts":[{"supportedBy":"agent","topic":"projects","fact":"OPM V2 requests bypass the VLM worker."}]}`;
}

export interface ExtractedMemoryFact {
	supportedBy: MemoryFactSupport;
	topic: MemoryTopic;
	fact: string;
}

export interface MemoryExtractionExchange {
	cwd: string;
	messages: Array<Pick<MemoryExchangeMessage, "sentBy" | "content">>;
}

type ExtractorModelClient = Pick<WorkflowModelClient, "completeText">;
type MemoryTopicProvider = () => string[] | Promise<string[]>;

export class MemoryExtractor {
	constructor(
		private readonly modelClient: ExtractorModelClient,
		private readonly getMemoryTopics: MemoryTopicProvider = () => [...MEMORY_TOPICS],
	) {}

	async extract(exchange: MemoryExtractionExchange, signal: AbortSignal): Promise<ExtractedMemoryFact[]> {
		const memoryTopics = await this.getMemoryTopics();
		const output = await this.modelClient.completeText({
			profile: MEMORY_EXTRACTOR_PROFILE,
			systemPrompt: buildExtractorSystemPrompt(memoryTopics),
			prompt: buildExtractorExchangePrompt(exchange),
			signal,
		});
		return parseExtractorOutput(output);
	}
}

export function listMemoryTopics(knowledgeBaseDirectory: string): string[] {
	return readdirSync(knowledgeBaseDirectory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && isMemoryTopic(entry.name))
		.map((entry) => entry.name)
		.sort();
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

export function parseExtractorOutput(output: string): ExtractedMemoryFact[] {
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
		if (!isRecord(item) || !hasOnlyKeys(item, ["supportedBy", "topic", "fact"])) {
			throw new Error(`Memory extractor fact ${index + 1} has an invalid shape`);
		}
		if (!isMemoryFactSupport(item.supportedBy)) {
			throw new Error(`Memory extractor fact ${index + 1} has invalid support`);
		}
		if (!isMemoryTopic(item.topic)) {
			throw new Error(`Memory extractor fact ${index + 1} has an invalid topic`);
		}
		if (typeof item.fact !== "string" || item.fact.trim().length === 0) {
			throw new Error(`Memory extractor fact ${index + 1} has empty text`);
		}
		return { supportedBy: item.supportedBy, topic: item.topic, fact: item.fact.trim() };
	});
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
