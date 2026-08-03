import type { Api, Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import type { WorkflowModelProfile } from "../domain.ts";
import { formatModelProfile, supportsThinkingLevel } from "../model/client.ts";
import type { PromptPolishWorkflow } from "../workflows/polish.ts";
import { ModelPicker } from "./model-picker.ts";
import type { ToolboxScreen, ToolboxScreenHost } from "./screen.ts";

type PolishMode = "workspace" | "selecting-model" | "generating";
type FocusTarget = "source" | "result" | "actions";
type CopyState = "idle" | "copying" | "copied" | "failed";

const ACTION_COUNT = 5;

interface PromptPolishScreenOptions {
	host: ToolboxScreenHost;
	tui: TUI;
	theme: Theme;
	source: string;
	profile: WorkflowModelProfile;
	models: readonly Model<Api>[];
	workflow: PromptPolishWorkflow;
	onAccept: (text: string) => void;
	onCopy: (text: string) => Promise<void>;
	onSaveDefault: (profile: WorkflowModelProfile) => Promise<void>;
}

export class PromptPolishScreen implements ToolboxScreen {
	private mode: PolishMode = "workspace";
	private focusTarget: FocusTarget = "source";
	private focusBeforePicker: FocusTarget = "source";
	private profile: WorkflowModelProfile;
	private errorMessage = "";
	private copyState: CopyState = "idle";
	private copyErrorMessage = "";
	private actionIndex = 0;
	private modelPicker: ModelPicker | null = null;
	private request: AbortController | null = null;
	private disposed = false;
	private hostFocused = false;
	private readonly sourceEditor: Editor;
	private readonly resultEditor: Editor;

	constructor(private readonly options: PromptPolishScreenOptions) {
		this.profile = options.profile;
		this.sourceEditor = new Editor(options.tui, createEditorTheme(options.theme));
		this.resultEditor = new Editor(options.tui, createEditorTheme(options.theme));
		this.sourceEditor.setText(options.source);
		this.sourceEditor.onChange = () => {
			this.errorMessage = "";
		};
		this.resultEditor.onChange = () => {
			this.errorMessage = "";
			this.clearCopyFeedback();
		};

		const profileAvailable = options.models.some(
			(model) =>
				model.provider === this.profile.provider &&
				model.id === this.profile.model &&
				supportsThinkingLevel(model, this.profile.thinkingLevel),
		);
		if (!profileAvailable) {
			this.openModelPicker();
		} else if (options.source.trim().length > 0) {
			queueMicrotask(() => {
				if (!this.disposed) {
					this.startPolish();
				}
			});
		}
	}

	setFocused(focused: boolean): void {
		this.hostFocused = focused;
		this.updateEditorFocus();
	}

	render(width: number): string[] {
		if (this.mode === "selecting-model" && this.modelPicker) {
			return this.modelPicker.render(width);
		}

		this.updateEditorBorders();
		const lines = [this.renderProfile(), ""];
		lines.push(this.renderEditorLabel("Source prompt", "source"));
		lines.push(...this.sourceEditor.render(width));
		lines.push("", this.renderEditorLabel("Polished prompt", "result"));
		lines.push(...this.resultEditor.render(width));

		if (this.mode === "generating") {
			lines.push("", this.options.theme.fg("accent", "Polishing…"));
		}
		if (this.errorMessage) {
			lines.push("", this.options.theme.fg("error", this.errorMessage));
		}
		if (this.copyState === "copied") {
			lines.push("", this.options.theme.fg("success", "Copied to clipboard"));
		} else if (this.copyState === "failed") {
			lines.push("", this.options.theme.fg("error", `Copy failed: ${this.copyErrorMessage}`));
		}

		const polishAction = this.mode === "generating" ? "Polishing…" : "Polish";
		const copyAction = this.copyState === "copying" ? "Copying…" : "Copy";
		lines.push("", this.renderActions([polishAction, "Model", "Accept", copyAction, "Cancel"]));
		lines.push(
			this.options.theme.fg(
				"dim",
				this.mode === "generating"
					? "Ctrl+C copy current result  Esc cancel request"
					: "Tab/Shift+Tab switch focus  Enter newline/confirm  Ctrl+Enter polish  Ctrl+C copy  Esc back",
			),
		);
		return lines;
	}

	handleInput(data: string): void {
		if (this.mode === "selecting-model" && this.modelPicker) {
			this.modelPicker.handleInput(data);
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("c")) && this.hasPolishedPrompt()) {
			this.copyResult();
			return;
		}
		if (this.mode === "generating") {
			if (matchesKey(data, Key.escape)) {
				this.cancelRequest();
			}
			return;
		}
		if (matchesKey(data, Key.ctrl("enter"))) {
			this.startPolish();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.moveFocus(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.moveFocus(-1);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.options.host.back();
			return;
		}

		if (this.focusTarget === "actions") {
			this.handleActionInput(data);
			return;
		}

		const editor = this.focusTarget === "source" ? this.sourceEditor : this.resultEditor;
		if (matchesKey(data, Key.enter)) {
			editor.handleInput("\n");
		} else {
			editor.handleInput(data);
		}
		this.options.host.requestRender();
	}

	invalidate(): void {
		this.sourceEditor.invalidate();
		this.resultEditor.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.request?.abort();
		this.request = null;
	}

	private renderProfile(): string {
		const model = formatModelProfile(this.profile);
		return `${this.options.theme.fg("muted", "Model:")} ${this.options.theme.fg("text", model)}  ${this.options.theme.fg("muted", "Thinking:")} ${this.options.theme.fg("text", this.profile.thinkingLevel)}`;
	}

	private renderEditorLabel(label: string, target: Exclude<FocusTarget, "actions">): string {
		const marker = this.focusTarget === target ? "▸ " : "  ";
		const color = this.focusTarget === target ? "accent" : "muted";
		return this.options.theme.fg(color, this.options.theme.bold(`${marker}${label}`));
	}

	private renderActions(actions: readonly string[]): string {
		return actions
			.map((action, index) => {
				const selected = this.focusTarget === "actions" && index === this.actionIndex;
				return selected
					? this.options.theme.fg("accent", `[ ${action} ]`)
					: this.options.theme.fg("muted", `  ${action}  `);
			})
			.join(" ");
	}

	private updateEditorBorders(): void {
		this.sourceEditor.borderColor = (text) =>
			this.options.theme.fg(this.focusTarget === "source" ? "accent" : "borderMuted", text);
		this.resultEditor.borderColor = (text) =>
			this.options.theme.fg(this.focusTarget === "result" ? "accent" : "borderMuted", text);
	}

	private updateEditorFocus(): void {
		const editorsInteractive = this.mode === "workspace";
		this.sourceEditor.focused = this.hostFocused && editorsInteractive && this.focusTarget === "source";
		this.resultEditor.focused = this.hostFocused && editorsInteractive && this.focusTarget === "result";
	}

	private moveFocus(direction: -1 | 1): void {
		const targets: readonly FocusTarget[] = ["source", "result", "actions"];
		const current = targets.indexOf(this.focusTarget);
		this.setFocusTarget(targets[(current + direction + targets.length) % targets.length]!);
	}

	private setFocusTarget(target: FocusTarget): void {
		this.focusTarget = target;
		this.updateEditorFocus();
		this.options.host.requestRender();
	}

	private handleActionInput(data: string): void {
		if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
			this.actionIndex = (this.actionIndex - 1 + ACTION_COUNT) % ACTION_COUNT;
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
			this.actionIndex = (this.actionIndex + 1) % ACTION_COUNT;
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.runSelectedAction();
		}
	}

	private runSelectedAction(): void {
		switch (this.actionIndex) {
			case 0:
				this.startPolish();
				return;
			case 1:
				this.openModelPicker();
				return;
			case 2:
				this.acceptResult();
				return;
			case 3:
				this.copyResult();
				return;
			default:
				this.options.host.close();
		}
	}

	private acceptResult(): void {
		const result = this.resultEditor.getExpandedText();
		if (result.trim().length === 0) {
			this.showError("Polish the prompt or enter a result before accepting");
			return;
		}
		this.options.onAccept(result);
		this.options.host.close();
	}

	private hasPolishedPrompt(): boolean {
		return this.resultEditor.getExpandedText().trim().length > 0;
	}

	private copyResult(): void {
		if (this.copyState === "copying") {
			return;
		}
		const result = this.resultEditor.getExpandedText();
		if (result.trim().length === 0) {
			this.showError("Polish the prompt or enter a result before copying");
			return;
		}

		this.copyState = "copying";
		this.copyErrorMessage = "";
		this.errorMessage = "";
		this.options.host.requestRender();

		void this.options
			.onCopy(result)
			.then(() => {
				if (this.disposed || this.resultEditor.getExpandedText() !== result) {
					return;
				}
				this.copyState = "copied";
				this.options.host.requestRender();
			})
			.catch((error: unknown) => {
				if (this.disposed || this.resultEditor.getExpandedText() !== result) {
					return;
				}
				this.copyState = "failed";
				this.copyErrorMessage = errorMessage(error);
				this.options.host.requestRender();
			});
	}

	private startPolish(): void {
		const source = this.sourceEditor.getExpandedText();
		if (source.trim().length === 0) {
			this.showError("Enter a source prompt before polishing");
			this.setFocusTarget("source");
			return;
		}

		const request = new AbortController();
		this.request = request;
		this.errorMessage = "";
		this.clearCopyFeedback();
		this.mode = "generating";
		this.updateEditorFocus();
		this.options.host.requestRender();

		void this.options.workflow
			.polish(source, this.profile, request.signal)
			.then((result) => {
				if (this.request !== request || request.signal.aborted || this.disposed) {
					return;
				}
				this.request = null;
				this.mode = "workspace";
				this.resultEditor.setText(result);
				this.setFocusTarget("result");
			})
			.catch((error: unknown) => {
				if (this.request !== request || request.signal.aborted || this.disposed) {
					return;
				}
				this.request = null;
				this.mode = "workspace";
				this.showError(errorMessage(error));
				this.updateEditorFocus();
			});
	}

	private cancelRequest(): void {
		this.request?.abort();
		this.request = null;
		this.mode = "workspace";
		this.updateEditorFocus();
		this.options.host.requestRender();
	}

	private openModelPicker(): void {
		this.focusBeforePicker = this.focusTarget;
		this.modelPicker = new ModelPicker(
			this.options.models,
			this.profile,
			this.options.theme,
			(profile, saveAsDefault) => this.selectProfile(profile, saveAsDefault),
			() => this.closeModelPicker(),
		);
		this.mode = "selecting-model";
		this.updateEditorFocus();
		this.options.host.requestRender();
	}

	private selectProfile(profile: WorkflowModelProfile, saveAsDefault: boolean): void {
		this.profile = profile;
		this.closeModelPicker();
		if (!saveAsDefault) {
			return;
		}

		void this.options.onSaveDefault(profile).catch((error: unknown) => {
			if (!this.disposed) {
				this.showError(errorMessage(error));
			}
		});
	}

	private closeModelPicker(): void {
		this.modelPicker = null;
		this.mode = "workspace";
		this.setFocusTarget(this.focusBeforePicker);
	}

	private clearCopyFeedback(): void {
		this.copyState = "idle";
		this.copyErrorMessage = "";
	}

	private showError(message: string): void {
		this.errorMessage = message;
		this.options.host.requestRender();
	}
}

function createEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("borderMuted", text),
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
