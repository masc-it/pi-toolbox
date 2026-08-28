import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ComplexityCancelledError, type ComplexityResult } from "../workflows/complexity.ts";
import type { ToolboxScreen, ToolboxScreenHost } from "./screen.ts";

type ComplexityMode = "running" | "failed" | "completed";

interface ComplexityScreenOptions {
	host: ToolboxScreenHost;
	theme: Theme;
	cwd: string;
	analyze: (cwd: string, signal: AbortSignal) => Promise<ComplexityResult>;
	onComplete: (report: string) => void;
}

export class ComplexityScreen implements ToolboxScreen {
	private mode: ComplexityMode = "running";
	private errorMessage = "";
	private actionIndex = 0;
	private request: AbortController | null = null;
	private disposed = false;

	constructor(private readonly options: ComplexityScreenOptions) {
		queueMicrotask(() => {
			if (!this.disposed) this.startAnalysis();
		});
	}

	render(width: number): string[] {
		if (this.mode === "running") {
			return [
				this.options.theme.fg("accent", "Analysing repository Python files with uv…"),
				"",
				this.options.theme.fg("accent", "[ Cancel ]"),
				"",
				this.options.theme.fg("dim", "Enter cancel  Esc cancel"),
			];
		}

		if (this.mode === "failed") {
			const errorLines = wrapTextWithAnsi(this.options.theme.fg("error", this.errorMessage), Math.max(1, width));
			return [
				this.options.theme.fg("error", this.options.theme.bold("Analysis failed")),
				"",
				...errorLines,
				"",
				this.renderFailedActions(),
				"",
				this.options.theme.fg("dim", "←→ select  Enter confirm  Esc close"),
			];
		}

		return [this.options.theme.fg("success", "Analysis completed")];
	}

	handleInput(data: string): void {
		if (this.mode === "running") {
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
				this.cancelAnalysis();
			}
			return;
		}
		if (this.mode !== "failed") return;

		if (matchesKey(data, Key.escape)) {
			this.options.host.close();
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
			if (this.actionIndex === 0) this.startAnalysis();
			else this.options.host.close();
		}
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
		this.request?.abort();
		this.request = null;
	}

	private renderFailedActions(): string {
		return ["Retry", "Close"]
			.map((label, index) =>
				index === this.actionIndex
					? this.options.theme.fg("accent", `[ ${label} ]`)
					: this.options.theme.fg("muted", `  ${label}  `),
			)
			.join(" ");
	}

	private startAnalysis(): void {
		this.request?.abort();
		const request = new AbortController();
		this.request = request;
		this.mode = "running";
		this.errorMessage = "";
		this.actionIndex = 0;
		this.options.host.requestRender();

		void this.options
			.analyze(this.options.cwd, request.signal)
			.then(({ report }) => {
				if (this.request !== request || request.signal.aborted || this.disposed) return;
				this.request = null;
				this.mode = "completed";
				this.options.host.close();
				this.options.onComplete(report);
			})
			.catch((error: unknown) => {
				if (this.request !== request || this.disposed) return;
				this.request = null;
				this.mode = "failed";
				this.errorMessage =
					error instanceof ComplexityCancelledError
						? "Repository complexity analysis was cancelled"
						: error instanceof Error
							? error.message
							: String(error);
				this.options.host.requestRender();
			});
	}

	private cancelAnalysis(): void {
		this.request?.abort();
	}
}
