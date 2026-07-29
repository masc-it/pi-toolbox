import type { Api, Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { THINKING_LEVELS, type WorkflowModelProfile } from "../domain.ts";
import { supportsThinkingLevel } from "../model/client.ts";

const VISIBLE_MODEL_COUNT = 9;

type PickerStage = "model" | "thinking" | "persistence";

export class ModelPicker {
	private readonly models: Model<Api>[];
	private stage: PickerStage = "model";
	private modelIndex: number;
	private thinkingIndex = 0;
	private persistenceIndex = 0;

	constructor(
		models: readonly Model<Api>[],
		current: WorkflowModelProfile,
		private readonly theme: Theme,
		private readonly onSelect: (profile: WorkflowModelProfile, saveAsDefault: boolean) => void,
		private readonly onCancel: () => void,
	) {
		this.models = [...models].sort(compareModels);
		const currentIndex = this.models.findIndex(
			(model) => model.provider === current.provider && model.id === current.model,
		);
		this.modelIndex = Math.max(0, currentIndex);

		const selectedModel = this.selectedModel();
		const thinkingLevels = selectedModel ? supportedThinkingLevels(selectedModel) : [];
		const currentThinkingIndex = thinkingLevels.indexOf(current.thinkingLevel);
		this.thinkingIndex = Math.max(0, currentThinkingIndex);
	}

	render(width: number): string[] {
		if (this.models.length === 0) {
			return [
				this.theme.fg("error", "No authenticated models are available."),
				"",
				this.theme.fg("dim", "Esc back"),
			];
		}

		switch (this.stage) {
			case "model":
				return this.renderModels(width);
			case "thinking":
				return this.renderThinking();
			case "persistence":
				return this.renderPersistence();
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.goBack();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.advance();
		}
	}

	private renderModels(width: number): string[] {
		const start = Math.max(
			0,
			Math.min(this.modelIndex - Math.floor(VISIBLE_MODEL_COUNT / 2), this.models.length - VISIBLE_MODEL_COUNT),
		);
		const visible = this.models.slice(start, start + VISIBLE_MODEL_COUNT);
		const lines = [this.theme.fg("accent", this.theme.bold("Select model")), ""];

		for (const [offset, model] of visible.entries()) {
			const index = start + offset;
			const selected = index === this.modelIndex;
			const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
			const identifier = `${model.provider}/${model.id}`;
			const text = selected ? this.theme.fg("accent", identifier) : this.theme.fg("text", identifier);
			lines.push(`${prefix}${truncateToWidth(text, Math.max(1, width - 2))}`);
		}

		lines.push("");
		lines.push(this.theme.fg("dim", `${this.modelIndex + 1}/${this.models.length}  ↑↓ navigate  Enter select  Esc back`));
		return lines;
	}

	private renderThinking(): string[] {
		const model = this.selectedModel();
		if (!model) {
			return [];
		}
		const levels = supportedThinkingLevels(model);
		const lines = [this.theme.fg("accent", this.theme.bold("Select thinking effort")), ""];
		for (const [index, level] of levels.entries()) {
			const selected = index === this.thinkingIndex;
			lines.push(selected ? this.theme.fg("accent", `> ${level}`) : `  ${level}`);
		}
		lines.push("");
		lines.push(this.theme.fg("dim", "↑↓ navigate  Enter select  Esc back"));
		return lines;
	}

	private renderPersistence(): string[] {
		const actions = ["Use Once", "Save as Default"];
		const lines = [this.theme.fg("accent", this.theme.bold("Apply model profile")), ""];
		for (const [index, action] of actions.entries()) {
			const selected = index === this.persistenceIndex;
			lines.push(selected ? this.theme.fg("accent", `> ${action}`) : `  ${action}`);
		}
		lines.push("");
		lines.push(this.theme.fg("dim", "↑↓ navigate  Enter confirm  Esc back"));
		return lines;
	}

	private move(direction: -1 | 1): void {
		const itemCount = this.currentItemCount();
		if (itemCount === 0) {
			return;
		}
		const current = this.currentIndex();
		this.setCurrentIndex((current + direction + itemCount) % itemCount);
	}

	private advance(): void {
		if (this.models.length === 0) {
			return;
		}
		if (this.stage === "model") {
			this.stage = "thinking";
			this.thinkingIndex = 0;
			return;
		}
		if (this.stage === "thinking") {
			this.stage = "persistence";
			return;
		}

		const model = this.selectedModel();
		const thinkingLevel = model ? supportedThinkingLevels(model)[this.thinkingIndex] : undefined;
		if (!model || !thinkingLevel) {
			return;
		}
		this.onSelect(
			{ provider: model.provider, model: model.id, thinkingLevel },
			this.persistenceIndex === 1,
		);
	}

	private goBack(): void {
		if (this.stage === "persistence") {
			this.stage = "thinking";
			return;
		}
		if (this.stage === "thinking") {
			this.stage = "model";
			return;
		}
		this.onCancel();
	}

	private currentItemCount(): number {
		if (this.stage === "model") {
			return this.models.length;
		}
		if (this.stage === "thinking") {
			const model = this.selectedModel();
			return model ? supportedThinkingLevels(model).length : 0;
		}
		return 2;
	}

	private currentIndex(): number {
		if (this.stage === "model") {
			return this.modelIndex;
		}
		if (this.stage === "thinking") {
			return this.thinkingIndex;
		}
		return this.persistenceIndex;
	}

	private setCurrentIndex(index: number): void {
		if (this.stage === "model") {
			this.modelIndex = index;
			return;
		}
		if (this.stage === "thinking") {
			this.thinkingIndex = index;
			return;
		}
		this.persistenceIndex = index;
	}

	private selectedModel(): Model<Api> | undefined {
		return this.models[this.modelIndex];
	}
}

function supportedThinkingLevels(model: Model<Api>): WorkflowModelProfile["thinkingLevel"][] {
	return THINKING_LEVELS.filter((level) => supportsThinkingLevel(model, level));
}

function compareModels(left: Model<Api>, right: Model<Api>): number {
	return left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id);
}
