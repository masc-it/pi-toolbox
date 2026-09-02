import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	DEFAULT_LIMITS,
	EXIT_ANALYSIS,
	EXIT_BOUNDARY,
	EXIT_NO_FILES,
	EXIT_RESOURCE,
	inspectRepository,
	rankFiles,
	renderReport,
	run,
} from "../../scripts/javascript_typescript_complexity.mjs";

const execFileAsync = promisify(execFile);
const SOURCE_SUFFIXES = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"];

async function createTemporaryDirectory(t) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-toolbox-js-complexity-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

async function writeFixture(root, relativePath, content = "export const value = 1;\n") {
	const target = path.join(root, ...relativePath.split("/"));
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, content);
	return target;
}

function validSource(suffix) {
	switch (suffix) {
		case ".jsx":
			return "export const value = <div />;\n";
		case ".tsx":
			return "export const value: JSX.Element = <div />;\n";
		case ".ts":
		case ".mts":
			return "export const value: number = 1;\n";
		case ".cts":
			return "const value: number = 1; export = value;\n";
		case ".cjs":
			return "module.exports = 1;\n";
		default:
			return "export const value = 1;\n";
	}
}

function relativePaths(result) {
	return result.files.map((file) => file.relativePath);
}

function fileMetrics(result, relativePath) {
	const metrics = result.metrics.find((item) => item.path === relativePath);
	assert.ok(metrics, `Missing metrics for ${relativePath}`);
	return metrics;
}

function scopeMetrics(metrics, qualifiedName) {
	const scope = metrics.scopes.find((item) => item.qualifiedName === qualifiedName);
	assert.ok(scope, `Missing scope ${qualifiedName}`);
	return scope;
}

async function captureRun(root, options = {}) {
	let stdout = "";
	let stderr = "";
	const code = await run(["--repo-root", root], {
		...options,
		stdout: {
			write(chunk) {
				stdout += String(chunk);
				return true;
			},
		},
		stderr: {
			write(chunk) {
				stderr += String(chunk);
				return true;
			},
		},
	});
	return { code, stdout, stderr };
}

async function initializeGit(root) {
	await execFileAsync("git", ["init", "--quiet", root]);
}

test("Git discovery includes production sources and applies every built-in exclusion", async (t) => {
	const root = await createTemporaryDirectory(t);
	await initializeGit(root);
	await writeFixture(root, ".gitignore", "ignored.ts\n");

	const expected = [];
	for (const [index, suffix] of SOURCE_SUFFIXES.entries()) {
		const relativePath = `src/source-${index}${suffix}`;
		await writeFixture(root, relativePath, validSource(suffix));
		expected.push(relativePath);
		await writeFixture(root, `src/excluded-${index}.test${suffix}`, "not valid source");
		await writeFixture(root, `src/excluded-${index}.spec${suffix}`, "not valid source");
		await writeFixture(root, `src/excluded-${index}.min${suffix}`, "not valid source");
		await writeFixture(root, `src/excluded-${index}.bundle${suffix}`, "not valid source");
	}

	await writeFixture(root, "src/tracked.ts");
	expected.push("src/tracked.ts");
	await writeFixture(root, "src/untracked.ts");
	expected.push("src/untracked.ts");
	await writeFixture(root, "ignored.ts", "not valid source");
	await writeFixture(root, "types.d.ts", "not valid source");
	await writeFixture(root, "types.d.mts", "not valid source");
	await writeFixture(root, "types.d.cts", "not valid source");
	await writeFixture(root, "tests/example.ts", "not valid source");
	await writeFixture(root, "test/example.ts", "not valid source");
	await writeFixture(root, "__tests__/example.ts", "not valid source");

	const generatedDirectories = [
		".cache",
		".next",
		".nuxt",
		".svelte-kit",
		".turbo",
		".vite",
		".venv",
		".yarn",
		"build",
		"coverage",
		"dist",
		"node_modules",
		"out",
		"site-packages",
		"venv",
	];
	for (const directory of generatedDirectories) {
		await writeFixture(root, `${directory}/excluded.ts`, "not valid source");
	}

	await execFileAsync("git", ["-C", root, "add", "src/tracked.ts"]);
	await execFileAsync("git", ["-C", root, "add", "--force", "dist/excluded.ts"]);

	const result = await inspectRepository(root);
	assert.deepEqual(relativePaths(result), expected.sort());
});

