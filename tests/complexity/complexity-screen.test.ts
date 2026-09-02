import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { ComplexityScreen } from "../../src/ui/complexity.ts";
import { ComplexityCancelledError } from "../../src/workflows/complexity-runner.ts";
import type { ToolboxScreenHost } from "../../src/ui/screen.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function createHost() {
	const calls = { closes: 0, renders: 0 };
	const host: ToolboxScreenHost = {
		open: () => {},
		back: () => {},
		close: () => calls.closes++,
		requestRender: () => calls.renders++,
	};
	return { host, calls };
}

async function flushMicrotasks(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

test("the complexity screen renders the supplied running label", async () => {
	for (const runningLabel of [
		"Analysing repository Python files with uv…",
		"Analysing repository JavaScript and TypeScript files…",
	]) {
		const { host } = createHost();
		let requestSignal: AbortSignal | undefined;
		const screen = new ComplexityScreen({
			host,
			theme,
			cwd: "/tmp/project",
			runningLabel,
			analyze: async (_cwd, signal) => {
				requestSignal = signal;
				return new Promise(() => {});
			},
			onComplete: () => {},
		});
		await flushMicrotasks();
		assert.equal(screen.render(80)[0], runningLabel);
		screen.dispose();
		assert.equal(requestSignal?.aborted, true);
	}
});

test("the reused screen preserves completion and cancellation states", async () => {
	const completedHost = createHost();
	let completedReport = "";
	const completed = new ComplexityScreen({
		host: completedHost.host,
		theme,
		cwd: "/tmp/project",
		runningLabel: "Running",
		analyze: async () => ({ report: "report bytes\n" }),
		onComplete: (report) => {
			completedReport = report;
		},
	});
	await flushMicrotasks();
	assert.equal(completedHost.calls.closes, 1);
	assert.equal(completedReport, "report bytes\n");

	const cancelledHost = createHost();
	const cancelled = new ComplexityScreen({
		host: cancelledHost.host,
		theme,
		cwd: "/tmp/project",
		runningLabel: "Running",
		analyze: async (_cwd, signal) => {
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new ComplexityCancelledError()), { once: true });
			});
			return { report: "unreachable" };
		},
		onComplete: () => {},
	});
	await flushMicrotasks();
	cancelled.handleInput("\x1b");
	await flushMicrotasks();
	const output = cancelled.render(80).join("\n");
	assert.match(output, /Analysis failed/);
	assert.match(output, /Repository complexity analysis was cancelled/);
	assert.match(output, /Retry/);
	assert.match(output, /Close/);

	cancelled.handleInput("\r");
	await flushMicrotasks();
	assert.equal(cancelled.render(80)[0], "Running");
	cancelled.handleInput("\x1b");
	await flushMicrotasks();
	assert.match(cancelled.render(80).join("\n"), /Analysis failed/);
	cancelled.handleInput("\x1b");
	assert.equal(cancelledHost.calls.closes, 1);
	cancelled.dispose();
});
