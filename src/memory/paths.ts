import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function canonicalizeWorkingDirectory(cwd: string): string {
	if (cwd.trim().length === 0) {
		throw new Error("Working directory must not be empty");
	}

	const canonicalPath = realpathSync(cwd);
	if (!statSync(canonicalPath).isDirectory()) {
		throw new Error(`Working directory is not a directory: ${cwd}`);
	}
	return canonicalPath;
}

export function canonicalizeKnowledgeBaseDirectory(directory: string): string {
	if (directory.trim().length === 0) {
		throw new Error("Knowledge-base directory must not be empty");
	}

	const canonicalPath = realpathSync(directory);
	if (!statSync(canonicalPath).isDirectory()) {
		throw new Error(`Knowledge-base path is not a directory: ${directory}`);
	}
	return canonicalPath;
}

export function resolveKnowledgeBaseDocumentPath(
	knowledgeBaseDirectory: string,
	documentPath: string,
): string {
	const root = canonicalizeKnowledgeBaseDirectory(knowledgeBaseDirectory);
	if (documentPath.trim().length === 0) {
		throw new Error("Knowledge-base document path must not be empty");
	}

	const requestedPath = isAbsolute(documentPath) ? documentPath : resolve(root, documentPath);
	const canonicalPath = realpathSync(requestedPath);
	if (!statSync(canonicalPath).isFile()) {
		throw new Error(`Knowledge-base document is not a file: ${documentPath}`);
	}
	if (!isPathWithin(root, canonicalPath)) {
		throw new Error(`Knowledge-base document is outside ${root}: ${documentPath}`);
	}
	return canonicalPath;
}

function isPathWithin(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return pathFromRoot.length > 0 && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}
