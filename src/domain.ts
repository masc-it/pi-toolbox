import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type WorkflowId = "prompt_polish" | "feature_spec" | "implementation";

export interface WorkflowModelProfile {
	provider: string;
	model: string;
	thinkingLevel: ModelThinkingLevel;
}

export interface ToolboxConfig {
	models: Record<WorkflowId, WorkflowModelProfile | null>;
}

export type ToolboxView = "landing" | "polish" | "feature-spec-list" | "implementation-list";

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
	provider: "openai",
	model: "gpt-5.6-luna",
	thinkingLevel: "high",
};
