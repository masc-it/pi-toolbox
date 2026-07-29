import type { Api, Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { WorkflowModelProfile } from "../domain.ts";
import { formatModelProfile, supportsThinkingLevel } from "../model/client.ts";
import type { PromptPolishWorkflow } from "../workflows/polish.ts";
import { ModelPicker } from "./model-picker.ts";
import type { ToolboxScreen, ToolboxScreenHost } from "./screen.ts";

type PolishMode = "ready" | "selecting-model" | "generating" | "result" | "editing" | "error";
type PickerReturnMode = "ready" | "result" | "error";

interface PromptPolishScreenOptions {
	host: ToolboxScreenHost;
	tui: TUI;
	theme: Theme;
	source: string;
	profile: WorkflowModelProfile;
	models: readonly Model<Api>[];
	workflow: PromptPolishWorkflow;
	onAccept: (text: string) => void;
	onSaveDefault: (profile: WorkflowModelProfile) => Promise<void>;
}

export class PromptPolishScreen implements ToolboxScreen {
	private mode: PolishMode = "ready";
	private profile: WorkflowModelProfile;
	private result = "";
	private errorMessage = "";
	private actionIndex = 0;
	private pickerReturnMode: PickerReturnMode = "ready";
	private modelPicker: ModelPicker | null = null;
	private request: AbortController | null = null;
	private readonly editor: Editor;

	constructor(private readonly options: PromptPolishScreenOptions) {
		this.profile = options.profile;
		this.editor = new Editor(options.tui, createEditorTheme(options.theme));
		this.editor.onSubmit = (value) => this.finishEditing(value);

		const profileAvailable = options.models.some(
			(model) =>
				model.provider === this.profile.provider &&
				model.id === this.profile.model &&
				supportsThinkingLevel(model, this.profile.thinkingLevel),
		);
		if (!profileAvailable) {
			this.openModelPicker("ready");
		}
	}

	render(width: number): string[] {
		if (this.mode === "selecting-model" && this.modelPicker) {
			return this.modelPicker.render(width);
		}

		const lines = [this.renderProfile(), ""];
		lines.push(...renderTextSection("Source", this.options.source, width, this.options.theme));

		if (this.mode === "generating") {
			lines.push("", this.options.theme.fg("accent", "Polishing…"));
			lines.push(this.options.theme.fg("dim", "Esc cancel request"));
			return lines;
		}
		if (this.mode === "editing") {
			lines.push("", this.options.theme.fg("accent", this.options.theme.bold("Edit polished prompt")), "");
			lines.push(...this.editor.render(width));
			lines.push("", this.options.theme.fg("dim", "Enter save  Shift+Enter newline  Esc discard edits"));
			return lines;
		}
		if (this.mode === "result") {
			lines.push("", ...renderTextSection("Polished", this.result, width, this.options.theme));
			lines.push("", this.renderActions(["Accept", "Edit", "Retry", "Cancel"]));
			lines.push(this.options.theme.fg("dim", "←→/↑↓ select  Enter confirm  Esc back"));
			return lines;
		}
		if (this.mode === "error") {
			lines.push("", this.options.theme.fg("error", this.errorMessage));
			lines.push("", this.renderActions(["Retry", "Model", "Cancel"]));
			lines.push(this.options.theme.fg("dim", "←→/↑↓ select  Enter confirm  Esc back"));
			return lines;
		}

		lines.push("", this.renderActions(["Polish", "Model", "Cancel"]));
		lines.push(this.options.theme.fg("dim", "←→/↑↓ select  Enter confirm  Esc back"));
		return lines;
	}

	handleInput(data: string): void {
		if (this.mode === "selecting-model" && this.modelPicker) {
			this.modelPicker.handleInput(data);
			this.options.host.requestRender();
			return;
		}
		if (this.mode === "generating") {
			if (matchesKey(data, Key.escape)) {
				this.cancelRequest();
			}
			return;
		}
		if (this.mode === "editing") {
			if (matchesKey(data, Key.escape)) {
				this.mode = "result";
				this.options.host.requestRender();
				return;
			}
			this.editor.handleInput(data);
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.options.host.back();
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
			this.moveAction(-1);
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
			this.moveAction(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.runSelectedAction();
		}
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	dispose(): void {
		this.request?.abort();
		this.request = null;
	}

	private renderProfile(): string {
		const model = formatModelProfile(this.profile);
		return `${this.options.theme.fg("muted", "Model:")} ${this.options.theme.fg("text", model)}  ${this.options.theme.fg("muted", "Thinking:")} ${this.options.theme.fg("text", this.profile.thinkingLevel)}`;
	}

	private renderActions(actions: readonly string[]): string {
		return actions
			.map((action, index) => {
				return index === this.actionIndex
					? this.options.theme.fg("accent", `[ ${action} ]`)
					: this.options.theme.fg("muted", `  ${action}  `);
			})
			.join(" ");
	}

	private moveAction(direction: -1 | 1): void {
		const actionCount = this.mode === "result" ? 4 : 3;
		this.actionIndex = (this.actionIndex + direction + actionCount) % actionCount;
		this.options.host.requestRender();
	}

	private runSelectedAction(): void {
		if (this.mode === "result") {
			this.runResultAction();
			return;
		}
		if (this.mode === "error") {
			this.runErrorAction();
			return;
		}
		this.runReadyAction();
	}

	private runReadyAction(): void {
		if (this.actionIndex === 0) {
			this.startPolish();
			return;
		}
		if (this.actionIndex === 1) {
			this.openModelPicker("ready");
			return;
		}
		this.options.host.close();
	}

	private runResultAction(): void {
		if (this.actionIndex === 0) {
			this.options.onAccept(this.result);
			this.options.host.close();
			return;
		}
		if (this.actionIndex === 1) {
			this.editor.setText(this.result);
			this.mode = "editing";
			this.options.host.requestRender();
			return;
		}
		if (this.actionIndex === 2) {
			this.startPolish();
			return;
		}
		this.options.host.close();
	}

	private runErrorAction(): void {
		if (this.actionIndex === 0) {
			this.startPolish();
			return;
		}
		if (this.actionIndex === 1) {
			this.openModelPicker("error");
			return;
		}
		this.options.host.close();
	}

	private startPolish(): void {
		if (this.options.source.trim().length === 0) {
			this.showError("Enter a prompt in the Pi editor before opening Prompt Polish");
			return;
		}

		const request = new AbortController();
		this.request = request;
		this.mode = "generating";
		this.options.host.requestRender();

		void this.options.workflow
			.polish(this.options.source, this.profile, request.signal)
			.then((result) => {
				if (this.request !== request || request.signal.aborted) {
					return;
				}
				this.request = null;
				this.result = result;
				this.actionIndex = 0;
				this.mode = "result";
				this.options.host.requestRender();
			})
			.catch((error: unknown) => {
				if (this.request !== request || request.signal.aborted) {
					return;
				}
				this.request = null;
				this.showError(errorMessage(error));
			});
	}

	private cancelRequest(): void {
		this.request?.abort();
		this.request = null;
		this.mode = "ready";
		this.actionIndex = 0;
		this.options.host.requestRender();
	}

	private finishEditing(value: string): void {
		if (value.trim().length === 0) {
			this.showError("The polished prompt cannot be empty");
			return;
		}
		this.result = value;
		this.mode = "result";
		this.actionIndex = 0;
		this.options.host.requestRender();
	}

	private openModelPicker(returnMode: PickerReturnMode): void {
		this.pickerReturnMode = returnMode;
		this.modelPicker = new ModelPicker(
			this.options.models,
			this.profile,
			this.options.theme,
			(profile, saveAsDefault) => this.selectProfile(profile, saveAsDefault),
			() => this.closeModelPicker(),
		);
		this.mode = "selecting-model";
		this.options.host.requestRender();
	}

	private selectProfile(profile: WorkflowModelProfile, saveAsDefault: boolean): void {
		this.profile = profile;
		this.closeModelPicker();
		if (!saveAsDefault) {
			return;
		}

		void this.options.onSaveDefault(profile).catch((error: unknown) => {
			this.showError(errorMessage(error));
		});
	}

	private closeModelPicker(): void {
		this.modelPicker = null;
		this.mode = this.pickerReturnMode;
		this.actionIndex = 0;
		this.options.host.requestRender();
	}

	private showError(message: string): void {
		this.errorMessage = message;
		this.mode = "error";
		this.actionIndex = 0;
		this.options.host.requestRender();
	}
}

function renderTextSection(label: string, text: string, width: number, theme: Theme): string[] {
	const wrapped = wrapTextWithAnsi(text.length > 0 ? text : "(empty)", Math.max(1, width));
	const visible = wrapped.slice(0, 7);
	if (wrapped.length > visible.length && visible.length > 0) {
		visible[visible.length - 1] = `${visible[visible.length - 1]}…`;
	}
	return [theme.fg("accent", theme.bold(label)), ...visible.map((line) => theme.fg("text", line))];
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