test("fallback discovery uses the same exclusions", async (t) => {
	const root = await createTemporaryDirectory(t);
	await writeFixture(root, "src/keep.ts");
	await writeFixture(root, "dist/tracked.ts", "not valid source");
	await writeFixture(root, "tests/example.ts", "not valid source");
	await writeFixture(root, "src/example.min.tsx", "not valid source");
	await writeFixture(root, "src/example.bundle.jsx", "not valid source");

	const result = await inspectRepository(root);
	assert.deepEqual(relativePaths(result), ["src/keep.ts"]);
});

test("discovery canonicalizes, deduplicates, and sorts source paths", async (t) => {
	const root = await createTemporaryDirectory(t);
	await writeFixture(root, "z.ts");
	await writeFixture(root, "a.ts");
	if (process.platform !== "win32") {
		await symlink(path.join(root, "z.ts"), path.join(root, "alias.ts"));
	}

	const result = await inspectRepository(root);
	assert.deepEqual(relativePaths(result), ["a.ts", "z.ts"]);
});

test("repository configuration excludes exact files and directory descendants", async (t) => {
	const root = await createTemporaryDirectory(t);
	await writeFixture(root, "keep.ts");
	await writeFixture(root, "exact.ts");
	await writeFixture(root, "generated/client.ts");
	await writeFixture(root, "public/vendor/library.js");
	await writeFixture(
		root,
		".pi-toolbox.json",
		JSON.stringify({
			models: { unrelated: true },
			complexity: {
				javascriptTypeScript: {
					excludePaths: ["exact.ts", "generated", "public/vendor", "generated"],
				},
			},
		}),
	);

	const result = await inspectRepository(root);
	assert.deepEqual(relativePaths(result), ["keep.ts"]);
});

test("repository configuration rejects malformed content and invalid exclusion paths", async (t) => {
	const root = await createTemporaryDirectory(t);
	await writeFixture(root, "keep.ts");
	const invalidContents = [
		Buffer.from("{"),
		Buffer.from([0xff]),
		JSON.stringify({ complexity: { javascriptTypeScript: { excludePaths: "generated" } } }),
		JSON.stringify({ complexity: { javascriptTypeScript: { excludePaths: [42] } } }),
		JSON.stringify({ complexity: { javascriptTypeScript: { excludePaths: [""] } } }),
		JSON.stringify({ complexity: { javascriptTypeScript: { excludePaths: ["."] } } }),
		JSON.stringify({ complexity: { javascriptTypeScript: { excludePaths: ["../outside"] } } }),
		JSON.stringify({ complexity: { javascriptTypeScript: { excludePaths: ["/outside"] } } }),
		JSON.stringify({ complexity: { javascriptTypeScript: { excludePaths: ["bad\0path"] } } }),
	];

	for (const content of invalidContents) {
		await writeFixture(root, ".pi-toolbox.json", content);
		const result = await captureRun(root);
		assert.equal(result.code, EXIT_BOUNDARY, result.stderr);
	}

	await writeFixture(root, ".pi-toolbox.json", Buffer.alloc(64 * 1024 + 1, 0x20));
	const oversized = await captureRun(root);
	assert.equal(oversized.code, EXIT_BOUNDARY);
	assert.match(oversized.stderr, /64 KiB size limit/);
});

test("repository configuration and source symlinks cannot escape the root", async (t) => {
	if (process.platform === "win32") return t.skip("symlink setup requires platform-specific privileges");
	const container = await createTemporaryDirectory(t);
	const root = path.join(container, "repository");
	await mkdir(root);
	const outsideSource = await writeFixture(container, "outside.ts");
	await symlink(outsideSource, path.join(root, "escape.ts"));

	const escapedSource = await captureRun(root);
	assert.equal(escapedSource.code, EXIT_BOUNDARY);
	assert.match(escapedSource.stderr, /resolves outside the repository root/);

	await rm(path.join(root, "escape.ts"));
	await writeFixture(root, "keep.ts");
	const outsideConfig = await writeFixture(container, "outside.json", "{}");
	await symlink(outsideConfig, path.join(root, ".pi-toolbox.json"));

	const escapedConfig = await captureRun(root);
	assert.equal(escapedConfig.code, EXIT_BOUNDARY);
	assert.match(escapedConfig.stderr, /\.pi-toolbox\.json resolves outside the repository root/);
});

