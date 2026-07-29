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
		label: "Feature Spec",
		description: "Clarify a feature and create an approved implementation specification.",
		view: "feature-spec-list",
	},
	{
		label: "Implementation",
		description: "Start or resume implementation from an approved specification.",
		view: "implementation-list",
	},
];

export class LandingScreen implements ToolboxScreen {
	private selectedIndex = 0;
	private projectLabel = "resolving…";

	constructor(
		private readonly host: ToolboxScreenHost,
		private readonly theme: Theme,
		resolveProjectLabel: () => Promise<string>,
	) {
		void resolveProjectLabel()
			.then((label) => {
				this.projectLabel = label;
				this.host.requestRender();
			})
			.catch(() => {
				this.projectLabel = "unavailable";
				this.host.requestRender();
			});
	}

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

export class UnavailableWorkflowScreen implements ToolboxScreen {
	constructor(
		private readonly workflowName: string,
		private readonly host: ToolboxScreenHost,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		return [
			this.theme.fg("accent", this.theme.bold(this.workflowName)),
			"",
			...wrapTextWithAnsi(
				this.theme.fg("muted", "This workflow unlocks after the current development QA checkpoint."),
				width,
			),
			"",
			this.theme.fg("dim", "Esc back"),
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.host.back();
		}
	}

	invalidate(): void {}
}
