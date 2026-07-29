import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { ToolboxConfigStore } from "../config.ts";
import { DEFAULT_PROMPT_POLISH_PROFILE, type ToolboxConfig } from "../domain.ts";
import { WorkflowModelClient } from "../model/client.ts";
import { PromptPolishWorkflow } from "../workflows/polish.ts";
import { LandingScreen, UnavailableWorkflowScreen } from "./landing.ts";
import { PromptPolishScreen } from "./polish.ts";
import type { ToolboxScreenFactories } from "./screen.ts";

interface ToolboxScreenDependencies {
	ctx: ExtensionContext;
	tui: TUI;
	theme: Theme;
	config: ToolboxConfig;
	configStore: ToolboxConfigStore;
}

export function createToolboxScreens(dependencies: ToolboxScreenDependencies): ToolboxScreenFactories {
	const { ctx, tui, theme, config, configStore } = dependencies;
	const workflow = new PromptPolishWorkflow(new WorkflowModelClient(ctx.modelRegistry));
	const models = availableModels(ctx);
	let configuredProfile = config.models.prompt_polish ?? DEFAULT_PROMPT_POLISH_PROFILE;

	return {
		landing: (host) => new LandingScreen(host, theme),
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
				onSaveDefault: async (profile) => {
					await configStore.saveModelProfile("prompt_polish", profile);
					configuredProfile = profile;
				},
			}),
		"feature-spec-list": (host) => new UnavailableWorkflowScreen("Feature Spec", host, theme),
		"implementation-list": (host) => new UnavailableWorkflowScreen("Implementation", host, theme),
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
