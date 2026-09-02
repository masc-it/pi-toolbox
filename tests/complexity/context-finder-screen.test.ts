import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import test from "node:test";
import { ContextFinderScreen } from "../../src/ui/context-finder.ts";
import type { ToolboxScreenHost } from "../../src/ui/screen.ts";
import type { ContextFinderProgress, ContextFinderWorkflow } from "../../src/workflows/context-finder.ts";

const CTRL_DOT = "\x1b[46;5u";
const SHIFT_TAB = "\x1b[Z";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

interface PendingSearch {
	prompt: string;
	cwd: string;
	signal: AbortSignal;
	onProgress: ((progress: ContextFinderProgress) => void) | undefined;
	resolve: (references: string) => void;
	reject: (error: unknown) => void;
}

function createWorkflow(): { workflow: ContextFinderWorkflow; searches: PendingSearch[] } {
	const searches: PendingSearch[] = [];
	const workflow = {
		find(
			prompt: string,
			cwd: string,
			signal: AbortSignal,
			onProgress?: (progress: ContextFinderProgress) => void,
		): Promise<string> {
			return new Promise((resolve, reject) => {
				searches.push({ prompt, cwd, signal, onProgress, resolve, reject });
			});
		},
	} as ContextFinderWorkflow;
	return { workflow, searches };
}

function createScreen(prompt = "") {
	const hostCalls = { backs: 0, closes: 0, renders: 0 };
	const events: string[] = [];
	const host: ToolboxScreenHost = {
		open: () => {},
		back: () => {
			hostCalls.backs += 1;
		},
		close: () => {
			hostCalls.closes += 1;
			events.push("close");
		},
		requestRender: () => {
			hostCalls.renders += 1;
		},
	};
	const { workflow, searches } = createWorkflow();
	const submissions: Array<{ prompt: string; references: string }> = [];
	const screen = new ContextFinderScreen({
		host,
		tui: {
			requestRender: host.requestRender,
			terminal: { rows: 24, columns: 100 },
		} as unknown as TUI,
		theme,
		prompt,
		cwd: "/project",
		workflow,
		onSubmit: (submittedPrompt, references) => {
			events.push("submit");
			submissions.push({ prompt: submittedPrompt, references });
		},
	});
	return { screen, hostCalls, events, searches, submissions };
}

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("context finder routes prompt input and ignores ordinary input while searching", async () => {
	const fixture = createScreen();
	fixture.screen.setFocused(true);
	fixture.screen.handleInput("find relevant files");
	fixture.screen.handleInput("\r");
	fixture.screen.handleInput("with symbols");
	fixture.screen.handleInput(CTRL_DOT);

	assert.equal(fixture.searches.length, 1);
	assert.equal(fixture.searches[0]!.prompt, "find relevant files\nwith symbols");
	assert.equal(fixture.searches[0]!.cwd, "/project");
	assert.match(fixture.screen.render(100).join("\n"), /Finding context… inspecting the project/);

	fixture.screen.handleInput("ignored input");
	fixture.screen.handleInput("\t");
	fixture.screen.handleInput("\x1b");
	assert.equal(fixture.searches[0]!.signal.aborted, true);
	assert.match(fixture.screen.render(100).at(-1)!, /Tab switch focus/);

	const rendersAfterCancellation = fixture.hostCalls.renders;
	fixture.searches[0]!.onProgress?.({ toolCalls: 9, lastTool: "late" });
	fixture.searches[0]!.reject(new Error("late failure"));
	await flushPromises();
	assert.equal(fixture.hostCalls.renders, rendersAfterCancellation);
	assert.equal(fixture.hostCalls.closes, 0);
	assert.equal(fixture.submissions.length, 0);
	assert.doesNotMatch(fixture.screen.render(100).join("\n"), /late failure/);

	fixture.screen.handleInput(CTRL_DOT);
	assert.equal(fixture.searches[1]!.prompt, "find relevant files\nwith symbols");
	fixture.screen.dispose();
	assert.equal(fixture.searches[1]!.signal.aborted, true);
});

test("context finder action focus preserves navigation and activation behavior", () => {
	const fixture = createScreen();
	fixture.screen.handleInput(SHIFT_TAB);
	assert.match(fixture.screen.render(100).join("\n"), /\[ Find Context \]/);

	fixture.screen.handleInput("\x1b[C");
	assert.match(fixture.screen.render(100).join("\n"), /\[ Cancel \]/);
	fixture.screen.handleInput("\x1b[D");
	assert.match(fixture.screen.render(100).join("\n"), /\[ Find Context \]/);
	fixture.screen.handleInput("\x1b[A");
	assert.match(fixture.screen.render(100).join("\n"), /\[ Cancel \]/);
	fixture.screen.handleInput("\x1b[B");
	assert.match(fixture.screen.render(100).join("\n"), /\[ Find Context \]/);

	fixture.screen.handleInput("\r");
	assert.equal(fixture.searches.length, 0);
	assert.match(fixture.screen.render(100).join("\n"), /Enter a prompt before finding context/);
	assert.match(fixture.screen.render(100).join("\n"), /▸ Prompt/);

	fixture.screen.handleInput("\x1b");
	assert.equal(fixture.hostCalls.backs, 1);

	const cancelFixture = createScreen();
	cancelFixture.screen.handleInput("\t");
	cancelFixture.screen.handleInput("\x1b[C");
	cancelFixture.screen.handleInput("\r");
	assert.equal(cancelFixture.hostCalls.closes, 1);
});

test("context finder renders progress and closes before submitting a successful result", async () => {
	const fixture = createScreen("find the parser");
	await Promise.resolve();
	assert.equal(fixture.searches.length, 1);

	fixture.searches[0]!.onProgress?.({ toolCalls: 1, lastTool: "read" });
	assert.match(fixture.screen.render(100).join("\n"), /Finding context… 1 tool call; last: read/);
	fixture.searches[0]!.onProgress?.({ toolCalls: 2, lastTool: "grep" });
	const rendered = fixture.screen.render(100);
	assert.match(rendered.join("\n"), /Finding context… 2 tool calls; last: grep/);
	assert.deepEqual(rendered.slice(-3), ["", "  Finding…     Cancel  ", "Esc cancel search"]);

	fixture.searches[0]!.resolve("- `src/parser.ts` — parser");
	await flushPromises();
	assert.deepEqual(fixture.events, ["close", "submit"]);
	assert.deepEqual(fixture.submissions, [
		{ prompt: "find the parser", references: "- `src/parser.ts` — parser" },
	]);
});

test("context finder returns to the ready state after a current request fails", async () => {
	const fixture = createScreen("find references");
	await Promise.resolve();
	fixture.searches[0]!.reject(new Error("search failed"));
	await flushPromises();

	const rendered = fixture.screen.render(100).join("\n");
	assert.match(rendered, /search failed/);
	assert.match(rendered, /Tab switch focus  Ctrl\+\. find references  Esc back/);
	assert.equal(fixture.hostCalls.closes, 0);
	assert.equal(fixture.submissions.length, 0);
});
