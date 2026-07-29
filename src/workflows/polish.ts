import type { WorkflowModelProfile } from "../domain.ts";
import { WorkflowModelClient } from "../model/client.ts";
import { PROMPT_POLISH_SYSTEM_PROMPT } from "../model/prompts.ts";

export class PromptPolishWorkflow {
	constructor(private readonly modelClient: WorkflowModelClient) {}

	async polish(source: string, profile: WorkflowModelProfile, signal: AbortSignal): Promise<string> {
		const prompt = source.trim();
		if (prompt.length === 0) {
			throw new Error("Enter a prompt before opening Prompt Polish");
		}

		return this.modelClient.completeText({
			profile,
			systemPrompt: PROMPT_POLISH_SYSTEM_PROMPT,
			prompt,
			signal,
		});
	}
}
