import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ToolboxView } from "../domain.ts";
import type { ToolboxScreen, ToolboxScreenHost } from "./screen.ts";

interface LandingItem {
	label: string;
	description: string;
	view: ToolboxView;
}

const ITEMS: readonly LandingItem[] = [
	{
		label: "Prompt Polish",
		description: "Rewrite the current editor prompt with precise language and structure.",
		view: "polish",
	},
	{
		label: "Context Finder",
		description: "Find relevant project files and symbols, then append them to the current prompt.",
		view: "context-finder",
	},
];

export class LandingScreen implements ToolboxScreen {
	private selectedIndex = 0;
	constructor(
		private readonly host: ToolboxScreenHost,
		private readonly theme: Theme,
		private readonly projectLabel: string,
	) {}

	render(width: number): string[] {
		const lines = [this.theme.fg("muted", `Project: ${this.projectLabel}`)];
		lines.push("");

		for (const [index, item] of ITEMS.entries()) {
			const selected = index === this.selectedIndex;
			const marker = selected ? this.theme.fg("accent", ">") : " ";
			const label = selected ? this.theme.fg("accent", this.theme.bold(item.label)) : this.theme.fg("text", item.label);
			lines.push(`${marker} ${label}`);
			if (selected) {
				const description = wrapTextWithAnsi(this.theme.fg("muted", item.description), Math.max(1, width - 4));
				lines.push(...description.map((line) => `    ${line}`));
			}
		}

		lines.push("");
		lines.push(this.theme.fg("dim", "↑↓ navigate  Enter open  Esc close"));
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = (this.selectedIndex - 1 + ITEMS.length) % ITEMS.length;
			this.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = (this.selectedIndex + 1) % ITEMS.length;
			this.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const item = ITEMS[this.selectedIndex];
			if (item) {
				this.host.open(item.view);
			}
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.host.close();
		}
	}

	invalidate(): void {}
}
