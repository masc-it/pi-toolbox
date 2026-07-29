import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolboxView } from "../domain.ts";
import { OverlayNavigation } from "./navigation.ts";
import type { ToolboxScreen, ToolboxScreenFactories, ToolboxScreenHost } from "./screen.ts";

const MINIMUM_RENDER_WIDTH = 20;

export class ToolboxOverlay implements Component, ToolboxScreenHost {
	private readonly navigation: OverlayNavigation;
	private screen: ToolboxScreen;
	private closed = false;

	constructor(
		initialView: ToolboxView,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly factories: ToolboxScreenFactories,
		private readonly finish: () => void,
	) {
		this.navigation = new OverlayNavigation(initialView);
		this.screen = this.createCurrentScreen();
	}

	open(view: ToolboxView): void {
		this.navigation.open(view);
		this.replaceScreen();
	}

	back(): void {
		if (!this.navigation.back()) {
			this.close();
			return;
		}
		this.replaceScreen();
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.screen.dispose?.();
		this.finish();
	}

	requestRender(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const renderWidth = Math.max(MINIMUM_RENDER_WIDTH, width);
		const contentWidth = Math.max(1, renderWidth - 4);
		const content = this.screen.render(contentWidth);
		const top = this.renderTopBorder(renderWidth);
		const bottom = this.theme.fg("border", `╰${"─".repeat(renderWidth - 2)}╯`);
		const body = content.map((line) => this.renderContentLine(line, contentWidth));
		return [top, ...body, bottom];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrlShift("enter"))) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.ctrl("enter")) && this.navigation.current !== "polish") {
			this.open("polish");
			return;
		}
		this.screen.handleInput(data);
	}

	invalidate(): void {
		this.screen.invalidate();
	}

	dispose(): void {
		this.screen.dispose?.();
	}

	private replaceScreen(): void {
		this.screen.dispose?.();
		this.screen = this.createCurrentScreen();
		this.requestRender();
	}

	private createCurrentScreen(): ToolboxScreen {
		return this.factories[this.navigation.current](this);
	}

	private renderTopBorder(width: number): string {
		const title = " Pi Toolbox ";
		const remaining = Math.max(0, width - visibleWidth(title) - 2);
		return this.theme.fg("borderAccent", `╭─${this.theme.bold(title)}${"─".repeat(Math.max(0, remaining - 1))}╮`);
	}

	private renderContentLine(line: string, contentWidth: number): string {
		const content = truncateToWidth(line, contentWidth, "");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
		const border = this.theme.fg("border", "│");
		return `${border} ${content}${padding} ${border}`;
	}
}
