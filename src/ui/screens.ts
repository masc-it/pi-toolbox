import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { DEFAULT_PROMPT_POLISH_PROFILE, type ToolboxConfig, type WorkflowModelProfile } from "../domain.ts";
import { WorkflowModelClient } from "../model/client.ts";
import type { ToolboxRuntime } from "../runtime.ts";
import { PromptPolishWorkflow } from "../workflows/polish.ts";
import { FeatureSpecScreen } from "./feature-spec.ts";
import { ImplementationScreen } from "./implementation.ts";
import { LandingScreen } from "./landing.ts";
import { PromptPolishScreen } from "./polish.ts";
import type { ToolboxScreenFactories } from "./screen.ts";

interface ToolboxScreenDependencies {
	ctx: ExtensionContext;
	tui: TUI;
	theme: Theme;
	config: ToolboxConfig;
	runtime: ToolboxRuntime;
}

export function createToolboxScreens(dependencies: ToolboxScreenDependencies): ToolboxScreenFactories {
	const { ctx, tui, theme, config, runtime } = dependencies;
	const workflow = new PromptPolishWorkflow(new WorkflowModelClient(ctx.modelRegistry));
	const models = availableModels(ctx);
	let configuredProfile = config.models.prompt_polish ?? DEFAULT_PROMPT_POLISH_PROFILE;

	return {
		landing: (host) =>
			new LandingScreen(host, theme, async () => (await runtime.resolveProject(ctx.cwd)).repositoryLabel),
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
					await runtime.config.saveModelProfile("prompt_polish", profile);
					configuredProfile = profile;
				},
			}),
		"feature-spec-list": (host) =>
			new FeatureSpecScreen({
				host,
				tui,
				theme,
				models,
				defaultProfile: featureSpecProfile(config, ctx),
				configStore: runtime.config,
				repository: runtime.featureSpecRepository(),
				workflow: runtime.createFeatureSpecWorkflow(ctx.modelRegistry),
				resolveProject: () => runtime.resolveProject(ctx.cwd),
			}),
		"implementation-list": (host) =>
			new ImplementationScreen({
				host,
				theme,
				models,
				defaultProfile: implementationProfile(config, ctx),
				configStore: runtime.config,
				repository: runtime.implementationRepository(),
				resolveProject: () => runtime.resolveProject(ctx.cwd),
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

function featureSpecProfile(config: ToolboxConfig, ctx: ExtensionContext): WorkflowModelProfile {
	const configured = config.models.feature_spec;
	if (configured) {
		return configured;
	}
	if (!ctx.model) {
		return DEFAULT_PROMPT_POLISH_PROFILE;
	}
	return { provider: ctx.model.provider, model: ctx.model.id, thinkingLevel: "high" };
}

function implementationProfile(config: ToolboxConfig, ctx: ExtensionContext): WorkflowModelProfile {
	const configured = config.models.implementation;
	if (configured) {
		return configured;
	}
	if (!ctx.model) {
		return DEFAULT_PROMPT_POLISH_PROFILE;
	}
	return { provider: ctx.model.provider, model: ctx.model.id, thinkingLevel: "high" };
}

function sameModel(left: Model<Api>, right: Model<Api>): boolean {
	return left.provider === right.provider && left.id === right.id;
}
