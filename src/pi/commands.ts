import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolboxView } from "../domain.ts";
import type { ToolboxOverlayController } from "./overlay-controller.ts";

interface ToolboxCommand {
	name: string;
	description: string;
	view: ToolboxView;
}

const COMMANDS: readonly ToolboxCommand[] = [
	{ name: "toolbox", description: "Open Pi Toolbox", view: "landing" },
	{ name: "tb-polish", description: "Open Prompt Polish", view: "polish" },
	{ name: "tb-spec", description: "Open Feature Spec", view: "feature-spec-list" },
	{ name: "tb-implement", description: "Open Implementation", view: "implementation-list" },
];

export function registerToolboxCommands(pi: ExtensionAPI, controller: ToolboxOverlayController): void {
	for (const command of COMMANDS) {
		pi.registerCommand(command.name, {
			description: command.description,
			handler: async (_args, ctx) => {
				await controller.open(ctx, command.view);
			},
		});
	}
}
