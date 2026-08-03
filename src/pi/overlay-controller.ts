import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolboxView } from "../domain.ts";
import type { ToolboxConfigStore } from "../config.ts";
import { ToolboxOverlay } from "../ui/overlay.ts";
import { createToolboxScreens } from "../ui/screens.ts";

export class ToolboxOverlayController {
	private activeOverlay: ToolboxOverlay | null = null;

	constructor(
		private readonly configStore: ToolboxConfigStore,
		private readonly submitPrompt: (prompt: string) => void,
	) {}

	async open(ctx: ExtensionContext, view: ToolboxView): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Pi Toolbox requires interactive mode", "error");
			return;
		}
		if (this.activeOverlay) {
			this.activeOverlay.open(view);
			return;
		}

		let config;
		try {
			config = await this.configStore.load();
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}

		try {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const screens = createToolboxScreens({
						ctx,
						tui,
						theme,
						config,
						configStore: this.configStore,
						submitPrompt: this.submitPrompt,
					});
					const overlay = new ToolboxOverlay(view, tui, theme, screens, () => done());
					this.activeOverlay = overlay;
					return overlay;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-left",
						width: "100%",
						maxHeight: "100%",
						margin: 0,
					},
				},
			);
		} finally {
			this.activeOverlay = null;
		}
	}

	async toggle(ctx: ExtensionContext): Promise<void> {
		if (this.activeOverlay) {
			this.activeOverlay.close();
			return;
		}
		await this.open(ctx, "landing");
	}
}
