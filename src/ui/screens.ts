import type { Theme } from "@earendil-works/pi-coding-agent";
import { LandingScreen, UnavailableWorkflowScreen } from "./landing.ts";
import type { ToolboxScreenFactories } from "./screen.ts";

export function createFoundationScreens(theme: Theme): ToolboxScreenFactories {
	return {
		landing: (host) => new LandingScreen(host, theme),
		polish: (host) => new UnavailableWorkflowScreen("Prompt Polish", host, theme),
		"feature-spec-list": (host) => new UnavailableWorkflowScreen("Feature Spec", host, theme),
		"implementation-list": (host) => new UnavailableWorkflowScreen("Implementation", host, theme),
	};
}
