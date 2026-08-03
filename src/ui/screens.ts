import type { Api, Model } from "@earendil-works/pi-ai";
import { copyToClipboard, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { ToolboxConfig } from "../domain.ts";
import type { ToolboxConfigStore } from "../config.ts";
import { WorkflowModelClient } from "../model/client.ts";
import { appendContextReferences, ContextFinderWorkflow } from "../workflows/context-finder.ts";
import { PromptPolishWorkflow } from "../workflows/polish.ts";
import { ContextFinderScreen } from "./context-finder.ts";
import { LandingScreen } from "./landing.ts";
import { PromptPolishScreen } from "./polish.ts";
import type { ToolboxScreenFactories } from "./screen.ts";

interface ToolboxScreenDependencies {
	ctx: ExtensionContext;
	tui: TUI;
	theme: Theme;
	config: ToolboxConfig;
	configStore: ToolboxConfigStore;
	submitPrompt: (prompt: string) => void;
}

export function createToolboxScreens(dependencies: ToolboxScreenDependencies): ToolboxScreenFactories {
	const { ctx, tui, theme, config, configStore, submitPrompt } = dependencies;
	const workflow = new PromptPolishWorkflow(new WorkflowModelClient(ctx.modelRegistry));
	const models = availableModels(ctx);
	let configuredProfile = config.models.prompt_polish;

	return {
		landing: (host) => new LandingScreen(host, theme, ctx.cwd),
		polish: (host) =>
			new PromptPolishScreen({
				host,
				tui,
				theme,
				source: ctx.ui.getEditorText(),
				profile: configuredProfile,
				models,
				workflow,
				onAccept: (text) => ctx.ui.setEditorText(text),
				onCopy: copyToClipboard,
				onSaveDefault: async (profile) => {
					await configStore.saveModelProfile("prompt_polish", profile);
					configuredProfile = profile;
				},
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
	};
}

function availableModels(ctx: ExtensionContext): Model<Api>[] {
	const models = [...ctx.modelRegistry.getAvailable()];
	if (ctx.model && !models.some((model) => sameModel(model, ctx.model!))) {
		models.push(ctx.model);
	}
	return models;
}

function sameModel(left: Model<Api>, right: Model<Api>): boolean {
	return left.provider === right.provider && left.id === right.id;
}
