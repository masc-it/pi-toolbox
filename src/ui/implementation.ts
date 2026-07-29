import type { Api, Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ToolboxConfigStore } from "../config.ts";
import type { ImplementationCandidate, ImplementationStatus, ProjectContext, WorkflowModelProfile } from "../domain.ts";
import type { ImplementationRepository } from "../db/repositories.ts";
import { formatModelProfile } from "../model/client.ts";
import { ModelPicker } from "./model-picker.ts";
import type { ToolboxScreen, ToolboxScreenHost } from "./screen.ts";
import { formatSpecDocument } from "./spec-document.ts";

type ImplementationMode = "loading" | "list" | "detail" | "selecting-model" | "error";

interface ImplementationScreenOptions {
	host: ToolboxScreenHost;
	theme: Theme;
	models: readonly Model<Api>[];
	defaultProfile: WorkflowModelProfile;
	configStore: ToolboxConfigStore;
	repository: ImplementationRepository;
	resolveProject: () => Promise<ProjectContext>;
}

const STATUS_ORDER: readonly ImplementationStatus[] = ["todo", "in_progress", "paused", "qa_pending", "done"];
const STATUS_LABELS: Record<ImplementationStatus, string> = {
	todo: "TODO",
	in_progress: "IN PROGRESS",
	paused: "PAUSED",
	qa_pending: "QA PENDING",
	done: "DONE",
};

export class ImplementationScreen implements ToolboxScreen {
	private mode: ImplementationMode = "loading";
	private project: ProjectContext | null = null;
	private candidates: ImplementationCandidate[] = [];
	private selectedIndex = 0;
	private selectedProfile: WorkflowModelProfile;
	private selectedCandidate: ImplementationCandidate | null = null;
	private detailOffset = 0;
	private detailLineCount = 0;
	private errorMessage = "";
	private modelPicker: ModelPicker | null = null;

	constructor(private readonly options: ImplementationScreenOptions) {
		this.selectedProfile = options.defaultProfile;
		void this.load();
	}

	render(width: number): string[] {
		if (this.mode === "selecting-model" && this.modelPicker) {
			return this.modelPicker.render(width);
		}
		if (this.mode === "loading") {
			return [this.renderProject(), "", this.options.theme.fg("accent", "Loading implementation candidates…")];
		}
		if (this.mode === "error") {
			return [
				this.options.theme.fg("error", this.errorMessage),
				"",
				this.options.theme.fg("dim", "Enter retry  Esc back"),
			];
		}
		if (this.mode === "detail") {
			return this.renderDetail(width);
		}
		return this.renderList(width);
	}

	handleInput(data: string): void {
		if (this.mode === "selecting-model" && this.modelPicker) {
			this.modelPicker.handleInput(data);
			this.options.host.requestRender();
			return;
		}
		if (this.mode === "loading") {
			if (matchesKey(data, Key.escape)) {
				this.options.host.back();
			}
			return;
		}
		if (this.mode === "error") {
			if (matchesKey(data, Key.enter)) {
				void this.load();
			} else if (matchesKey(data, Key.escape)) {
				this.options.host.back();
			}
			return;
		}
		if (this.mode === "detail") {
			this.handleDetailInput(data);
			return;
		}
		this.handleListInput(data);
	}

	invalidate(): void {}