test("argument and repository preconditions use boundary and no-file exits", async (t) => {
	let stderr = "";
	const missingArgument = await run([], {
		stderr: { write: (chunk) => ((stderr += String(chunk)), true) },
	});
	assert.equal(missingArgument, EXIT_BOUNDARY);
	assert.match(stderr, /Usage:/);

	const root = await createTemporaryDirectory(t);
	const empty = await captureRun(root);
	assert.equal(empty.code, EXIT_NO_FILES);

	const file = await writeFixture(root, "root.ts");
	const fileRoot = await captureRun(file);
	assert.equal(fileRoot.code, EXIT_BOUNDARY);
	assert.match(fileRoot.stderr, /not a directory/);

	const missingRoot = await captureRun(path.join(root, "missing"));
	assert.equal(missingRoot.code, EXIT_BOUNDARY);
	assert.match(missingRoot.stderr, /Unable to resolve repository root/);
});

test("file count, per-file bytes, and total bytes each use the resource exit", async (t) => {
	assert.deepEqual(DEFAULT_LIMITS, {
		maxFiles: 50_000,
		maxFileBytes: 10 * 1024 * 1024,
		maxTotalBytes: 512 * 1024 * 1024,
	});
	const root = await createTemporaryDirectory(t);
	await writeFixture(root, "a.ts", "const a = 1;\n");
	await writeFixture(root, "b.ts", "const b = 2;\n");

	const fileCount = await captureRun(root, {
		limits: { maxFiles: 1, maxFileBytes: 1_000, maxTotalBytes: 2_000 },
	});
	assert.equal(fileCount.code, EXIT_RESOURCE);
	assert.match(fileCount.stderr, /Source file count 2 exceeds limit 1/);

	const fileBytes = await captureRun(root, {
		limits: { maxFiles: 10, maxFileBytes: 1, maxTotalBytes: 2_000 },
	});
	assert.equal(fileBytes.code, EXIT_RESOURCE);
	assert.match(fileBytes.stderr, /per-file limit 1/);

	const totalBytes = await captureRun(root, {
		limits: { maxFiles: 10, maxFileBytes: 1_000, maxTotalBytes: 20 },
	});
	assert.equal(totalBytes.code, EXIT_RESOURCE);
	assert.match(totalBytes.stderr, /Total source size .* exceeds limit 20/);
});

test("parse failures and invalid UTF-8 use the analysis exit with escaped paths", async (t) => {
	const malformedRoot = await createTemporaryDirectory(t);
	await writeFixture(malformedRoot, "bad\nname.ts", "const = ;\n");
	const malformed = await captureRun(malformedRoot);
	assert.equal(malformed.code, EXIT_ANALYSIS);
	assert.match(malformed.stderr, /bad\\nname\.ts/);
	assert.doesNotMatch(malformed.stderr, /bad\nname\.ts/);
	assert.match(malformed.stderr, /parse error at L1:C/);

	const encodingRoot = await createTemporaryDirectory(t);
	await writeFixture(encodingRoot, "invalid.ts", Buffer.from([0xff]));
	const invalidEncoding = await captureRun(encodingRoot);
	assert.equal(invalidEncoding.code, EXIT_ANALYSIS);
	assert.match(invalidEncoding.stderr, /source is not valid UTF-8/);
});

test("analysis parses source without executing source or build configuration", async (t) => {
	const root = await createTemporaryDirectory(t);
	const marker = path.join(root, "executed.txt");
	await writeFixture(
		root,
		"danger.ts",
		`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\n`,
	);
	await writeFixture(root, "tsconfig.json", "this is not JSON");
	await writeFixture(root, "package.json", JSON.stringify({ scripts: { preinstall: `touch ${marker}` } }));

	const result = await inspectRepository(root);
	assert.deepEqual(relativePaths(result), ["danger.ts"]);
	await assert.rejects(() => access(marker), { code: "ENOENT" });
});

