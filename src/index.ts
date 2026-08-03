import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ToolboxConfigStore } from "./config.ts";
import { registerToolboxCommands } from "./pi/commands.ts";
import { ToolboxOverlayController } from "./pi/overlay-controller.ts";
import { registerToolboxShortcuts } from "./pi/shortcuts.ts";

export default function piToolbox(pi: ExtensionAPI): void {
	const overlayController = new ToolboxOverlayController(new ToolboxConfigStore(), (prompt) => {
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	});
	registerToolboxCommands(pi, overlayController);
	registerToolboxShortcuts(pi, overlayController);
}
