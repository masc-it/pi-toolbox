import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { ToolboxOverlayController } from "./overlay-controller.ts";

export function registerToolboxShortcuts(pi: ExtensionAPI, controller: ToolboxOverlayController): void {
	pi.registerShortcut(Key.ctrlShift("enter"), {
		description: "Toggle Pi Toolbox",
		handler: async (ctx) => {
			await controller.toggle(ctx);
		},
	});

	pi.registerShortcut(Key.ctrl("enter"), {
		description: "Open Prompt Polish",
		handler: async (ctx) => {
			await controller.open(ctx, "polish");
		},
	});

	pi.registerShortcut(Key.ctrl("."), {
		description: "Open Context Finder",
		handler: async (ctx) => {
			await controller.open(ctx, "context-finder");
		},
	});
}
