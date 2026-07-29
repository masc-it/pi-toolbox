import type { ToolboxView } from "../domain.ts";

export class OverlayNavigation {
	private readonly views: ToolboxView[];

	constructor(initialView: ToolboxView) {
		this.views = [initialView];
	}

	get current(): ToolboxView {
		return this.views[this.views.length - 1] ?? "landing";
	}

	open(view: ToolboxView): void {
		if (view === this.current) {
			return;
		}
		this.views.push(view);
	}

	back(): boolean {
		if (this.views.length === 1) {
			return false;
		}
		this.views.pop();
		return true;
	}
}
