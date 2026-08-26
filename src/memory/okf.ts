import { readFileSync } from "node:fs";
import { basename, dirname, extname, relative, sep } from "node:path";
import { parseDocument } from "yaml";
import { isMemoryTopic } from "./config.ts";
import { canonicalizeKnowledgeBaseDirectory, resolveKnowledgeBaseDocumentPath } from "./paths.ts";

export interface ValidatedOkfDocument {
	path: string;
	kind: "concept" | "index";
}

export function validateOkfDocument(
	knowledgeBaseDirectory: string,
	documentPath: string,
): ValidatedOkfDocument {
	const root = canonicalizeKnowledgeBaseDirectory(knowledgeBaseDirectory);
	const path = resolveKnowledgeBaseDocumentPath(root, documentPath);
	if (extname(path) !== ".md") {
		throw new Error(`OKF documents must use the .md extension: ${documentPath}`);
	}

	const content = readFileSync(path, "utf8");
	const filename = basename(path);
	if (filename === "index.md") {
		validateIndex(content, dirname(path) === root);
		return { path, kind: "index" };
	}
	const topic = relative(root, path).split(sep)[0];
	if (!isMemoryTopic(topic)) {
		throw new Error(`Memory concept must be stored under a configured topic: ${documentPath}`);
	}
	validateConcept(content);
	return { path, kind: "concept" };
}

function validateConcept(content: string): void {
	const frontmatter = parseFrontmatter(content);
	if (typeof frontmatter.type !== "string" || frontmatter.type.trim().length === 0) {
		throw new Error("OKF concept frontmatter requires a non-empty type");
	}
	validateOptionalString(frontmatter.title, "title");
	validateOptionalString(frontmatter.description, "description");
	if (typeof frontmatter.description === "string" && /[\r\n]/.test(frontmatter.description)) {
		throw new Error("OKF concept description must fit on one line");
	}
	if (frontmatter.tags !== undefined) {
		if (!Array.isArray(frontmatter.tags) || frontmatter.tags.some((tag) => typeof tag !== "string" || tag.trim().length === 0)) {
			throw new Error("OKF concept tags must be a list of non-empty strings");
		}
	}
}

function validateIndex(content: string, isRootIndex: boolean): void {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
		return;
	}
	if (!isRootIndex) {
		throw new Error("Only the root OKF index may contain frontmatter");
	}
	const frontmatter = parseFrontmatter(content);
	const keys = Object.keys(frontmatter);
	if (keys.some((key) => key !== "okf_version")) {
		throw new Error("Root OKF index frontmatter may contain only okf_version");
	}
	if (typeof frontmatter.okf_version !== "string" || frontmatter.okf_version.trim().length === 0) {
		throw new Error("Root OKF index frontmatter requires a non-empty okf_version");
	}
}

function parseFrontmatter(content: string): Record<string, unknown> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (!match) {
		throw new Error("OKF concept must start with a complete YAML frontmatter block");
	}

	const document = parseDocument(match[1] ?? "");
	if (document.errors.length > 0) {
		throw new Error(`Invalid OKF YAML frontmatter: ${document.errors[0]!.message}`);
	}
	const value = document.toJS() as unknown;
	if (!isRecord(value)) {
		throw new Error("OKF frontmatter must be a YAML mapping");
	}
	return value;
}

function validateOptionalString(value: unknown, field: string): void {
	if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
		throw new Error(`OKF concept ${field} must be a non-empty string`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
