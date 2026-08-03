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
		this.promptEditor.borderColor = (text) =>
			this.options.theme.fg(this.focusTarget === "prompt" ? "accent" : "borderMuted", text);

		const lines = [
			`${this.options.theme.fg("muted", "Model:")} ${this.options.theme.fg("text", CONTEXT_FINDER_MODEL)}  ${this.options.theme.fg("muted", "Thinking:")} ${this.options.theme.fg("text", CONTEXT_FINDER_THINKING_LEVEL)}`,
			"",
			this.options.theme.fg(
				this.focusTarget === "prompt" ? "accent" : "muted",
				this.options.theme.bold(`${this.focusTarget === "prompt" ? "▸ " : "  "}Prompt`),
			),
			...this.promptEditor.render(width),
		];

		if (this.mode === "searching") {
			const activity = this.progress.lastTool
				? ` ${this.progress.toolCalls} tool call${this.progress.toolCalls === 1 ? "" : "s"}; last: ${this.progress.lastTool}`
				: " inspecting the project";
			lines.push("", this.options.theme.fg("accent", `Finding context…${activity}`));
		}
		if (this.errorMessage) {
			lines.push("", this.options.theme.fg("error", this.errorMessage));
		}

		lines.push("", this.renderActions());
		lines.push(
			this.options.theme.fg(
				"dim",
				this.mode === "searching"
					? "Esc cancel search"
					: "Tab switch focus  Ctrl+. find references  Esc back",
			),
		);
		return lines;
	}

	handleInput(data: string): void {
		if (this.mode === "searching") {
			if (matchesKey(data, Key.escape)) {
				this.cancelSearch();
			}
			return;
		}
		if (matchesKey(data, Key.ctrl("."))) {
			this.startSearch();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.focusTarget = this.focusTarget === "prompt" ? "actions" : "prompt";
			this.updateEditorFocus();
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.options.host.back();
			return;
		}

		if (this.focusTarget === "prompt") {
			if (matchesKey(data, Key.enter)) {
				this.promptEditor.handleInput("\n");
			} else {
				this.promptEditor.handleInput(data);
			}
			this.options.host.requestRender();
			return;
		}

		if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
			this.actionIndex = (this.actionIndex + 1) % 2;
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
			this.actionIndex = (this.actionIndex + 1) % 2;
			this.options.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.actionIndex === 0) {
				this.startSearch();
			} else {
				this.options.host.close();
			}
		}
	}

	invalidate(): void {
		this.promptEditor.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.request?.abort();
		this.request = null;
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
