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

async function captureRun(root, options = {}) {
	let stderr = "";
	const code = await run(["--repo-root", root], {
		...options,
		stderr: {
			write(chunk) {
				stderr += String(chunk);
				return true;
			},
		},
	});
	return { code, stderr };
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
		".yarn",
		"build",
		"coverage",
		"dist",
		"node_modules",
		"out",
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
