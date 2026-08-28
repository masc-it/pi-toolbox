import { readFileSync } from "node:fs";
import { basename, dirname, extname, relative, sep } from "node:path";
import { parseDocument } from "yaml";
import { isMemoryCollectionPath } from "./config.ts";
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
	const relativeDirectory = relative(root, dirname(path)).split(sep).filter(Boolean).join("/");
	if (filename === "index.md") {
		if (relativeDirectory !== "" && relativeDirectory !== "projects" && !isMemoryCollectionPath(relativeDirectory)) {
			throw new Error(`Memory index uses an invalid collection path: ${documentPath}`);
		}
		validateIndex(content, relativeDirectory === "");
		return { path, kind: "index" };
	}
	if (!isMemoryCollectionPath(relativeDirectory)) {
		throw new Error(`Memory concept must be stored under a configured collection: ${documentPath}`);
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
	const frontmatter = parseFrontmatter(content);
	const keys = Object.keys(frontmatter);
	if (isRootIndex) {
		if (keys.some((key) => key !== "okf_version")) {
			throw new Error("Root OKF index frontmatter may contain only okf_version");
		}
		if (typeof frontmatter.okf_version !== "string" || frontmatter.okf_version.trim().length === 0) {
			throw new Error("Root OKF index frontmatter requires a non-empty okf_version");
		}
		return;
	}

	if (keys.some((key) => !["type", "title", "description"].includes(key))) {
		throw new Error("Collection index frontmatter may contain only type, title, and description");
	}
	if (frontmatter.type !== "index") {
		throw new Error("Collection index frontmatter requires type: index");
	}
	validateRequiredSingleLineString(frontmatter.title, "title");
	validateRequiredSingleLineString(frontmatter.description, "description");
}

function parseFrontmatter(content: string): Record<string, unknown> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (!match) {
		throw new Error("OKF document must start with a complete YAML frontmatter block");
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

function validateRequiredSingleLineString(value: unknown, field: string): void {
	if (typeof value !== "string" || value.trim().length === 0 || /[\r\n]/.test(value)) {
		throw new Error(`Collection index ${field} must be a non-empty single-line string`);
	}
}

function validateOptionalString(value: unknown, field: string): void {
	if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
		throw new Error(`OKF concept ${field} must be a non-empty string`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
