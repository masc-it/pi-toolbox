import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryRepository } from "../../src/memory/repository.ts";

function createRepository(t: { after: (callback: () => void) => void }): MemoryRepository {
	const directory = mkdtempSync(join(tmpdir(), "pi-toolbox-memory-repository-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return withGitIdentity(() => new MemoryRepository(join(directory, "knowledge")));
}

function withGitIdentity<T>(operation: () => T): T {
	const identity = {
		GIT_AUTHOR_NAME: "Pi Toolbox Tests",
		GIT_AUTHOR_EMAIL: "pi-toolbox@example.invalid",
		GIT_COMMITTER_NAME: "Pi Toolbox Tests",
		GIT_COMMITTER_EMAIL: "pi-toolbox@example.invalid",
	};
	const previous = Object.fromEntries(Object.keys(identity).map((name) => [name, process.env[name]]));
	Object.assign(process.env, identity);
	try {
		return operation();
	} finally {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("memory repository accepts every supported document hierarchy", (t) => {
	const repository = createRepository(t);
	for (const path of [
		"index.md",
		"coding/concept.md",
		"docs-style/index.md",
		"projects/index.md",
		"projects/pi-toolbox/concept.md",
	]) {
		assert.doesNotThrow(() => repository.validateChanges([path]), path);
	}
});

test("memory repository preserves document path validation errors and precedence", (t) => {
	const repository = createRepository(t);
	const invalidPaths = [
		["", "Invalid knowledge-base path: "],
		["/index.md", "Invalid knowledge-base path: /index.md"],
		["./index.md", "Invalid knowledge-base path: ./index.md"],
		["coding/../index.md", "Invalid knowledge-base path: coding/../index.md"],
		["../index.md", "Invalid knowledge-base path: ../index.md"],
		["index.txt", "Knowledge-base changes must be Markdown documents: index.txt"],
		["other.md", "Only index.md may be stored at the knowledge-base root: other.md"],
		["unknown/concept.md", "Knowledge-base document uses an invalid collection path: unknown/concept.md"],
		["coding/Bad.md", "Knowledge-base document uses an invalid collection path: coding/Bad.md"],
		["projects/concept.md", "Project concepts must be stored under projects/<project>: projects/concept.md"],
		[
			"projects/Bad/concept.md",
			"Knowledge-base hierarchy supports only global collections and projects/<project>: projects/Bad/concept.md",
		],
		[
			"coding/nested/concept.md",
			"Knowledge-base hierarchy supports only global collections and projects/<project>: coding/nested/concept.md",
		],
	] as const;

	for (const [path, message] of invalidPaths) {
		assert.throws(() => repository.validateChanges([path]), { message }, path);
	}
});

test("memory repository rejects symbolic links as non-regular worktree entries", (t) => {
	if (process.platform === "win32") return t.skip("symbolic links require platform-specific privileges on Windows");
	const repository = createRepository(t);
	symlinkSync(join(repository.path, "coding", "index.md"), join(repository.path, "coding", "linked.md"));
	assert.throws(() => new MemoryRepository(repository.path), {
		message: "Knowledge-base entries must be regular files: coding/linked.md",
	});
});
