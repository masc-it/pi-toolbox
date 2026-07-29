import type { Api, Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { ToolboxConfigStore } from "../config.ts";
import type { FeatureSpec, FeatureSpecDetail, ProjectContext, SpecRevision, WorkflowModelProfile } from "../domain.ts";
import type { FeatureSpecRepository } from "../db/repositories.ts";
import { formatModelProfile } from "../model/client.ts";
import type { FeatureSpecProgress, FeatureSpecWorkflow } from "../workflows/feature-spec.ts";
import { ModelPicker } from "./model-picker.ts";
import type { ToolboxScreen, ToolboxScreenHost } from "./screen.ts";
import { formatSpecDocument } from "./spec-document.ts";

type FeatureMode =
	| "loading"
	| "list"
	| "creating"
	| "selecting-model"
	| "working"
	| "question"
	| "answering"
	| "review"
	| "editing-review"
	| "refining"
	| "confirming-approval"
	| "error";

interface FeatureSpecScreenOptions {
	host: ToolboxScreenHost;
	tui: TUI;
	theme: Theme;
	models: readonly Model<Api>[];
	defaultProfile: WorkflowModelProfile;
	configStore: ToolboxConfigStore;
	repository: FeatureSpecRepository;
	workflow: FeatureSpecWorkflow;
	resolveProject: () => Promise<ProjectContext>;
}

export class FeatureSpecScreen implements ToolboxScreen {
	private mode: FeatureMode = "loading";
	private project: ProjectContext | null = null;
	private features: FeatureSpec[] = [];
	private selectedIndex = 0;
	private selectedProfile: WorkflowModelProfile;
	private currentDetail: FeatureSpecDetail | null = null;
	private currentRevision: SpecRevision | null = null;
	private questionChoiceIndex = 0;
	private reviewActionIndex = 0;
	private reviewOffset = 0;
	private reviewLineCount = 0;
	private approvalIndex = 0;
	private workingMessage = "Loading project…";
	private statusMessage = "";
	private errorMessage = "";
	private editorError = "";
	private request: AbortController | null = null;
	private modelPicker: ModelPicker | null = null;
	private modelTargetFeature: FeatureSpec | null = null;
	private readonly editor: Editor;

	constructor(private readonly options: FeatureSpecScreenOptions) {
		this.selectedProfile = options.defaultProfile;
		this.editor = new Editor(options.tui, createEditorTheme(options.theme));
		this.editor.onSubmit = (value) => this.handleEditorSubmit(value);
		void this.loadProjectAndFeatures();
	}

	render(width: number): string[] {
		if (this.mode === "selecting-model" && this.modelPicker) {
			return this.modelPicker.render(width);
		}
		if (this.mode === "loading" || this.mode === "working") {
			return this.renderWorking();
		}
		if (this.mode === "creating") {
			return this.renderEditor("Describe the feature", "Enter create draft  Shift+Enter newline  Esc cancel", width);
		}
		if (this.mode === "answering") {
			return this.renderEditor("Your answer", "Enter save answer  Shift+Enter newline  Esc cancel", width);
		}
		if (this.mode === "editing-review") {
			return this.renderEditor("Edit structured specification", "Enter save revision  Shift+Enter newline  Esc discard", width);
		}
		if (this.mode === "refining") {
			return this.renderEditor("Refinement instructions", "Enter refine  Shift+Enter newline  Esc cancel", width);
		}
		if (this.mode === "question") {
			return this.renderQuestion(width);
		}
		if (this.mode === "review" || this.mode === "confirming-approval") {
			return this.renderReview(width);
		}
		if (this.mode === "error") {
			return [
				this.options.theme.fg("error", this.errorMessage),
				"",
				this.options.theme.fg("dim", "Enter return to list  Esc back"),
			];
		}
		return this.renderList(width);
	}

	handleInput(data: string): void {
		if (this.mode === "selecting-model" && this.modelPicker) {
			this.modelPicker.handleInput(data);
			this.options.host.requestRender();
			return;
		}
		if (this.mode === "loading" || this.mode === "working") {
			if (matchesKey(data, Key.escape)) {
				this.cancelOperation();
			}
			return;
		}
		if (isEditorMode(this.mode)) {
			this.handleEditorInput(data);
			return;
		}
		if (this.mode === "question") {
			this.handleQuestionInput(data);
			return;
		}
		if (this.mode === "review" || this.mode === "confirming-approval") {
			this.handleReviewInput(data);
			return;
		}
		if (this.mode === "error") {
			if (matchesKey(data, Key.enter)) {
				void this.loadFeatures();
			} else if (matchesKey(data, Key.escape)) {
				this.options.host.back();
			}
			return;
		}
		this.handleListInput(data);
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	dispose(): void {
		this.request?.abort();
		this.request = null;
	}

	private async loadProjectAndFeatures(): Promise<void> {
		try {
			this.project = await this.options.resolveProject();
			await this.loadFeatures();
		} catch (error) {
			this.showError(errorMessage(error));
		}
	}

	private async loadFeatures(): Promise<void> {
		if (!this.project) {
			return;
		}
		this.mode = "loading";
		this.workingMessage = "Loading feature specifications…";
		this.options.host.requestRender();
		try {
			this.features = await this.options.repository.listForProject(this.project.project.id);
			this.selectedIndex = Math.min(this.selectedIndex, this.features.length);
			this.mode = "list";
			this.options.host.requestRender();
		} catch (error) {
			this.showError(errorMessage(error));
		}
	}

	private renderWorking(): string[] {
		return [
			this.renderProject(),
			"",
			this.options.theme.fg("accent", this.workingMessage),
			"",
			this.options.theme.fg("dim", "Esc cancel and return"),
		];
	}

	private renderList(width: number): string[] {
		const lines = [this.renderProject(), this.renderProfile(this.selectedProfile), ""];
		if (this.statusMessage) {
			lines.push(this.options.theme.fg("success", this.statusMessage), "");
		}
		lines.push(this.renderListItem(0, "Create Draft", "Start a requirements interview", width));
		for (const [index, feature] of this.features.entries()) {
			const status = feature.implementationStatus ? `${feature.stage} · ${feature.implementationStatus}` : feature.stage;
			lines.push(this.renderListItem(index + 1, feature.title, status, width));
		}
		lines.push("");
		lines.push(this.options.theme.fg("dim", "↑↓ navigate  Enter open  M model  Esc back"));
		return lines;
	}

	private renderListItem(index: number, label: string, detail: string, width: number): string {
		const selected = this.selectedIndex === index;
		const prefix = selected ? this.options.theme.fg("accent", "> ") : "  ";
		const available = Math.max(10, width - detail.length - 5);
		const title = label.length > available ? `${label.slice(0, available - 1)}…` : label;
		const content = selected ? this.options.theme.fg("accent", title) : this.options.theme.fg("text", title);
		return `${prefix}${content}  ${this.options.theme.fg("muted", detail)}`;
	}

	private renderQuestion(width: number): string[] {
		const detail = this.currentDetail;
		const question = detail?.questions.find((item) => !item.answer);
		if (!detail || !question) {
			return [this.options.theme.fg("error", "Interview state is unavailable")];
		}
		const lines = [
			this.renderProject(),
			this.renderProfile(detail.feature.modelProfile),
			"",
			this.options.theme.fg("muted", `${detail.feature.title} · Question ${question.sequence}/10`),
			"",
			...wrapTextWithAnsi(this.options.theme.fg("text", question.prompt), width),
			"",
		];
		const choices = [...question.choices, "Write a custom answer"];
		for (const [index, choice] of choices.entries()) {
			const selected = index === this.questionChoiceIndex;
			lines.push(selected ? this.options.theme.fg("accent", `> ${choice}`) : `  ${choice}`);
		}
		lines.push("", this.options.theme.fg("dim", "↑↓ select  Enter answer  M model  Esc save and close"));
		return lines;
	}

	private renderReview(width: number): string[] {
		const detail = this.currentDetail;
		const revision = this.currentRevision;
		if (!detail || !revision) {
			return [this.options.theme.fg("error", "Review state is unavailable")];
		}
		const formatted = formatSpecDocument(revision.document).flatMap((line) =>
			wrapTextWithAnsi(line, Math.max(1, width)),
		);
		this.reviewLineCount = formatted.length;
		this.reviewOffset = Math.min(this.reviewOffset, Math.max(0, formatted.length - 1));
		const visible = formatted.slice(this.reviewOffset, this.reviewOffset + 14);
		const lines = [
			this.renderProject(),
			this.renderProfile(detail.feature.modelProfile),
			this.options.theme.fg(
				"muted",
				`${detail.feature.title} · revision ${revision.revisionNumber}${detail.feature.stage === "approved" ? " · approved" : ""}`,
			),
			"",
			...visible,
		];
		if (formatted.length > visible.length) {
			lines.push(this.options.theme.fg("dim", `${this.reviewOffset + 1}-${this.reviewOffset + visible.length}/${formatted.length}`));
		}
		lines.push("");
		if (this.mode === "confirming-approval") {
			lines.push(this.options.theme.fg("warning", "Approve this immutable revision and create implementation tasks?"));
			lines.push(this.renderActions(["No", "Approve"], this.approvalIndex));
			lines.push(this.options.theme.fg("dim", "←→ choose  Enter confirm  Esc cancel"));
			return lines;
		}
		const actions = detail.feature.stage === "approved" ? ["Close"] : ["Edit", "Refine", "Approve", "Close"];
		lines.push(this.renderActions(actions, this.reviewActionIndex));
		lines.push(this.options.theme.fg("dim", "↑↓ scroll  Tab action  Enter select  Esc close"));
		return lines;
	}

	private renderEditor(title: string, help: string, width: number): string[] {
		const lines = [this.renderProject(), this.options.theme.fg("accent", this.options.theme.bold(title)), ""];
		if (this.editorError) {
			lines.push(this.options.theme.fg("error", this.editorError), "");
		}
		lines.push(...this.editor.render(width));
		lines.push("", this.options.theme.fg("dim", help));
		return lines;
	}

	private renderProject(): string {
		return this.project
			? this.options.theme.fg("muted", `Project: ${this.project.repositoryLabel}`)
			: this.options.theme.fg("muted", "Project: resolving…");
	}

	private renderProfile(profile: WorkflowModelProfile): string {
		return this.options.theme.fg(
			"muted",
			`Model: ${formatModelProfile(profile)} · Thinking: ${profile.thinkingLevel}`,
		);
	}

	private renderActions(actions: readonly string[], selectedIndex: number): string {
		return actions
			.map((action, index) =>
				index === selectedIndex
					? this.options.theme.fg("accent", `[ ${action} ]`)
					: this.options.theme.fg("muted", `  ${action}  `),
			)
			.join(" ");
	}

	private handleListInput(data: string): void {
		const itemCount = this.features.length + 1;
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = (this.selectedIndex - 1 + itemCount) % itemCount;
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = (this.selectedIndex + 1) % itemCount;
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, "m")) {
			this.openModelPicker(this.selectedIndex === 0 ? null : this.features[this.selectedIndex - 1] ?? null);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.selectedIndex === 0) {
				this.editor.setText("");
				this.editorError = "";
				this.mode = "creating";
				this.options.host.requestRender();
				return;
			}
			const feature = this.features[this.selectedIndex - 1];
			if (feature) {
				this.openFeature(feature);
			}
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.options.host.back();
		}
	}

	private handleQuestionInput(data: string): void {
		const question = this.currentDetail?.questions.find((item) => !item.answer);
		if (!question) {
			return;
		}
		const choiceCount = question.choices.length + 1;
		if (matchesKey(data, Key.up)) {
			this.questionChoiceIndex = (this.questionChoiceIndex - 1 + choiceCount) % choiceCount;
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.questionChoiceIndex = (this.questionChoiceIndex + 1) % choiceCount;
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, "m")) {
			this.openModelPicker(this.currentDetail?.feature ?? null);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.questionChoiceIndex === question.choices.length) {
				this.editor.setText("");
				this.editorError = "";
				this.mode = "answering";
				this.options.host.requestRender();
				return;
			}
			const answer = question.choices[this.questionChoiceIndex];
			if (answer) {
				this.submitAnswer(answer);
			}
			return;
		}
		if (matchesKey(data, Key.escape)) {
			void this.loadFeatures();
		}
	}

	private handleReviewInput(data: string): void {
		if (this.mode === "confirming-approval") {
			if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
				this.approvalIndex = this.approvalIndex === 0 ? 1 : 0;
				this.options.host.requestRender();
			} else if (matchesKey(data, Key.enter)) {
				if (this.approvalIndex === 1) {
					this.approveCurrentRevision();
				} else {
					this.mode = "review";
					this.options.host.requestRender();
				}
			} else if (matchesKey(data, Key.escape)) {
				this.mode = "review";
				this.options.host.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.reviewOffset = Math.max(0, this.reviewOffset - 1);
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.reviewOffset = Math.min(Math.max(0, this.reviewLineCount - 1), this.reviewOffset + 1);
			this.options.host.requestRender();
			return;
		}
		const actionCount = this.currentDetail?.feature.stage === "approved" ? 1 : 4;
		if (matchesKey(data, Key.tab)) {
			this.reviewActionIndex = (this.reviewActionIndex + 1) % actionCount;
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.reviewActionIndex = (this.reviewActionIndex - 1 + actionCount) % actionCount;
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.runReviewAction();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			void this.loadFeatures();
		}
	}

	private handleEditorInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.editorError = "";
			if (this.mode === "editing-review" || this.mode === "refining") {
				this.mode = "review";
			} else if (this.mode === "answering") {
				this.mode = "question";
			} else {
				this.mode = "list";
			}
			this.options.host.requestRender();
			return;
		}
		this.editor.handleInput(data);
		this.options.host.requestRender();
	}

	private handleEditorSubmit(value: string): void {
		if (this.mode === "creating") {
			this.createDraft(value);
		} else if (this.mode === "answering") {
			this.submitAnswer(value);
		} else if (this.mode === "editing-review") {
			this.saveEditedReview(value);
		} else if (this.mode === "refining") {
			this.refineReview(value);
		}
	}

	private openFeature(feature: FeatureSpec): void {
		if (feature.stage !== "approved" && !this.profileIsAvailable(feature.modelProfile)) {
			this.openModelPicker(feature);
			return;
		}
		this.startOperation("Preparing feature specification…", async (signal) => {
			if (feature.stage === "approved") {
				const detail = await this.options.workflow.getDetail(feature.id);
				if (!detail.review) {
					throw new Error("Approved specification revision is unavailable");
				}
				this.showReview(detail, detail.review);
				return;
			}
			this.applyProgress(await this.options.workflow.resume(feature.id, this.requireProject().checkout.root, signal));
		});
	}

	private createDraft(brief: string): void {
		if (brief.trim().length === 0) {
			this.editorError = "Describe the feature before creating a draft";
			this.options.host.requestRender();
			return;
		}
		this.startOperation("Creating draft and preparing the first question…", async (signal) => {
			const feature = await this.options.workflow.createDraft({
				project: this.requireProject(),
				brief,
				profile: this.selectedProfile,
			});
			this.applyProgress(
				await this.options.workflow.resume(feature.id, this.requireProject().checkout.root, signal),
			);
		});
	}

	private submitAnswer(answer: string): void {
		const detail = this.currentDetail;
		const question = detail?.questions.find((item) => !item.answer);
		if (!detail || !question) {
			return;
		}
		if (answer.trim().length === 0) {
			this.editorError = "An answer cannot be empty";
			this.options.host.requestRender();
			return;
		}
		this.startOperation("Saving answer and evaluating requirements…", async (signal) => {
			this.applyProgress(
				await this.options.workflow.answerAndResume({
					questionId: question.id,
					featureSpecId: detail.feature.id,
					answer,
					checkoutRoot: this.requireProject().checkout.root,
					signal,
				}),
			);
		});
	}

	private applyProgress(progress: FeatureSpecProgress): void {
		this.currentDetail = progress.detail;
		if (progress.kind === "question") {
			this.currentRevision = null;
			this.questionChoiceIndex = 0;
			this.mode = "question";
		} else {
			this.showReview(progress.detail, progress.revision);
		}
		this.options.host.requestRender();
	}

	private showReview(detail: FeatureSpecDetail, revision: SpecRevision): void {
		this.currentDetail = detail;
		this.currentRevision = revision;
		this.reviewActionIndex = 0;
		this.reviewOffset = 0;
		this.mode = "review";
		this.options.host.requestRender();
	}

	private runReviewAction(): void {
		if (this.currentDetail?.feature.stage === "approved" || this.reviewActionIndex === 3) {
			void this.loadFeatures();
			return;
		}
		if (this.reviewActionIndex === 0 && this.currentRevision) {
			this.editor.setText(JSON.stringify(this.currentRevision.document, null, 2));
			this.editorError = "";
			this.mode = "editing-review";
			this.options.host.requestRender();
			return;
		}
		if (this.reviewActionIndex === 1) {
			this.editor.setText("");
			this.editorError = "";
			this.mode = "refining";
			this.options.host.requestRender();
			return;
		}
		this.approvalIndex = 0;
		this.mode = "confirming-approval";
		this.options.host.requestRender();
	}

	private saveEditedReview(value: string): void {
		const detail = this.currentDetail;
		if (!detail) {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			this.editorError = "Specification must contain valid JSON";
			this.options.host.requestRender();
			return;
		}
		this.startOperation("Saving specification revision…", async () => {
			const revision = await this.options.workflow.editReview(detail.feature.id, parsed);
			const updated = await this.options.workflow.getDetail(detail.feature.id);
			this.showReview(updated, revision);
		});
	}

	private refineReview(instructions: string): void {
		const detail = this.currentDetail;
		if (!detail || instructions.trim().length === 0) {
			this.editorError = "Describe the required refinement";
			this.options.host.requestRender();
			return;
		}
		this.startOperation("Refining specification…", async (signal) => {
			const revision = await this.options.workflow.refineReview({
				featureSpecId: detail.feature.id,
				instructions,
				checkoutRoot: this.requireProject().checkout.root,
				signal,
			});
			const updated = await this.options.workflow.getDetail(detail.feature.id);
			this.showReview(updated, revision);
		});
	}

	private approveCurrentRevision(): void {
		const detail = this.currentDetail;
		const revision = this.currentRevision;
		if (!detail || !revision) {
			return;
		}
		this.startOperation("Approving specification and creating tasks…", async () => {
			await this.options.workflow.approve(detail.feature.id, revision.id);
			this.statusMessage = `${detail.feature.title} is ready for implementation`;
			await this.loadFeatures();
		});
	}

	private openModelPicker(feature: FeatureSpec | null): void {
		if (feature?.stage === "approved") {
			return;
		}
		this.modelTargetFeature = feature;
		const profile = feature?.modelProfile ?? this.selectedProfile;
		this.modelPicker = new ModelPicker(
			this.options.models,
			profile,
			this.options.theme,
			(selected, saveAsDefault) => this.selectModelProfile(selected, saveAsDefault),
			() => this.closeModelPicker(),
		);
		this.mode = "selecting-model";
		this.options.host.requestRender();
	}

	private selectModelProfile(profile: WorkflowModelProfile, saveAsDefault: boolean): void {
		const target = this.modelTargetFeature;
		this.modelPicker = null;
		this.startOperation("Saving model profile…", async () => {
			if (target) {
				await this.options.workflow.replaceModelProfile(target.id, profile);
				target.modelProfile = profile;
			} else {
				this.selectedProfile = profile;
			}
			if (saveAsDefault) {
				await this.options.configStore.saveModelProfile("feature_spec", profile);
				this.selectedProfile = profile;
			}
			await this.loadFeatures();
		});
	}

	private closeModelPicker(): void {
		this.modelPicker = null;
		this.modelTargetFeature = null;
		this.mode = "list";
		this.options.host.requestRender();
	}

	private startOperation(message: string, operation: (signal: AbortSignal) => Promise<void>): void {
		const request = new AbortController();
		this.request?.abort();
		this.request = request;
		this.mode = "working";
		this.workingMessage = message;
		this.editorError = "";
		this.options.host.requestRender();

		void operation(request.signal)
			.catch((error: unknown) => {
				if (!request.signal.aborted) {
					this.showError(errorMessage(error));
				}
			})
			.finally(() => {
				if (this.request === request) {
					this.request = null;
				}
			});
	}

	private cancelOperation(): void {
		this.request?.abort();
		this.request = null;
		if (this.project) {
			void this.loadFeatures();
		} else {
			this.options.host.back();
		}
	}

	private profileIsAvailable(profile: WorkflowModelProfile): boolean {
		return this.options.models.some((model) => model.provider === profile.provider && model.id === profile.model);
	}

	private requireProject(): ProjectContext {
		if (!this.project) {
			throw new Error("Git project context is unavailable");
		}
		return this.project;
	}

	private showError(message: string): void {
		this.errorMessage = message;
		this.mode = "error";
		this.options.host.requestRender();
	}
}

function isEditorMode(mode: FeatureMode): boolean {
	return mode === "creating" || mode === "answering" || mode === "editing-review" || mode === "refining";
}

function createEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
