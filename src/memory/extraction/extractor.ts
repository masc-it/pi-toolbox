import type { PiInvocation } from "../../pi/invocation.ts";
import { getPiInvocation } from "../../pi/invocation.ts";
import { runHeadlessAgent } from "../../pi/headless-agent.ts";
import type { MemoryRoutingContext } from "../config.ts";
import {
	MEMORY_EXTRACTOR_PROFILE,
	buildExtractorExchangePrompt,
	buildExtractorSystemPrompt,
	parseExtractorOutput,
	type ExtractedMemoryFact,
	type MemoryExtractionExchange,
} from "../extractor.ts";

export type ExtractionPiInvocationResolver = (args: string[]) => PiInvocation;

export class HeadlessMemoryExtractor {
	constructor(private readonly resolveInvocation: ExtractionPiInvocationResolver = getPiInvocation) {}

	async extract(
		exchange: MemoryExtractionExchange,
		routing: MemoryRoutingContext,
		signal: AbortSignal,
	): Promise<ExtractedMemoryFact[]> {
		const result = await runHeadlessAgent({
			invocation: this.resolveInvocation(buildHeadlessExtractorArgs(exchange, routing)),
			cwd: exchange.cwd,
			signal,
			abortMessage: "Memory extractor stopped",
			exitLabel: "Memory extractor",
		});
		return parseExtractorOutput(result.finalText, new Set(routing.availableCollections));
	}
}

export function buildHeadlessExtractorArgs(
	exchange: MemoryExtractionExchange,
	routing: MemoryRoutingContext,
): string[] {
	return [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-approve",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-tools",
		"--system-prompt",
		buildExtractorSystemPrompt(routing),
		"--model",
		`${MEMORY_EXTRACTOR_PROFILE.provider}/${MEMORY_EXTRACTOR_PROFILE.model}`,
		"--thinking",
		MEMORY_EXTRACTOR_PROFILE.thinkingLevel,
		buildExtractorExchangePrompt(exchange),
	];
}
