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
	{ name: "tb-context", description: "Open Context Finder", view: "context-finder" },
	{ name: "tb-complexity", description: "Open Python Complexity", view: "complexity" },
	{ name: "tb-js-complexity", description: "Open JS/TS Complexity", view: "js-ts-complexity" },
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
