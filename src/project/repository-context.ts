import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_FILES = 400;
const MAX_CONTEXT_FILE_CHARACTERS = 12_000;
const CONTEXT_FILES = ["README.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"] as const;

export interface RepositoryContext {
	branch: string;
	files: string[];
	contextFiles: Record<string, string>;
}

export class RepositoryInspector {
	async inspect(root: string): Promise<RepositoryContext> {
		const [branch, fileOutput] = await Promise.all([
			runGit(root, ["branch", "--show-current"]),
			runGit(root, ["ls-files"]),
		]);
		const files = fileOutput
			.split("\n")
			.map((file) => file.trim())
			.filter(Boolean)
			.slice(0, MAX_FILES);
		const contextFiles: Record<string, string> = {};
		for (const file of CONTEXT_FILES) {
			if (!files.includes(file)) {
				continue;
			}
			const content = await readFile(join(root, file), "utf8");
			contextFiles[file] = content.slice(0, MAX_CONTEXT_FILE_CHARACTERS);
		}
		return { branch: branch || "detached", files, contextFiles };
	}
}

export function formatRepositoryContext(context: RepositoryContext): string {
	const sections = [`Branch: ${context.branch}`, `Tracked files:\n${context.files.join("\n")}`];
	for (const [path, content] of Object.entries(context.contextFiles)) {
		sections.push(`${path}:\n${content}`);
	}
	return sections.join("\n\n");
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
	return result.stdout.trim();
}
