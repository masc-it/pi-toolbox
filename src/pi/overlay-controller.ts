import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolboxView } from "../domain.ts";
import { ToolboxOverlay } from "../ui/overlay.ts";
import { createFoundationScreens } from "../ui/screens.ts";

export class ToolboxOverlayController {
	private activeOverlay: ToolboxOverlay | null = null;

	async open(ctx: ExtensionContext, view: ToolboxView): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Pi Toolbox requires interactive mode", "error");
			return;
		}
		if (this.activeOverlay) {
			this.activeOverlay.open(view);
			return;
		}

		try {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const screens = createFoundationScreens(theme);
					const overlay = new ToolboxOverlay(view, tui, theme, screens, () => done());
					this.activeOverlay = overlay;
					return overlay;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "45%",
						minWidth: 50,
						maxHeight: "90%",
						margin: 1,
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
