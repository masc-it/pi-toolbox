import { readdirSync } from "node:fs";
import type { WorkflowModelProfile } from "../domain.ts";
import type { WorkflowModelClient } from "../model/client.ts";
import { isMemoryTopic, MEMORY_TOPICS, type MemorySender, type MemoryTopic } from "./config.ts";

export const MEMORY_EXTRACTOR_PROFILE: WorkflowModelProfile = {
	provider: "openai-codex",
	model: "gpt-5.6-luna",
	thinkingLevel: "off",
};

function buildExtractorSystemPrompt(memoryTopics: readonly string[]): string {
	return `You extract durable facts from a conversation message, sent either by the user or a coding agent.

Rules:
- Extract only facts stated directly in the event.
- Ignore requests and actions unless they also state a fact.
- Write each fact as one clear, self-contained sentence, using simplified english.
- Assign each fact exactly one available topic when applicable.
- If no topic applies, propose a concise lowercase kebab-case topic.
- Use the working directory only to name a project mentioned in the event. Never extract the directory itself as a fact.
- Return JSON only. Return an empty facts list when there are no facts.

Available topics:
${JSON.stringify(memoryTopics)}

Output example:
{"facts":[{"topic":"projects","fact":"Uses TypeScript."}]}`;
}

export interface ExtractedMemoryFact {
	topic: MemoryTopic;
	fact: string;
}

export interface MemoryExtractionEvent {
	cwd: string;
	sentBy: MemorySender;
	content: string;
}

type ExtractorModelClient = Pick<WorkflowModelClient, "completeText">;
type MemoryTopicProvider = () => string[];

export class MemoryExtractor {
	constructor(
		private readonly modelClient: ExtractorModelClient,
		private readonly getMemoryTopics: MemoryTopicProvider = () => [...MEMORY_TOPICS],
	) {}

	async extract(event: MemoryExtractionEvent, signal: AbortSignal): Promise<ExtractedMemoryFact[]> {
		const output = await this.modelClient.completeText({
			profile: MEMORY_EXTRACTOR_PROFILE,
			systemPrompt: buildExtractorSystemPrompt(this.getMemoryTopics()),
			prompt: buildExtractorEventPrompt(event),
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

export function buildExtractorEventPrompt(event: MemoryExtractionEvent): string {
	return `Working directory: ${event.cwd}
Sent by: ${event.sentBy}

Event:
${event.content}`;
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
		if (!isRecord(item) || !hasOnlyKeys(item, ["topic", "fact"])) {
			throw new Error(`Memory extractor fact ${index + 1} has an invalid shape`);
		}
		if (!isMemoryTopic(item.topic)) {
			throw new Error(`Memory extractor fact ${index + 1} has an invalid topic`);
		}
		if (typeof item.fact !== "string" || item.fact.trim().length === 0) {
			throw new Error(`Memory extractor fact ${index + 1} has empty text`);
		}
		return { topic: item.topic, fact: item.fact.trim() };
	});
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
