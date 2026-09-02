import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import test from "node:test";
import type { ToolboxView } from "../../src/domain.ts";
import { registerToolboxCommands } from "../../src/pi/commands.ts";
import type { ToolboxOverlayController } from "../../src/pi/overlay-controller.ts";
import { LandingScreen } from "../../src/ui/landing.ts";
import type { ToolboxScreenHost } from "../../src/ui/screen.ts";
import { createToolboxScreens, submitComplexityPrompt } from "../../src/ui/screens.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function createHost() {
	const calls = { opened: [] as ToolboxView[], closes: 0, renders: 0 };
	const host: ToolboxScreenHost = {
		open: (view) => calls.opened.push(view),
		back: () => {},
		close: () => calls.closes++,
		requestRender: () => calls.renders++,
	};
	return { host, calls };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(message);
}

test("commands retain Python complexity and add direct JS/TS complexity", async () => {
	type RegisteredCommand = {
		description: string;
		handler: (args: string, ctx: ExtensionContext) => Promise<void>;
	};
	const registrations = new Map<string, RegisteredCommand>();
	const pi = {
		registerCommand: (name: string, command: RegisteredCommand) => registrations.set(name, command),
	} as unknown as ExtensionAPI;
	const opened: ToolboxView[] = [];
	const controller = {
		open: async (_ctx: ExtensionContext, view: ToolboxView) => {
			opened.push(view);
		},
	} as unknown as ToolboxOverlayController;

	registerToolboxCommands(pi, controller);
	assert.equal(registrations.get("tb-complexity")?.description, "Open Python Complexity");
	assert.equal(registrations.get("tb-js-complexity")?.description, "Open JS/TS Complexity");
	await registrations.get("tb-complexity")!.handler("", {} as ExtensionContext);
	await registrations.get("tb-js-complexity")!.handler("", {} as ExtensionContext);
	assert.deepEqual(opened, ["complexity", "js-ts-complexity"]);
});

test("the landing screen opens separate Python and JS/TS entries", () => {
	const pythonHost = createHost();
	const pythonLanding = new LandingScreen(pythonHost.host, theme, "/tmp/project");
	const rendered = pythonLanding.render(100).join("\n");
	assert.match(rendered, /Python Complexity/);
	assert.match(rendered, /JS\/TS Complexity/);

	pythonLanding.handleInput("\x1b[B");
	pythonLanding.handleInput("\x1b[B");
	pythonLanding.handleInput("\r");
	assert.deepEqual(pythonHost.calls.opened, ["complexity"]);

	const javascriptHost = createHost();
	const javascriptLanding = new LandingScreen(javascriptHost.host, theme, "/tmp/project");
	javascriptLanding.handleInput("\x1b[B");
	javascriptLanding.handleInput("\x1b[B");
	javascriptLanding.handleInput("\x1b[B");
	javascriptLanding.handleInput("\r");
	assert.deepEqual(javascriptHost.calls.opened, ["js-ts-complexity"]);
});

test("a successful JS/TS screen run preserves the editor and submits one complete prompt", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-toolbox-integration-"));
	try {
		await writeFile(
			join(directory, "source.ts"),
			"export function choose(value: boolean) {\n\tif (value) return 1;\n\treturn 0;\n}\n",
			"utf8",
		);
		let editorText = "existing editor text";
		const submitted: string[] = [];
		const notifications: string[] = [];
		const context = {
			cwd: directory,
			modelRegistry: {},
			ui: {
				getEditorText: () => editorText,
				setEditorText: (text: string) => {
					editorText = text;
				},
				notify: (message: string) => notifications.push(message),
			},
		} as unknown as ExtensionContext;
		const screens = createToolboxScreens({
			ctx: context,
			tui: { requestRender: () => {} } as unknown as TUI,
			theme,
			config: {
				models: {
					prompt_polish: {
						provider: "openai-codex",
						model: "gpt-5.6-luna",
						thinkingLevel: "high",
					},
				},
			},
			submitPrompt: (prompt) => submitted.push(prompt),
		});
		const host = createHost();
		const screen = screens["js-ts-complexity"](host.host);
		assert.equal(editorText, "existing editor text");
		await waitFor(() => submitted.length === 1, "JS/TS complexity prompt was not submitted");

		assert.equal(host.calls.closes, 1);
		assert.equal(submitted.length, 1);
		assert.match(submitted[0]!, /^Propose how to reduce the code complexity.*JavaScript or TypeScript/);
		assert.match(submitted[0]!, /`source\.ts`/);
		assert.equal(editorText, "existing editor text");
		assert.deepEqual(notifications, []);
		screen.dispose?.();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("submission failure restores a prompt only when the editor is empty", async () => {
	let editorText = "";
	let copied = false;
	const notifications: string[] = [];
	await submitComplexityPrompt({
		prompt: "complete prompt",
		promptLabel: "JavaScript and TypeScript complexity prompt",
		submitPrompt: () => {
			throw new Error("submission failed");
		},
		getEditorText: () => editorText,
		setEditorText: (text) => {
			editorText = text;
		},
		copyPrompt: async () => {
			copied = true;
		},
		notify: (message) => notifications.push(message),
	});

	assert.equal(editorText, "complete prompt");
	assert.equal(copied, false);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]!, /submission failed.*restored to the editor/);
});

test("submission failure preserves a non-empty editor and reports clipboard recovery", async () => {
	let editorText = "keep this draft";
	let copiedText = "";
	const notifications: string[] = [];
	await submitComplexityPrompt({
		prompt: "complete prompt",
		promptLabel: "JavaScript and TypeScript complexity prompt",
		submitPrompt: () => {
			throw new Error("submission failed");
		},
		getEditorText: () => editorText,
		setEditorText: (text) => {
			editorText = text;
		},
		copyPrompt: async (text) => {
			copiedText = text;
		},
		notify: (message) => notifications.push(message),
	});

	assert.equal(editorText, "keep this draft");
	assert.equal(copiedText, "complete prompt");
	assert.match(notifications[0]!, /submission failed.*editor was preserved.*copied to the clipboard/);
});

test("clipboard recovery failure is reported without replacing editor content", async () => {
	let editorText = "keep this draft";
	const notifications: string[] = [];
	await submitComplexityPrompt({
		prompt: "complete prompt",
		promptLabel: "Python complexity prompt",
		submitPrompt: () => {
			throw new Error("submission failed");
		},
		getEditorText: () => editorText,
		setEditorText: (text) => {
			editorText = text;
		},
		copyPrompt: async () => {
			throw new Error("clipboard unavailable");
		},
		notify: (message) => notifications.push(message),
	});

	assert.equal(editorText, "keep this draft");
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]!, /submission failed.*editor was preserved.*clipboard unavailable/);
});
