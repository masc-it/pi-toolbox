import type {
	FeatureSpec,
	FeatureSpecDetail,
	ProjectContext,
	SpecDocument,
	SpecQuestion,
	SpecRevision,
	WorkflowModelProfile,
} from "../domain.ts";
import type { FeatureSpecRepository } from "../db/repositories.ts";
import { WorkflowModelClient } from "../model/client.ts";
import {
	buildInterviewPrompt,
	buildRefinementPrompt,
	buildReviewPrompt,
	FEATURE_INTERVIEW_SYSTEM_PROMPT,
	FEATURE_REVIEW_SYSTEM_PROMPT,
} from "../model/prompts.ts";
import { parseInterviewDecision, parseSpecDocument, parseSpecDocumentValue } from "../model/schemas.ts";
import { formatRepositoryContext, RepositoryInspector } from "../project/repository-context.ts";

export type FeatureSpecProgress =
	| { kind: "question"; detail: FeatureSpecDetail; question: SpecQuestion }
	| { kind: "review"; detail: FeatureSpecDetail; revision: SpecRevision };

export type FeatureSpecGenerationStage = "evaluating_requirements" | "producing_plan";

export class FeatureSpecWorkflow {
	constructor(
		private readonly repository: FeatureSpecRepository,
		private readonly modelClient: WorkflowModelClient,
		private readonly repositoryInspector: RepositoryInspector,
	) {}

	async createDraft(input: {
		project: ProjectContext;
		brief: string;
		profile: WorkflowModelProfile;
	}): Promise<FeatureSpec> {
		const brief = input.brief.trim();
		if (brief.length === 0) {
			throw new Error("Describe the feature before creating a draft");
		}
		return this.repository.createDraft({
			projectId: input.project.project.id,
			title: deriveFeatureTitle(brief),
			brief,
			modelProfile: input.profile,
		});
	}

	async resume(
		featureSpecId: string,
		checkoutRoot: string,
		signal: AbortSignal,
		onGenerationStage?: (stage: FeatureSpecGenerationStage) => void,
	): Promise<FeatureSpecProgress> {
		const detail = await this.requireDetail(featureSpecId);
		if (detail.feature.stage === "approved") {
			throw new Error("Approved specifications are reference-only in Feature Spec");
		}
		if (detail.feature.stage === "review" && detail.review) {
			return { kind: "review", detail, revision: detail.review };
		}

		const unanswered = detail.questions.find((question) => !question.answer);
		if (unanswered) {
			return { kind: "question", detail, question: unanswered };
		}
		if (detail.questions.length >= 10) {
			return this.generateReview(detail, checkoutRoot, signal, onGenerationStage);
		}

		onGenerationStage?.("evaluating_requirements");
		const repositoryContext = await this.inspectRepository(checkoutRoot);
		const response = await this.modelClient.completeText({
			profile: detail.feature.modelProfile,
			systemPrompt: FEATURE_INTERVIEW_SYSTEM_PROMPT,
			prompt: buildInterviewPrompt(detail, repositoryContext),
			signal,
		});
		const decision = parseInterviewDecision(response);
		if (decision.readyForReview) {
			if (detail.questions.length === 0) {
				throw new Error("The requirements interview must ask at least one question");
			}
			return this.generateReview(detail, checkoutRoot, signal, onGenerationStage, repositoryContext);
		}
		if (!decision.question) {
			throw new Error("The interview model did not provide a question");
		}

		const sequence = detail.questions.length + 1;
		const question = await this.repository.saveQuestion({
			featureSpecId,
			prompt: decision.question.prompt,
			choices: decision.question.choices,
			estimatedQuestionCount: Math.max(sequence, decision.question.estimatedQuestionCount),
		});
		const updated = await this.requireDetail(featureSpecId);
		return { kind: "question", detail: updated, question };
	}

	async answerAndResume(input: {
		questionId: string;
		featureSpecId: string;
		answer: string;
		checkoutRoot: string;
		signal: AbortSignal;
		onGenerationStage?: (stage: FeatureSpecGenerationStage) => void;
	}): Promise<FeatureSpecProgress> {
		await this.repository.saveAnswer(input.questionId, input.answer);
		return this.resume(input.featureSpecId, input.checkoutRoot, input.signal, input.onGenerationStage);
	}

	async replaceModelProfile(featureSpecId: string, profile: WorkflowModelProfile): Promise<void> {
		await this.repository.updateModelProfile(featureSpecId, profile);
	}

	async getDetail(featureSpecId: string): Promise<FeatureSpecDetail> {
		return this.requireDetail(featureSpecId);
	}

	async editReview(featureSpecId: string, value: unknown): Promise<SpecRevision> {
		const document = parseSpecDocumentValue(value);
		return this.repository.saveReview({ featureSpecId, document });
	}

	async refineReview(input: {
		featureSpecId: string;
		instructions: string;
		checkoutRoot: string;
		signal: AbortSignal;
	}): Promise<SpecRevision> {
		const detail = await this.requireDetail(input.featureSpecId);
		if (!detail.review) {
			throw new Error("Generate a specification before requesting refinement");
		}
		const instructions = input.instructions.trim();
		if (instructions.length === 0) {
			throw new Error("Refinement instructions cannot be empty");
		}
		const repositoryContext = await this.inspectRepository(input.checkoutRoot);
		const response = await this.modelClient.completeText({
			profile: detail.feature.modelProfile,
			systemPrompt: FEATURE_REVIEW_SYSTEM_PROMPT,
			prompt: buildRefinementPrompt(detail, detail.review.document, instructions, repositoryContext),
			signal: input.signal,
		});
		return this.repository.saveReview({ featureSpecId: input.featureSpecId, document: parseSpecDocument(response) });
	}

	async approve(featureSpecId: string, revisionId: string): Promise<FeatureSpec> {
		return this.repository.approve(featureSpecId, revisionId);
	}

	private async generateReview(
		detail: FeatureSpecDetail,
		checkoutRoot: string,
		signal: AbortSignal,
		onGenerationStage?: (stage: FeatureSpecGenerationStage) => void,
		repositoryContext?: string,
	): Promise<FeatureSpecProgress> {
		onGenerationStage?.("producing_plan");
		const context = repositoryContext ?? (await this.inspectRepository(checkoutRoot));
		const response = await this.modelClient.completeText({
			profile: detail.feature.modelProfile,
			systemPrompt: FEATURE_REVIEW_SYSTEM_PROMPT,
			prompt: buildReviewPrompt(detail, context),
			signal,
		});
		const revision = await this.repository.saveReview({
			featureSpecId: detail.feature.id,
			document: parseSpecDocument(response),
		});
		const updated = await this.requireDetail(detail.feature.id);
		return { kind: "review", detail: updated, revision };
	}

	private async inspectRepository(checkoutRoot: string): Promise<string> {
		return formatRepositoryContext(await this.repositoryInspector.inspect(checkoutRoot));
	}

	private async requireDetail(featureSpecId: string): Promise<FeatureSpecDetail> {
		const detail = await this.repository.getById(featureSpecId);
		if (!detail) {
			throw new Error(`Feature ${featureSpecId} does not exist`);
		}
		return detail;
	}
}

function deriveFeatureTitle(brief: string): string {
	const firstLine = brief.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "Untitled feature";
	return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77).trimEnd()}…`;
}
