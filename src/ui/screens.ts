import { copyToClipboard, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { ToolboxConfig } from "../domain.ts";
import { WorkflowModelClient } from "../model/client.ts";
import { analyzeRepository, buildComplexityPrompt } from "../workflows/complexity.ts";
import { appendContextReferences, ContextFinderWorkflow } from "../workflows/context-finder.ts";
import { PromptPolishWorkflow } from "../workflows/polish.ts";
import { ComplexityScreen } from "./complexity.ts";
import { ContextFinderScreen } from "./context-finder.ts";
import { LandingScreen } from "./landing.ts";
import { PromptPolishScreen } from "./polish.ts";
import type { ToolboxScreenFactories } from "./screen.ts";

interface ToolboxScreenDependencies {
	ctx: ExtensionContext;
	tui: TUI;
	theme: Theme;
	config: ToolboxConfig;
	submitPrompt: (prompt: string) => void;
}

export function createToolboxScreens(dependencies: ToolboxScreenDependencies): ToolboxScreenFactories {
	const { ctx, tui, theme, config, submitPrompt } = dependencies;
	const workflow = new PromptPolishWorkflow(new WorkflowModelClient(ctx.modelRegistry));

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
			new ComplexityScreen({
				host,
				theme,
				cwd: ctx.cwd,
				analyze: analyzeRepository,
				onComplete: (report) => {
					const prompt = buildComplexityPrompt(report);
					try {
						submitPrompt(prompt);
					} catch (error) {
						ctx.ui.setEditorText(prompt);
						ctx.ui.notify(
							`Unable to submit the complexity prompt: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
				},
			}),
	};
}