	private async load(): Promise<void> {
		this.mode = "loading";
		this.options.host.requestRender();
		try {
			this.project = await this.options.resolveProject();
			this.candidates = (await this.options.repository.listCandidates(this.project.project.id)).sort(
				(left, right) => statusPosition(left) - statusPosition(right),
			);
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.candidates.length - 1));
			this.mode = "list";
			this.options.host.requestRender();
		} catch (error) {
			this.errorMessage = errorMessage(error);
			this.mode = "error";
			this.options.host.requestRender();
		}
	}

	private renderList(width: number): string[] {
		const lines = [this.renderProject(), this.renderProfile(), ""];
		let candidateIndex = 0;
		for (const status of STATUS_ORDER) {
			lines.push(this.options.theme.fg("accent", this.options.theme.bold(STATUS_LABELS[status])));
			const group = this.candidates.filter((candidate) => candidate.feature.implementationStatus === status);
			if (group.length === 0) {
				lines.push(this.options.theme.fg("dim", "  (none)"));
				continue;
			}
			for (const candidate of group) {
				const selected = candidateIndex === this.selectedIndex;
				const prefix = selected ? this.options.theme.fg("accent", "> ") : "  ";
				const taskSummary = `${candidate.completedTaskCount}/${candidate.taskCount} tasks`;
				const available = Math.max(10, width - taskSummary.length - 5);
				const title =
					candidate.feature.title.length > available
						? `${candidate.feature.title.slice(0, available - 1)}…`
						: candidate.feature.title;
				const styledTitle = selected ? this.options.theme.fg("accent", title) : this.options.theme.fg("text", title);
				lines.push(`${prefix}${styledTitle}  ${this.options.theme.fg("muted", taskSummary)}`);
				candidateIndex += 1;
			}
		}
		lines.push("");
		lines.push(this.options.theme.fg("dim", "↑↓ navigate  Enter inspect  M model  Esc back"));
		return lines;
	}

	private renderDetail(width: number): string[] {
		const candidate = this.selectedCandidate;
		if (!candidate) {
			return [this.options.theme.fg("error", "Implementation candidate is unavailable")];
		}
		const documentLines = formatSpecDocument(candidate.revision.document).flatMap((line) =>
			wrapTextWithAnsi(line, Math.max(1, width)),
		);
		this.detailLineCount = documentLines.length;
		this.detailOffset = Math.min(this.detailOffset, Math.max(0, documentLines.length - 1));
		const visible = documentLines.slice(this.detailOffset, this.detailOffset + 15);
		const status = candidate.feature.implementationStatus ?? "todo";
		const lines = [
			this.renderProject(),
			this.options.theme.fg("accent", this.options.theme.bold(candidate.feature.title)),
			this.options.theme.fg("muted", `${STATUS_LABELS[status]} · ${candidate.taskCount} tasks`),
			"",
			...visible,
		];
		if (documentLines.length > visible.length) {
			lines.push(this.options.theme.fg("dim", `${this.detailOffset + 1}-${this.detailOffset + visible.length}/${documentLines.length}`));
		}
		lines.push("", this.options.theme.fg("dim", "↑↓ scroll  Esc back · Start unlocks after this QA checkpoint"));
		return lines;
	}

	private renderProject(): string {
		return this.options.theme.fg("muted", `Project: ${this.project?.repositoryLabel ?? "resolving…"}`);
	}

	private renderProfile(): string {
		return this.options.theme.fg(
			"muted",
			`Model: ${formatModelProfile(this.selectedProfile)} · Thinking: ${this.selectedProfile.thinkingLevel}`,
		);
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, Key.up) && this.candidates.length > 0) {
			this.selectedIndex = (this.selectedIndex - 1 + this.candidates.length) % this.candidates.length;
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) && this.candidates.length > 0) {
			this.selectedIndex = (this.selectedIndex + 1) % this.candidates.length;
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, "m")) {
			this.openModelPicker();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const candidate = this.candidates[this.selectedIndex];
			if (candidate) {
				this.selectedCandidate = candidate;
				this.detailOffset = 0;
				this.mode = "detail";
				this.options.host.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.options.host.back();
		}
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.detailOffset = Math.max(0, this.detailOffset - 1);
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.detailOffset = Math.min(Math.max(0, this.detailLineCount - 1), this.detailOffset + 1);
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.selectedCandidate = null;
			this.mode = "list";
			this.options.host.requestRender();
		}
	}

	private openModelPicker(): void {
		this.modelPicker = new ModelPicker(
			this.options.models,
			this.selectedProfile,
			this.options.theme,
			(profile, saveAsDefault) => this.selectModelProfile(profile, saveAsDefault),
			() => this.closeModelPicker(),
		);
		this.mode = "selecting-model";
		this.options.host.requestRender();
	}

	private selectModelProfile(profile: WorkflowModelProfile, saveAsDefault: boolean): void {
		this.selectedProfile = profile;
		this.modelPicker = null;
		this.mode = "list";
		this.options.host.requestRender();
		if (saveAsDefault) {
			void this.options.configStore.saveModelProfile("implementation", profile).catch((error: unknown) => {
				this.errorMessage = errorMessage(error);
				this.mode = "error";
				this.options.host.requestRender();
			});
		}
	}

	private closeModelPicker(): void {
		this.modelPicker = null;
		this.mode = "list";
		this.options.host.requestRender();
	}
}

function statusPosition(candidate: ImplementationCandidate): number {
	const status = candidate.feature.implementationStatus ?? "todo";
	return STATUS_ORDER.indexOf(status);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
