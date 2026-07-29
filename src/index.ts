import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolboxCommands } from "./pi/commands.ts";
import { ToolboxOverlayController } from "./pi/overlay-controller.ts";
import { registerToolboxShortcuts } from "./pi/shortcuts.ts";
import { ToolboxRuntime } from "./runtime.ts";

export default function piToolbox(pi: ExtensionAPI): void {
	const runtime = new ToolboxRuntime();
	const overlayController = new ToolboxOverlayController(runtime);
	registerToolboxCommands(pi, overlayController);
	registerToolboxShortcuts(pi, overlayController);

	pi.on("session_shutdown", async () => {
		runtime.close();
	});
}