test("cyclomatic complexity counts each supported decision once", async (t) => {
	const root = await createTemporaryDirectory(t);
	await writeFixture(
		root,
		"decisions.ts",
		[
			"function decisions(a: boolean, b: boolean, items: object) {",
			"  if (a && b) {}",
			"  for (let i = 0; i < 1; i++) {}",
			"  for (const key in items) {}",
			"  for (const item of Object.keys(items)) {}",
			"  while (a) {}",
			"  do {} while (b);",
			"  switch (a) {",
			"    case true: break;",
			"    case false: break;",
			"    default: break;",
			"  }",
			"  try {} catch {} finally {}",
			"  const x = a ? 1 : 2;",
			"  a ||= b;",
			"  a &&= b;",
			"  a ??= b;",
			"  const either = a || b;",
			"  const fallback = a ?? b;",
			"  const y = items?.value;",
			"}",
		].join("\n"),
	);

	const result = await inspectRepository(root);
	const metrics = fileMetrics(result, "decisions.ts");
	const scope = scopeMetrics(metrics, "decisions");
	assert.deepEqual(
		{
			complexity: scope.cyclomaticComplexity,
			nesting: scope.maxNestingDepth,
			logicalLines: scope.logicalLineCount,
			parameters: scope.parameterCount,
			locals: scope.localBindingCount,
			quality: scope.qualityScore,
		},
		{ complexity: 17, nesting: 1, logicalLines: 18, parameters: 3, locals: 7, quality: 48 },
	);
	assert.equal(metrics.moduleLogicalLineCount, 19);
	assert.equal(metrics.hardLimitViolationCount, 1);
	assert.equal(metrics.qualityScore, 56);
});

test("control-flow nesting treats else-if bodies as siblings", async (t) => {
	const root = await createTemporaryDirectory(t);
	await writeFixture(
		root,
		"nesting.ts",
		[
			"function nested(active: boolean, items: number[]) {",
			"  if (active) {",
			"    for (const item of items) {",
			"      try {",
			"        while (active) { use(item); }",
			"      } catch {",
			"        if (active) { use(item); }",
			"      } finally { use(item); }",
			"    }",
			"  } else if (items.length) {",
			"    use(items);",
			"  }",
			"}",
		].join("\n"),
	);

	const result = await inspectRepository(root);
	const scope = scopeMetrics(fileMetrics(result, "nesting.ts"), "nested");
	assert.equal(scope.cyclomaticComplexity, 7);
	assert.equal(scope.maxNestingDepth, 4);
});

test("callable parameters and local bindings exclude pseudo-parameters and nested scope locals", async (t) => {
	const root = await createTemporaryDirectory(t);
	await writeFixture(
		root,
		"bindings.ts",
		[
			"class Example {",
			"  constructor(this: Example, public value: number, { a }: { a: number }, ...rest: number[]) {",
			"    const { b, c: d } = { b: 1, c: 2 };",
			"    for (const [e, f] of [[1, 2]]) {}",
			"    try {} catch ({ g }) {}",
			"    function local() {}",
			"    class Inner {}",
			"    const callback = () => { const hidden = 1; if (hidden) {} };",
			"  }",
			"}",
		].join("\n"),
	);

	const result = await inspectRepository(root);
	const metrics = fileMetrics(result, "bindings.ts");
	const constructor = scopeMetrics(metrics, "Example.constructor");
	assert.equal(constructor.parameterCount, 3);
	assert.equal(constructor.localBindingCount, 8);
	assert.equal(constructor.cyclomaticComplexity, 3);
	const callback = scopeMetrics(metrics, "Example.constructor.callback");
	assert.equal(callback.localBindingCount, 1);
	assert.equal(callback.cyclomaticComplexity, 2);
});

