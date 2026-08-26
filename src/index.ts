import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ToolboxConfigStore } from "./config.ts";
import { registerMemoryCapture } from "./memory/capture.ts";
import { registerMemoryConsumer } from "./memory/consumer.ts";
import { registerToolboxCommands } from "./pi/commands.ts";
import { ToolboxOverlayController } from "./pi/overlay-controller.ts";
import { registerToolboxShortcuts } from "./pi/shortcuts.ts";

export default function piToolbox(pi: ExtensionAPI): void {
	registerMemoryCapture(pi);
	registerMemoryConsumer(pi);

	const overlayController = new ToolboxOverlayController(new ToolboxConfigStore(), (prompt) => {
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	});
	registerToolboxCommands(pi, overlayController);
	registerToolboxShortcuts(pi, overlayController);
}
