import type { ToolboxView } from "../domain.ts";

export interface ToolboxScreen {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose?(): void;
}

export interface ToolboxScreenHost {
	open(view: ToolboxView): void;
	back(): void;
	close(): void;
	requestRender(): void;
}

export type ToolboxScreenFactory = (host: ToolboxScreenHost) => ToolboxScreen;
export type ToolboxScreenFactories = Record<ToolboxView, ToolboxScreenFactory>;
