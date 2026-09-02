import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import {
	CONTEXT_FINDER_MODEL,
	CONTEXT_FINDER_THINKING_LEVEL,
	type ContextFinderProgress,
	ContextFinderWorkflow,
} from "../workflows/context-finder.ts";
import type { ToolboxScreen, ToolboxScreenHost } from "./screen.ts";

type ContextFinderMode = "ready" | "searching";
type FocusTarget = "prompt" | "actions";

const ACTION_COUNT = 2;

interface ContextFinderScreenOptions {
	host: ToolboxScreenHost;
	tui: TUI;
	theme: Theme;
	prompt: string;
	cwd: string;
	workflow: ContextFinderWorkflow;
	onSubmit: (prompt: string, references: string) => void;
}

export class ContextFinderScreen implements ToolboxScreen {
	private mode: ContextFinderMode = "ready";
	private focusTarget: FocusTarget = "prompt";
	private actionIndex = 0;
	private errorMessage = "";
	private progress: ContextFinderProgress = { toolCalls: 0 };
	private request: AbortController | null = null;
	private disposed = false;
	private hostFocused = false;
	private readonly promptEditor: Editor;

	constructor(private readonly options: ContextFinderScreenOptions) {
		this.promptEditor = new Editor(options.tui, createEditorTheme(options.theme));
		this.promptEditor.setText(options.prompt);
		this.promptEditor.onChange = () => {
			this.errorMessage = "";
		};

		if (options.prompt.trim().length > 0) {
			queueMicrotask(() => {
				if (!this.disposed) {
					this.startSearch();
				}
			});
		}
	}

	setFocused(focused: boolean): void {
		this.hostFocused = focused;
		this.updateEditorFocus();
	}

	render(width: number): string[] {
		this.updateEditorBorder();
		const lines = this.renderPromptSection(width);
		lines.push(...this.renderStatusLines());
		lines.push("", this.renderActions(), this.renderHelp());
		return lines;
	}

	handleInput(data: string): void {
		if (this.mode === "searching") {
			this.handleSearchingInput(data);
			return;
		}
		if (this.handleReadyShortcut(data)) return;
		if (this.focusTarget === "prompt") {
			this.handlePromptInput(data);
			return;
		}
		this.handleActionInput(data);
	}

	invalidate(): void {
		this.promptEditor.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.request?.abort();
		this.request = null;
	}

	private updateEditorBorder(): void {
		this.promptEditor.borderColor = (text) =>
			this.options.theme.fg(this.focusTarget === "prompt" ? "accent" : "borderMuted", text);
	}

	private renderPromptSection(width: number): string[] {
		return [
			`${this.options.theme.fg("muted", "Model:")} ${this.options.theme.fg("text", CONTEXT_FINDER_MODEL)}  ${this.options.theme.fg("muted", "Thinking:")} ${this.options.theme.fg("text", CONTEXT_FINDER_THINKING_LEVEL)}`,
			"",
			this.options.theme.fg(
				this.focusTarget === "prompt" ? "accent" : "muted",
				this.options.theme.bold(`${this.focusTarget === "prompt" ? "▸ " : "  "}Prompt`),
			),
			...this.promptEditor.render(width),
		];
	}

	private renderStatusLines(): string[] {
		const lines: string[] = [];
		if (this.mode === "searching") {
			lines.push("", this.options.theme.fg("accent", this.renderSearchProgress()));
		}
		if (this.errorMessage) {
			lines.push("", this.options.theme.fg("error", this.errorMessage));
		}
		return lines;
	}

	private renderSearchProgress(): string {
		if (!this.progress.lastTool) return "Finding context… inspecting the project";
		const suffix = this.progress.toolCalls === 1 ? "" : "s";
		return `Finding context… ${this.progress.toolCalls} tool call${suffix}; last: ${this.progress.lastTool}`;
	}

	private renderHelp(): string {
		const help =
			this.mode === "searching" ? "Esc cancel search" : "Tab switch focus  Ctrl+. find references  Esc back";
		return this.options.theme.fg("dim", help);
	}

	private renderActions(): string {
		const labels = [this.mode === "searching" ? "Finding…" : "Find Context", "Cancel"];
		return labels
			.map((label, index) =>
				this.focusTarget === "actions" && this.actionIndex === index
					? this.options.theme.fg("accent", `[ ${label} ]`)
					: this.options.theme.fg("muted", `  ${label}  `),
			)
			.join(" ");
	}

	private handleSearchingInput(data: string): void {
		if (matchesKey(data, Key.escape)) this.cancelSearch();
	}

	private handleReadyShortcut(data: string): boolean {
		if (matchesKey(data, Key.ctrl("."))) {
			this.startSearch();
			return true;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.toggleFocus();
			return true;
		}
		if (!matchesKey(data, Key.escape)) return false;
		this.options.host.back();
		return true;
	}

	private toggleFocus(): void {
		this.focusTarget = this.focusTarget === "prompt" ? "actions" : "prompt";
		this.updateEditorFocus();
		this.options.host.requestRender();
	}

	private handlePromptInput(data: string): void {
		this.promptEditor.handleInput(matchesKey(data, Key.enter) ? "\n" : data);
		this.options.host.requestRender();
	}

	private handleActionInput(data: string): void {
		if (isActionNavigationInput(data)) {
			this.toggleAction();
			return;
		}
		if (matchesKey(data, Key.enter)) this.runSelectedAction();
	}

	private toggleAction(): void {
		this.actionIndex = (this.actionIndex + 1) % ACTION_COUNT;
		this.options.host.requestRender();
	}

	private runSelectedAction(): void {
		if (this.actionIndex === 0) {
			this.startSearch();
			return;
		}
		this.options.host.close();
	}

	private startSearch(): void {
		const prompt = this.promptEditor.getExpandedText();
		if (prompt.trim().length === 0) {
			this.errorMessage = "Enter a prompt before finding context";
			this.focusTarget = "prompt";
			this.updateEditorFocus();
			this.options.host.requestRender();
			return;
		}

		const request = new AbortController();
		this.request = request;
		this.mode = "searching";
		this.errorMessage = "";
		this.progress = { toolCalls: 0 };
		this.updateEditorFocus();
		this.options.host.requestRender();

		void this.options.workflow
			.find(prompt, this.options.cwd, request.signal, (progress) => {
				if (this.request !== request || this.disposed) {
					return;
				}
				this.progress = progress;
				this.options.host.requestRender();
			})
			.then((references) => {
				if (this.request !== request || request.signal.aborted || this.disposed) {
					return;
				}
				this.request = null;
				this.options.host.close();
				this.options.onSubmit(prompt, references);
			})
			.catch((error: unknown) => {
				if (this.request !== request || request.signal.aborted || this.disposed) {
					return;
				}
				this.request = null;
				this.mode = "ready";
				this.errorMessage = error instanceof Error ? error.message : String(error);
				this.updateEditorFocus();
				this.options.host.requestRender();
			});
	}

	private cancelSearch(): void {
		this.request?.abort();
		this.request = null;
		this.mode = "ready";
		this.updateEditorFocus();
		this.options.host.requestRender();
	}

	private updateEditorFocus(): void {
		this.promptEditor.focused = this.hostFocused && this.mode === "ready" && this.focusTarget === "prompt";
	}
}

function isActionNavigationInput(data: string): boolean {
	return (
		matchesKey(data, Key.left) ||
		matchesKey(data, Key.right) ||
		matchesKey(data, Key.up) ||
		matchesKey(data, Key.down)
	);
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
