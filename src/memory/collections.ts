import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
	isMemoryCollectionRoot,
	isMemoryCollectionSegment,
	MEMORY_GLOBAL_COLLECTIONS,
	toMemoryCollectionSegment,
	type MemoryCollectionPath,
	type MemoryRoutingContext,
} from "./config.ts";
import { canonicalizeWorkingDirectory } from "./paths.ts";

export function resolveMemoryRoutingContext(
	knowledgeBaseDirectory: string,
	cwd: string,
): MemoryRoutingContext {
	const currentProjectCollection = resolveCurrentProjectCollection(cwd);
	const availableCollections = new Set<MemoryCollectionPath>([
		...MEMORY_GLOBAL_COLLECTIONS,
		...listProjectCollections(knowledgeBaseDirectory),
		currentProjectCollection,
	]);
	return {
		currentProjectCollection,
		availableCollections: [...availableCollections].sort(),
	};
}

export function resolveCurrentProjectCollection(cwd: string): MemoryCollectionPath {
	const projectRoot = resolveProjectRoot(cwd);
	const projectSlug = toMemoryCollectionSegment(basename(projectRoot));
	return `projects/${projectSlug}`;
}

export function listProjectCollections(knowledgeBaseDirectory: string): MemoryCollectionPath[] {
	validateRootDirectories(knowledgeBaseDirectory);
	const projectsDirectory = join(knowledgeBaseDirectory, "projects");
	return readdirSync(projectsDirectory, { withFileTypes: true })
		.filter((entry) => {
			if (entry.isFile() && entry.name === "index.md") {
				return false;
			}
			if (!entry.isDirectory()) {
				throw new Error(`Projects must be stored in directories: projects/${entry.name}`);
			}
			if (!isMemoryCollectionSegment(entry.name)) {
				throw new Error(`Memory project directory has an invalid name: projects/${entry.name}`);
			}
			return true;
		})
		.map((entry) => `projects/${entry.name}`)
		.sort();
}

function validateRootDirectories(knowledgeBaseDirectory: string): void {
	for (const entry of readdirSync(knowledgeBaseDirectory, { withFileTypes: true })) {
		if (entry.name === ".git" || (entry.isFile() && entry.name === "index.md")) {
			continue;
		}
		if (!entry.isDirectory() || !isMemoryCollectionRoot(entry.name)) {
			throw new Error(`Knowledge-base root contains an invalid entry: ${entry.name}`);
		}
	}
}

function resolveProjectRoot(cwd: string): string {
	const canonicalCwd = canonicalizeWorkingDirectory(cwd);
	const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: canonicalCwd,
		encoding: "utf8",
		shell: false,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		if (result.stderr.includes("not a git repository")) {
			return canonicalCwd;
		}
		throw new Error(result.stderr.trim() || `Unable to resolve the Memory project root for: ${canonicalCwd}`);
	}
	const root = result.stdout.trim();
	if (root.length === 0) {
		throw new Error(`Git returned an empty project root for: ${canonicalCwd}`);
	}
	return canonicalizeWorkingDirectory(root);
}