test("scope discovery separates syntax kind, role, static blocks, and qualified names", async (t) => {
	const root = await createTemporaryDirectory(t);
	await writeFixture(
		root,
		"scopes.ts",
		[
			"namespace Domain {",
			"  class Service {",
			"    static { const callback = () => 1; }",
			"    method() {}",
			"    get value() { return 1; }",
			"    set value(next: number) {}",
			"    field = () => 1;",
			"  }",
			"  const assigned = function named() {};",
			"  const object = { nested: { run() {} } };",
			"  consume((value) => value);",
			"  (() => 1)();",
			"  const factory = () => () => 1;",
			"}",
			"export default function () {}",
		].join("\n"),
	);

	const result = await inspectRepository(root);
	const scopes = fileMetrics(result, "scopes.ts").scopes;
	const summary = scopes.map((scope) => ({
		name: scope.qualifiedName,
		scope: scope.scopeKind,
		kind: scope.syntaxKind,
		role: scope.role,
	}));
	assert.deepEqual(summary, [
		{ name: "<module>", scope: "module", kind: null, role: null },
		{ name: "Domain.Service.<static@L3>", scope: "static-block", kind: null, role: null },
		{ name: "Domain.Service.<static@L3>.callback", scope: "callable", kind: "arrow", role: "assigned" },
		{ name: "Domain.Service.method", scope: "callable", kind: "method", role: "declaration" },
		{ name: "Domain.Service.value", scope: "callable", kind: "getter", role: "declaration" },
		{ name: "Domain.Service.value", scope: "callable", kind: "setter", role: "declaration" },
		{ name: "Domain.Service.field", scope: "callable", kind: "arrow", role: "assigned" },
		{ name: "Domain.assigned", scope: "callable", kind: "function", role: "assigned" },
		{ name: "Domain.object.nested.run", scope: "callable", kind: "method", role: "declaration" },
		{ name: "Domain.<callback@L11>", scope: "callable", kind: "arrow", role: "callback" },
		{ name: "Domain.<anonymous@L12>", scope: "callable", kind: "arrow", role: "immediate" },
		{ name: "Domain.factory", scope: "callable", kind: "arrow", role: "assigned" },
		{ name: "Domain.factory.<anonymous@L13>", scope: "callable", kind: "arrow", role: "anonymous" },
		{ name: "default", scope: "callable", kind: "function", role: "declaration" },
	]);
});

test("TSX attribute callbacks retain their enclosing callable and assigned role", async (t) => {
	const root = await createTemporaryDirectory(t);
	await writeFixture(
		root,
		"view.tsx",
		[
			"function View({ active }: { active: boolean }) {",
			"  return <button onClick={() => { if (active) {} }}>Save</button>;",
			"}",
		].join("\n"),
	);

	const result = await inspectRepository(root);
	const callback = scopeMetrics(fileMetrics(result, "view.tsx"), "View.onClick");
	assert.equal(callback.syntaxKind, "arrow");
	assert.equal(callback.role, "assigned");
	assert.equal(callback.cyclomaticComplexity, 2);
});

test("module metrics include runtime initialization and isolate class member bodies", async (t) => {
	const root = await createTemporaryDirectory(t);
	await writeFixture(
		root,
		"module.ts",
		[
			'import type { Shape } from "./types.js";',
			'import { type Other, runtime } from "./runtime.js";',
			"interface Contract {}",
			"type Alias = Shape | Other;",
			"declare function ambient(): void;",
			"if (runtime) { use(runtime); }",
			"@sealed",
			"export class Example {",
			"  static selected = runtime ? create() : fallback;",
			"  static { if (runtime) { use(runtime); } }",
			"  instance = create();",
			"  method() { if (runtime) { use(runtime); } }",
			"}",
			"export default create();",
			"export const client = connect();",
			"const simple = 1;",
			"class Plain {",
			"  instance = create();",
			"}",
		].join("\n"),
	);

	const result = await inspectRepository(root);
	const metrics = fileMetrics(result, "module.ts");
	const moduleScope = scopeMetrics(metrics, "<module>");
	const staticBlock = metrics.scopes.find((scope) => scope.scopeKind === "static-block");
	assert.ok(staticBlock);
	assert.equal(moduleScope.cyclomaticComplexity, 3);
	assert.equal(moduleScope.maxNestingDepth, 1);
	assert.equal(staticBlock.cyclomaticComplexity, 2);
	assert.equal(scopeMetrics(metrics, "Example.method").cyclomaticComplexity, 2);
	assert.equal(metrics.moduleLogicalLineCount, 12);
	assert.ok(metrics.scopes.every((scope) => scope.qualifiedName !== "ambient"));
	assert.deepEqual(metrics.topLevelImperativeSpans, [
		{ startLine: 6, endLine: 6 },
		{ startLine: 7, endLine: 13 },
		{ startLine: 14, endLine: 14 },
		{ startLine: 15, endLine: 15 },
	]);
});

