import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { listProjectCollections } from "./collections.ts";
import {
	isMemoryCollectionRoot,
	isMemoryCollectionSegment,
	isMemoryGlobalCollection,
	MEMORY_COLLECTION_ROOTS,
} from "./config.ts";
import { validateOkfDocument } from "./okf.ts";
import { canonicalizeKnowledgeBaseDirectory } from "./paths.ts";

export class MemoryRepository {
	readonly path: string;

	constructor(path: string) {
		if (path.trim().length === 0) throw new Error("Knowledge-base directory must not be empty");
		if (!existsSync(path)) initializeMemoryRepository(path);
		this.path = canonicalizeKnowledgeBaseDirectory(path);
		runGit(this.path, ["rev-parse", "--git-dir"]);
		this.validateChanges(listWorktreeFiles(this.path));
		if (!gitSucceeds(this.path, ["rev-parse", "--verify", "HEAD"])) {
			bootstrapMemoryRepository(this.path);
		}
	}

	assertClean(): void {
		const status = runGit(this.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
		if (status.length > 0) throw new Error("Memory knowledge-base repository must be clean before curation");
	}

	changedPaths(): string[] {
		const tracked = parseNullSeparated(
			runGit(this.path, ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", "HEAD", "--"]),
		);
		const untracked = parseNullSeparated(runGit(this.path, ["ls-files", "--others", "--exclude-standard", "-z", "--"]));
		return [...new Set([...tracked, ...untracked])].sort();
	}

	validateChanges(paths: readonly string[]): void {
		for (const path of paths) {
			validateRelativeDocumentPath(path);
			const absolutePath = join(this.path, path);
			if (existsSync(absolutePath)) validateOkfDocument(this.path, absolutePath);
		}
		assertCollectionIndexes(this.path);
	}

	commit(paths: readonly string[]): void {
		if (paths.length === 0) throw new Error("Cannot commit an empty Memory change set");
		runGit(this.path, ["add", "--all", "--", ...paths]);
		runGit(this.path, ["commit", "-m", "updated"]);
	}

	rollback(): void {
		runGit(this.path, ["reset", "--hard", "HEAD"]);
		runGit(this.path, ["clean", "-fd"]);
	}
}

function validateRelativeDocumentPath(path: string): void {
	if (path.length === 0 || posix.isAbsolute(path) || posix.normalize(path) !== path || path === ".." || path.startsWith("../")) {
		throw new Error(`Invalid knowledge-base path: ${path}`);
	}
	if (posix.extname(path) !== ".md") throw new Error(`Knowledge-base changes must be Markdown documents: ${path}`);

	const parts = path.split("/");
	if (parts.length === 1) {
		if (path !== "index.md") throw new Error(`Only index.md may be stored at the knowledge-base root: ${path}`);
		return;
	}

	const root = parts[0];
	const filename = parts.at(-1)!;
	const conceptName = posix.basename(filename, ".md");
	if (!isMemoryCollectionRoot(root) || !isMemoryCollectionSegment(conceptName)) {
		throw new Error(`Knowledge-base document uses an invalid collection path: ${path}`);
	}
	if (parts.length === 2) {
		if (root === "projects" && filename !== "index.md") {
			throw new Error(`Project concepts must be stored under projects/<project>: ${path}`);
		}
		if (root !== "projects" && !isMemoryGlobalCollection(root)) {
			throw new Error(`Knowledge-base document uses an invalid global collection: ${path}`);
		}
		return;
	}
	if (parts.length === 3 && root === "projects" && isMemoryCollectionSegment(parts[1])) return;
	throw new Error(`Knowledge-base hierarchy supports only global collections and projects/<project>: ${path}`);
}

function assertCollectionIndexes(root: string): void {
	for (const collectionRoot of MEMORY_COLLECTION_ROOTS) {
		if (!existsSync(join(root, collectionRoot, "index.md"))) {
			throw new Error(`Memory collection is missing its index: ${collectionRoot}/index.md`);
		}
	}
	for (const collectionPath of listProjectCollections(root)) {
		if (!existsSync(join(root, collectionPath, "index.md"))) {
			throw new Error(`Memory project collection is missing its index: ${collectionPath}/index.md`);
		}
	}
}

function initializeMemoryRepository(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	runGit(path, ["init"]);
	writeFileSync(
		join(path, "index.md"),
		`---\nokf_version: "0.2"\n---\n\n# Knowledge base\n\n${MEMORY_COLLECTION_ROOTS.map((root) => `- [${formatCollectionTitle(root)}](${root}/)`).join("\n")}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	for (const root of MEMORY_COLLECTION_ROOTS) {
		mkdirSync(join(path, root));
		writeFileSync(
			join(path, root, "index.md"),
			formatCollectionIndex(formatCollectionTitle(root), collectionDescription(root)),
			{ encoding: "utf8", mode: 0o600 },
		);
	}
}

function bootstrapMemoryRepository(path: string): void {
	runGit(path, ["add", "--all", "--", "."]);
	runGit(path, ["commit", "-m", "initialized"]);
}

function formatCollectionIndex(title: string, description: string): string {
	return `---\ntype: index\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${title}\n`;
}

function collectionDescription(root: (typeof MEMORY_COLLECTION_ROOTS)[number]): string {
	switch (root) {
		case "coding":
			return "Reusable user-wide coding practices.";
		case "docs-style":
			return "Reusable documentation preferences and conventions.";
		case "personal-principles":
			return "User-wide personal and engineering principles.";
		case "projects":
			return "Project-specific knowledge collections.";
		case "team":
			return "Team-wide practices and conventions.";
	}
}

function formatCollectionTitle(value: string): string {
	return value.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function listWorktreeFiles(root: string): string[] {
	const paths: string[] = [];
	visitDirectory(root, "", paths);
	return paths.sort();
}

function visitDirectory(root: string, relativeDirectory: string, paths: string[]): void {
	const directory = join(root, relativeDirectory);
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (relativeDirectory.length === 0 && entry.name === ".git") continue;
		const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
		if (entry.isDirectory()) {
			visitDirectory(root, relativePath, paths);
			continue;
		}
		if (!entry.isFile()) throw new Error(`Knowledge-base entries must be regular files: ${relativePath}`);
		paths.push(relativePath);
	}
}

function runGit(cwd: string, args: string[]): string {
	const result = runGitProcess(cwd, args);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed with status ${result.status ?? "unknown"}`);
	}
	return result.stdout;
}

function gitSucceeds(cwd: string, args: string[]): boolean {
	const result = runGitProcess(cwd, args);
	if (result.error) throw result.error;
	return result.status === 0;
}

function runGitProcess(cwd: string, args: string[]) {
	return spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		shell: false,
		maxBuffer: 10 * 1024 * 1024,
	});
}

function parseNullSeparated(value: string): string[] {
	return value.split("\0").filter((path) => path.length > 0);
}
