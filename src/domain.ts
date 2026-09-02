import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface WorkflowModelProfile {
	provider: string;
	model: string;
	thinkingLevel: ModelThinkingLevel;
}

export interface ToolboxConfig {
	models: {
		prompt_polish: WorkflowModelProfile;
	};
}

export type ToolboxView = "landing" | "polish" | "context-finder" | "complexity" | "js-ts-complexity";

export const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export const DEFAULT_PROMPT_POLISH_PROFILE: WorkflowModelProfile = {
	provider: "openai-codex",
	model: "gpt-5.6-luna",
	thinkingLevel: "high",
};
