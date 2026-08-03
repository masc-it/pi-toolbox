import { completeSimple, type Api, type Model, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { WorkflowModelProfile } from "../domain.ts";

export class WorkflowModelClient {
	constructor(private readonly registry: ModelRegistry) {}

	resolve(profile: WorkflowModelProfile): Model<Api> {
		const model = this.registry.find(profile.provider, profile.model);
		if (!model) {
			throw new Error(`Model ${formatModelProfile(profile)} is not available`);
		}
		if (!supportsThinkingLevel(model, profile.thinkingLevel)) {
			throw new Error(`${formatModelProfile(profile)} does not support ${profile.thinkingLevel} thinking`);
		}
		return model;
	}

	async completeText(input: {
		profile: WorkflowModelProfile;
		systemPrompt: string;
		prompt: string;
		signal: AbortSignal;
	}): Promise<string> {
		const model = this.resolve(input.profile);
		const auth = await this.registry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			throw new Error(auth.error);
		}

		const message: UserMessage = {
			role: "user",
			content: [{ type: "text", text: input.prompt }],
			timestamp: Date.now(),
		};
		const response = await completeSimple(
			model,
			{ systemPrompt: input.systemPrompt, messages: [message] },
			{
				...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
				...(auth.headers ? { headers: auth.headers } : {}),
				...(auth.env ? { env: auth.env } : {}),
				...(input.profile.thinkingLevel === "off" ? {} : { reasoning: input.profile.thinkingLevel }),
				signal: input.signal,
			},
		);

		if (response.stopReason === "aborted") {
			throw new DOMException("Model request cancelled", "AbortError");
		}
		if (response.stopReason !== "stop") {
			throw new Error(
				response.stopReason === "error"
					? response.errorMessage ?? "Model request failed"
					: `Model request stopped with reason: ${response.stopReason}`,
			);
		}

		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();
		if (text.length === 0) {
			throw new Error("Model returned an empty response");
		}
		return text;
	}
}

export function supportsThinkingLevel(model: Model<Api>, thinkingLevel: WorkflowModelProfile["thinkingLevel"]): boolean {
	if (thinkingLevel === "off") {
		return true;
	}
	if (!model.reasoning) {
		return false;
	}
	return model.thinkingLevelMap?.[thinkingLevel] !== null;
}

export function formatModelProfile(profile: WorkflowModelProfile): string {
	return `${profile.provider}/${profile.model}`;
}