test("computed properties are not copied into inferred names", async (t) => {
	const root = await createTemporaryDirectory(t);
	await writeFixture(
		root,
		"computed.ts",
		[
			"const object = {",
			"  [doNotCopyThisExpression()]: function (a: boolean) {",
			"    if (a) {}",
			"  },",
			"};",
		].join("\n"),
	);

	const result = await inspectRepository(root);
	const names = fileMetrics(result, "computed.ts").scopes.map((scope) => scope.qualifiedName);
	assert.ok(names.includes("object.<computed@L2>"));
	assert.ok(names.every((name) => !name.includes("doNotCopyThisExpression")));
});

test("file and scope ranking use deterministic tie breakers", async (t) => {
	const root = await createTemporaryDirectory(t);
	const source = [
		"export function hotspot(a: boolean) {",
		"  if (a) {}",
		"  if (a) {}",
		"  if (a) {}",
		"  if (a) {}",
		"}",
	].join("\n");
	await writeFixture(root, "b.ts", source);
	await writeFixture(root, "a.ts", source);

	const result = await inspectRepository(root);
	const ranked = rankFiles(result.metrics);
	assert.deepEqual(ranked.map((metrics) => metrics.path), ["a.ts", "b.ts"]);
	assert.equal(scopeMetrics(ranked[0], "hotspot").qualityScore, 96);
	assert.equal(ranked[0].qualityScore, 97);
	assert.equal(renderReport(ranked[0]), renderReport(ranked[0]));
});

test("report rendering follows the stable metric order", async (t) => {
	const root = await createTemporaryDirectory(t);
	await writeFixture(
		root,
		"simple.ts",
		[
			"export function simple(value: boolean) {",
			"  if (value) { return 1; }",
			"  return 0;",
			"}",
		].join("\n"),
	);

	const result = await inspectRepository(root);
	assert.equal(
		renderReport(fileMetrics(result, "simple.ts")),
		[
			"- `simple.ts`",
			"  - Quality heuristic: 100/100",
			"  - Module logical lines: 3",
			"  - Executable scopes: 2 (1 module, 0 static blocks, 1 callable)",
			"  - Hard-limit violations: 0",
			"  - Biggest offender: `simple` at L1-L4",
			"    - Scope: callable",
			"    - Kind: function",
			"    - Role: declaration",
			"    - Quality heuristic: 100/100",
			"    - Cyclomatic complexity: 2",
			"    - Maximum nesting depth: 1",
			"    - Logical lines: 2",
			"    - Parameters: 1",
			"    - Local bindings: 0",
			"",
		].join("\n"),
	);
});

test("top-level imperative reporting is capped without dominating file quality", async (t) => {
	const root = await createTemporaryDirectory(t);
	await writeFixture(
		root,
		"builders.ts",
		['"use strict";', ...Array.from({ length: 12 }, (_, index) => `export const schema${index} = defineSchema();`)].join("\n"),
	);

	const result = await inspectRepository(root);
	const metrics = fileMetrics(result, "builders.ts");
	assert.equal(metrics.topLevelImperativeSpans.length, 12);
	assert.equal(metrics.qualityScore, 97);
	const report = renderReport(metrics);
	assert.match(report, /at L2, L3, L4, L5, L6, L7, L8, L9, L10, L11, and 2 more/);
	assert.doesNotMatch(report, /    - (Kind|Role|Parameters|Local bindings):/);
});

test("report rendering is deterministic and contains no raw control characters from paths or names", async (t) => {
	const root = await createTemporaryDirectory(t);
	const relativePath = " odd`name\nü.ts";
	await writeFixture(
		root,
		relativePath,
		[
			"const object = {",
			'  "run`\\n\\t\\0name": function (a, b, c, d, e) {',
			"    if (a && b && c) {}",
			"    if (d || e) {}",
			"  },",
			"};",
		].join("\n"),
	);

	const first = await captureRun(root);
	const second = await captureRun(root);
	assert.equal(first.code, 0, first.stderr);
	assert.equal(first.stdout, second.stdout);
	assert.equal(first.stderr, "");
	assert.match(first.stdout, /^- ``  odd`name\\nü\.ts ``$/m);
	assert.match(first.stdout, /object\."run`\\n\\t\\u0000name"/);
	assert.doesNotMatch(first.stdout, /[\u0000\u0009\u000d]/);
	assert.ok(first.stdout.endsWith("\n"));
});
