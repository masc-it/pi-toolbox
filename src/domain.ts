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

export interface Project {
	id: string;
	name: string;
	primaryRepositoryKey: string;
	createdAt: string;
	updatedAt: string;
}

export interface ProjectCheckout {
	id: string;
	projectId: string;
	root: string;
	lastSeenAt: string;
}

export interface ProjectContext {
	project: Project;
	checkout: ProjectCheckout;
	repositoryLabel: string;
}

export type SpecStage = "draft" | "interview" | "review" | "approved";
export type ImplementationStatus = "todo" | "in_progress" | "paused" | "qa_pending" | "done";
export type TaskKind = "implementation" | "user_qa";
export type TaskStatus = "todo" | "in_progress" | "done";

export interface FeatureSpec {
	id: string;
	projectId: string;
	title: string;
	brief: string;
	stage: SpecStage;
	modelProfile: WorkflowModelProfile;
	implementationStatus?: ImplementationStatus;
	approvedRevisionId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface SpecQuestion {
	id: string;
	featureSpecId: string;
	sequence: number;
	prompt: string;
	choices: string[];
	answer?: string;
	createdAt: string;
}

export interface QaTaskDetails {
	checkpointRationale: string;
	setupInstructions: string[];
	scenarios: string[];
	expectedResults: string[];
	stressAreas: string[];
	failureReportGuidance: string;
}

export interface PlannedTask {
	key: string;
	kind: TaskKind;
	title: string;
	objective: string;
	context: string;
	acceptanceCriteria: string[];
	dependencies: string[];
	qa?: QaTaskDetails;
}

export interface SpecDocument {
	problemStatement: string;
	goals: string[];
	nonGoals: string[];
	userVisibleBehavior: string[];
	constraintsAndDecisions: string[];
	acceptanceCriteria: string[];
	repositoryAreas: string[];
	risksAndUnresolvedItems: string[];
	tasks: PlannedTask[];
}

export interface SpecRevision {
	id: string;
	featureSpecId: string;
	revisionNumber: number;
	document: SpecDocument;
	createdAt: string;
	approvedAt?: string;
}

export interface Task {
	id: string;
	revisionId: string;
	kind: TaskKind;
	title: string;
	objective: string;
	context: string;
	acceptanceCriteria: string[];
	order: number;
	status: TaskStatus;
	qa?: QaTaskDetails;
}

export interface FeatureSpecDetail {
	feature: FeatureSpec;
	questions: SpecQuestion[];
	review?: SpecRevision;
}

export interface ImplementationCandidate {
	feature: FeatureSpec;
	revision: SpecRevision;
	taskCount: number;
	completedTaskCount: number;
}

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
