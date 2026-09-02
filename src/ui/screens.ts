import { copyToClipboard, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { ToolboxConfig } from "../domain.ts";
import { WorkflowModelClient } from "../model/client.ts";
import type { ComplexityResult } from "../workflows/complexity-runner.ts";
import { analyzeRepository, buildComplexityPrompt } from "../workflows/complexity.ts";
import { appendContextReferences, ContextFinderWorkflow } from "../workflows/context-finder.ts";
import {
	analyzeJavaScriptTypeScriptRepository,
	buildJavaScriptTypeScriptComplexityPrompt,
} from "../workflows/javascript-typescript-complexity.ts";
import { PromptPolishWorkflow } from "../workflows/polish.ts";
import { ComplexityScreen } from "./complexity.ts";
import { ContextFinderScreen } from "./context-finder.ts";
import { LandingScreen } from "./landing.ts";
import { PromptPolishScreen } from "./polish.ts";
import type { ToolboxScreenFactories, ToolboxScreenHost } from "./screen.ts";

interface ToolboxScreenDependencies {
	ctx: ExtensionContext;
	tui: TUI;
	theme: Theme;
	config: ToolboxConfig;
	submitPrompt: (prompt: string) => void;
}

interface ComplexityScreenConfiguration {
	runningLabel: string;
	promptLabel: string;
	analyze: (cwd: string, signal: AbortSignal) => Promise<ComplexityResult>;
	buildPrompt: (report: string) => string;
}

interface ComplexityPromptSubmission {
	prompt: string;
	promptLabel: string;
	submitPrompt: (prompt: string) => void;
	getEditorText: () => string;
	setEditorText: (text: string) => void;
	copyPrompt: (text: string) => Promise<void>;
	notify: (message: string, level: "error") => void;
}

export function createToolboxScreens(dependencies: ToolboxScreenDependencies): ToolboxScreenFactories {
	const { ctx, tui, theme, config, submitPrompt } = dependencies;
	const workflow = new PromptPolishWorkflow(new WorkflowModelClient(ctx.modelRegistry));
	const complexityScreen = (host: ToolboxScreenHost, configuration: ComplexityScreenConfiguration) =>
		new ComplexityScreen({
			host,
			theme,
			cwd: ctx.cwd,
			runningLabel: configuration.runningLabel,
			analyze: configuration.analyze,
			onComplete: (report) => {
				void submitComplexityPrompt({
					prompt: configuration.buildPrompt(report),
					promptLabel: configuration.promptLabel,
					submitPrompt,
					getEditorText: () => ctx.ui.getEditorText(),
					setEditorText: (text) => ctx.ui.setEditorText(text),
					copyPrompt: copyToClipboard,
					notify: (message, level) => ctx.ui.notify(message, level),
				});
			},
		});

	return {
		landing: (host) => new LandingScreen(host, theme, ctx.cwd),
		polish: (host) =>
			new PromptPolishScreen({
				host,
				tui,
				theme,
				source: ctx.ui.getEditorText(),
				profile: config.models.prompt_polish,
				workflow,
				onAccept: (text) => {
					ctx.ui.setEditorText(text);
					try {
						submitPrompt(text);
						ctx.ui.setEditorText("");
					} catch (error) {
						ctx.ui.notify(
							`Unable to submit the polished prompt: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
				},
				onCopy: copyToClipboard,
			}),
		"context-finder": (host) =>
			new ContextFinderScreen({
				host,
				tui,
				theme,
				prompt: ctx.ui.getEditorText(),
				cwd: ctx.cwd,
				workflow: new ContextFinderWorkflow(),
				onSubmit: (prompt, references) => {
					const finalPrompt = appendContextReferences(prompt, references);
					ctx.ui.setEditorText("");
					try {
						submitPrompt(finalPrompt);
					} catch (error) {
						ctx.ui.setEditorText(finalPrompt);
						ctx.ui.notify(
							`Unable to submit the context-enriched prompt: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
				},
			}),
		complexity: (host) =>
			complexityScreen(host, {
				runningLabel: "Analysing repository Python files with uv…",
				promptLabel: "Python complexity prompt",
				analyze: analyzeRepository,
				buildPrompt: buildComplexityPrompt,
			}),
		"js-ts-complexity": (host) =>
			complexityScreen(host, {
				runningLabel: "Analysing repository JavaScript and TypeScript files…",
				promptLabel: "JavaScript and TypeScript complexity prompt",
				analyze: analyzeJavaScriptTypeScriptRepository,
				buildPrompt: buildJavaScriptTypeScriptComplexityPrompt,
			}),
	};
}

export async function submitComplexityPrompt(options: ComplexityPromptSubmission): Promise<void> {
	try {
		options.submitPrompt(options.prompt);
		return;
	} catch (error) {
		const failure = `Unable to submit the ${options.promptLabel}: ${error instanceof Error ? error.message : String(error)}`;
		if (options.getEditorText().length === 0) {
			options.setEditorText(options.prompt);
			options.notify(`${failure}. The complete prompt was restored to the editor.`, "error");
			return;
		}

		try {
			await options.copyPrompt(options.prompt);
			options.notify(`${failure}. The editor was preserved and the complete prompt was copied to the clipboard.`, "error");
		} catch (copyError) {
			options.notify(
				`${failure}. The editor was preserved, but copying the complete prompt failed: ${copyError instanceof Error ? copyError.message : String(copyError)}`,
				"error",
			);
		}
	}
}
