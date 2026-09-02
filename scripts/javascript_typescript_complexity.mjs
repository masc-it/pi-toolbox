#!/usr/bin/env node

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";

const execFileAsync = promisify(execFile);
const CONFIG_FILENAME = ".pi-toolbox.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export const EXIT_BOUNDARY = 2;
export const EXIT_NO_FILES = 3;
export const EXIT_ANALYSIS = 4;
export const EXIT_INVARIANT = 5;
export const EXIT_RESOURCE = 6;

export const DEFAULT_LIMITS = Object.freeze({
	maxFiles: 50_000,
	maxFileBytes: 10 * 1024 * 1024,
	maxTotalBytes: 512 * 1024 * 1024,
});

const SOURCE_SUFFIXES = Object.freeze([".jsx", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".js", ".ts"]);
const DECLARATION_SUFFIXES = Object.freeze([".d.ts", ".d.mts", ".d.cts"]);
const EXCLUDED_DIRECTORIES = new Set([
	".git",
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
]);
const TEST_DIRECTORIES = new Set(["test", "tests", "__tests__"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

class AnalyzerError extends Error {
	constructor(message, exitCode) {
		super(message);
		this.name = new.target.name;
		this.exitCode = exitCode;
	}
}

class BoundaryError extends AnalyzerError {
	constructor(message) {
		super(message, EXIT_BOUNDARY);
	}
}

class NoFilesError extends AnalyzerError {
	constructor(message) {
		super(message, EXIT_NO_FILES);
	}
}

class AnalysisError extends AnalyzerError {
	constructor(relativePath, message) {
		super(`${displayValue(relativePath)}: ${message}`, EXIT_ANALYSIS);
	}
}

class ResourceLimitError extends AnalyzerError {
	constructor(message) {
		super(message, EXIT_RESOURCE);
	}
}

export function parseArguments(argv) {
	if (argv.length !== 2 || argv[0] !== "--repo-root" || argv[1].length === 0) {
		throw new BoundaryError("Usage: javascript_typescript_complexity.mjs --repo-root <directory>");
	}
	return { repoRoot: argv[1] };
}

export async function inspectRepository(repoRootInput, options = {}) {
	const limits = options.limits ?? DEFAULT_LIMITS;
	validateLimits(limits);
	const root = await resolveRepositoryRoot(repoRootInput);
	const excludePaths = await readRepositoryExclusions(root);
	const files = await discoverSourceFiles(root, excludePaths);
	if (files.length === 0) {
		throw new NoFilesError(`No production JavaScript or TypeScript files found under ${displayValue(root)}`);
	}
	enforceRepositoryLimits(files, limits);
	await parseSourceFiles(files, limits);
	return { root, files };
}

export async function run(argv, options = {}) {
	const stderr = options.stderr ?? process.stderr;
	try {
		const { repoRoot } = parseArguments(argv);
		await inspectRepository(repoRoot, { limits: options.limits ?? DEFAULT_LIMITS });
		return 0;
	} catch (error) {
		if (error instanceof AnalyzerError) {
			stderr.write(`${escapeControls(error.message)}\n`);
			return error.exitCode;
		}
		const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		stderr.write(`Analyzer invariant failed: ${escapeControls(details)}\n`);
		return EXIT_INVARIANT;
	}
}

export async function resolveRepositoryRoot(repoRootInput) {
	const requested = path.resolve(repoRootInput);
	let resolved;
	try {
		resolved = await realpath(requested);
	} catch (error) {
		throw new BoundaryError(`Unable to resolve repository root ${displayValue(requested)}: ${errorMessage(error)}`);
	}

	let details;
	try {
		details = await stat(resolved);
	} catch (error) {
		throw new BoundaryError(`Unable to inspect repository root ${displayValue(resolved)}: ${errorMessage(error)}`);
	}
	if (!details.isDirectory()) {
		throw new BoundaryError(`Repository root is not a directory: ${displayValue(resolved)}`);
	}
	return resolved;
}

export async function readRepositoryExclusions(root) {
	const configPath = path.join(root, CONFIG_FILENAME);
	try {
		await access(configPath, fsConstants.F_OK);
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return [];
		throw new BoundaryError(`Unable to access ${CONFIG_FILENAME}: ${errorMessage(error)}`);
	}

	let resolvedConfig;
	try {
		resolvedConfig = await realpath(configPath);
	} catch (error) {
		throw new BoundaryError(`Unable to resolve ${CONFIG_FILENAME}: ${errorMessage(error)}`);
	}
	if (!isInsideRoot(root, resolvedConfig)) {
		throw new BoundaryError(`${CONFIG_FILENAME} resolves outside the repository root`);
	}

	let details;
	try {
		details = await stat(resolvedConfig);
	} catch (error) {
		throw new BoundaryError(`Unable to inspect ${CONFIG_FILENAME}: ${errorMessage(error)}`);
	}
	if (!details.isFile()) throw new BoundaryError(`${CONFIG_FILENAME} is not a regular file`);
	if (details.size > MAX_CONFIG_BYTES) {
		throw new BoundaryError(`${CONFIG_FILENAME} exceeds the 64 KiB size limit`);
	}

	let source;
	try {
		const result = await readBoundedFile(resolvedConfig, MAX_CONFIG_BYTES);
		if (result.exceeded) throw new BoundaryError(`${CONFIG_FILENAME} exceeds the 64 KiB size limit`);
		source = decodeUtf8(result.buffer);
	} catch (error) {
		if (error instanceof BoundaryError) throw error;
		throw new BoundaryError(`Unable to read ${CONFIG_FILENAME} as UTF-8: ${errorMessage(error)}`);
	}

	let config;
	try {
		config = JSON.parse(source);
	} catch (error) {
		throw new BoundaryError(`Unable to parse ${CONFIG_FILENAME}: ${errorMessage(error)}`);
	}
	return parseExcludePaths(config);
}

function parseExcludePaths(config) {
	if (!isRecord(config)) throw new BoundaryError(`${CONFIG_FILENAME} must contain a JSON object`);
	if (!("complexity" in config)) return [];
	if (!isRecord(config.complexity)) throw new BoundaryError(`${CONFIG_FILENAME} complexity must be an object`);
	if (!("javascriptTypeScript" in config.complexity)) return [];
	const settings = config.complexity.javascriptTypeScript;
	if (!isRecord(settings)) {
		throw new BoundaryError(`${CONFIG_FILENAME} complexity.javascriptTypeScript must be an object`);
	}
	if (!("excludePaths" in settings)) return [];
	if (!Array.isArray(settings.excludePaths)) {
		throw new BoundaryError(`${CONFIG_FILENAME} complexity.javascriptTypeScript.excludePaths must be an array`);
	}

	const exclusions = settings.excludePaths.map((value, index) => normalizeExcludePath(value, index));
	return [...new Set(exclusions)].sort();
}

function normalizeExcludePath(value, index) {
	const label = `${CONFIG_FILENAME} excludePaths[${index}]`;
	if (typeof value !== "string") throw new BoundaryError(`${label} must be a string`);
	if (value.length === 0) throw new BoundaryError(`${label} must not be empty`);
	if (value.includes("\0")) throw new BoundaryError(`${label} must not contain NUL bytes`);
	if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
		throw new BoundaryError(`${label} must be project-relative`);
	}

	const components = value.split(/[\\/]/);
	if (components.some((component) => component.length === 0 || component === "." || component === "..")) {
		throw new BoundaryError(`${label} must not contain empty, '.' or '..' components`);
	}
	return components.join("/");
}

export async function discoverSourceFiles(root, excludePaths = []) {
	const gitPaths = await listGitPaths(root);
	const rawPaths = gitPaths ?? (await walkSourcePaths(root, excludePaths));
	const resolvedFiles = new Map();

	for (const rawPath of rawPaths) {
		if (path.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath)) {
			throw new BoundaryError(`Discovered path is outside the repository root: ${displayValue(rawPath)}`);
		}
		const initialRelative = normalizeRelativePath(rawPath);
		if (!sourceSuffix(initialRelative) || isExcludedPath(initialRelative, false, excludePaths)) continue;

		const candidate = path.resolve(root, ...initialRelative.split("/"));
		if (!isInsideRoot(root, candidate)) {
			throw new BoundaryError(`Discovered path is outside the repository root: ${displayValue(initialRelative)}`);
		}

		let resolved;
		try {
			resolved = await realpath(candidate);
		} catch (error) {
			if (isNodeError(error, "ENOENT")) continue;
			throw new BoundaryError(`Unable to resolve discovered path ${displayValue(initialRelative)}: ${errorMessage(error)}`);
		}
		if (!isInsideRoot(root, resolved)) {
			throw new BoundaryError(`Discovered source resolves outside the repository root: ${displayValue(initialRelative)}`);
		}

		let details;
		try {
			details = await stat(resolved);
		} catch (error) {
			if (isNodeError(error, "ENOENT")) continue;
			throw new BoundaryError(`Unable to inspect discovered path ${displayValue(initialRelative)}: ${errorMessage(error)}`);
		}
		if (!details.isFile()) continue;

		const relativePath = toPosixPath(path.relative(root, resolved));
		if (isExcludedPath(relativePath, false, excludePaths)) continue;
		resolvedFiles.set(resolved, { absolutePath: resolved, relativePath, size: details.size });
	}

	return [...resolvedFiles.values()].sort((left, right) => compareText(left.relativePath, right.relativePath));
}

async function listGitPaths(root) {
	let result;
	try {
		result = await execFileAsync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			encoding: "buffer",
			maxBuffer: MAX_GIT_OUTPUT_BYTES,
		});
	} catch (error) {
		if (isMaxBufferError(error)) {
			throw new ResourceLimitError("Git discovery output exceeds the 64 MiB limit");
		}
		return null;
	}

	const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
	const paths = [];
	for (const item of splitNullTerminated(stdout)) {
		try {
			paths.push(decodeUtf8(item));
		} catch (error) {
			throw new BoundaryError(`Git returned a path that is not valid UTF-8: ${errorMessage(error)}`);
		}
	}
	return paths;
}

async function walkSourcePaths(root, excludePaths) {
	const discovered = [];
	const pending = [{ absolutePath: root, relativePath: "" }];

	while (pending.length > 0) {
		const current = pending.pop();
		let entries;
		try {
			entries = await readdir(current.absolutePath, { withFileTypes: true });
		} catch (error) {
			throw new BoundaryError(`Unable to discover repository files under ${displayValue(current.relativePath || ".")}: ${errorMessage(error)}`);
		}
		entries.sort((left, right) => compareText(left.name, right.name));

		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!isExcludedPath(relativePath, true, excludePaths)) {
					pending.push({ absolutePath: path.join(current.absolutePath, entry.name), relativePath });
				}
				continue;
			}
			if (sourceSuffix(relativePath) && !isExcludedPath(relativePath, false, excludePaths)) {
				discovered.push(relativePath);
			}
		}
	}
	return discovered;
}

export function isExcludedPath(relativePath, isDirectory, excludePaths = []) {
	const normalized = normalizeRelativePath(relativePath);
	if (matchesExcludePrefix(normalized, excludePaths)) return true;

	const parts = normalized.split("/");
	const directoryParts = isDirectory ? parts : parts.slice(0, -1);
	if (directoryParts.some((part) => EXCLUDED_DIRECTORIES.has(part) || TEST_DIRECTORIES.has(part))) return true;
	if (isDirectory) return false;

	const filename = parts.at(-1);
	const suffix = sourceSuffix(filename);
	if (!suffix || isDeclarationFile(filename)) return true;
	const stem = filename.slice(0, -suffix.length);
	if (stem.endsWith(".test") || stem.endsWith(".spec") || stem.endsWith(".min")) return true;
	return filename.includes(".bundle.");
}

function matchesExcludePrefix(relativePath, excludePaths) {
	return excludePaths.some((excluded) => relativePath === excluded || relativePath.startsWith(`${excluded}/`));
}

function sourceSuffix(filename) {
	return SOURCE_SUFFIXES.find((suffix) => filename.endsWith(suffix)) ?? null;
}

function isDeclarationFile(filename) {
	return DECLARATION_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

export function enforceRepositoryLimits(files, limits = DEFAULT_LIMITS) {
	validateLimits(limits);
	if (files.length > limits.maxFiles) {
		throw new ResourceLimitError(`Source file count ${files.length} exceeds limit ${limits.maxFiles}`);
	}

	let totalBytes = 0;
	for (const file of files) {
		if (file.size > limits.maxFileBytes) {
			throw new ResourceLimitError(
				`${displayValue(file.relativePath)}: source size ${file.size} bytes exceeds per-file limit ${limits.maxFileBytes}`,
			);
		}
		totalBytes += file.size;
		if (totalBytes > limits.maxTotalBytes) {
			throw new ResourceLimitError(`Total source size ${totalBytes} bytes exceeds limit ${limits.maxTotalBytes}`);
		}
	}
}

export async function parseSourceFiles(files, limits = DEFAULT_LIMITS) {
	let totalBytes = 0;
	for (const file of files) {
		let buffer;
		try {
			const result = await readBoundedFile(file.absolutePath, limits.maxFileBytes);
			if (result.exceeded) {
				throw new ResourceLimitError(
					`${displayValue(file.relativePath)}: source exceeds per-file limit ${limits.maxFileBytes}`,
				);
			}
			buffer = result.buffer;
		} catch (error) {
			if (error instanceof ResourceLimitError) throw error;
			throw new AnalysisError(file.relativePath, `unable to read source: ${errorMessage(error)}`);
		}
		totalBytes += buffer.length;
		if (totalBytes > limits.maxTotalBytes) {
			throw new ResourceLimitError(`Total source size ${totalBytes} bytes exceeds limit ${limits.maxTotalBytes}`);
		}

		let source;
		try {
			source = decodeUtf8(buffer);
		} catch (error) {
			throw new AnalysisError(file.relativePath, `source is not valid UTF-8: ${errorMessage(error)}`);
		}

		const parsed = ts.createSourceFile(
			file.relativePath,
			source,
			ts.ScriptTarget.Latest,
			true,
			scriptKindFor(file.relativePath),
		);
		const diagnostic = parsed.parseDiagnostics[0];
		if (diagnostic) throw new AnalysisError(file.relativePath, formatParseDiagnostic(parsed, diagnostic));
	}
}

function scriptKindFor(filename) {
	const suffix = sourceSuffix(filename);
	switch (suffix) {
		case ".js":
		case ".mjs":
		case ".cjs":
			return ts.ScriptKind.JS;
		case ".jsx":
			return ts.ScriptKind.JSX;
		case ".ts":
		case ".mts":
		case ".cts":
			return ts.ScriptKind.TS;
		case ".tsx":
			return ts.ScriptKind.TSX;
		default:
			throw new Error(`Missing ScriptKind for ${filename}`);
	}
}

function formatParseDiagnostic(sourceFile, diagnostic) {
	const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
	if (typeof diagnostic.start !== "number") return `parse error: ${escapeControls(message)}`;
	const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
	return `parse error at L${position.line + 1}:C${position.character + 1}: ${escapeControls(message)}`;
}

function validateLimits(limits) {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid analyzer limit ${name}`);
	}
}

function normalizeRelativePath(value) {
	return toPosixPath(path.normalize(value)).replace(/^\.\//, "");
}

function toPosixPath(value) {
	return value.split(path.sep).join("/");
}

function isInsideRoot(root, candidate) {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function readBoundedFile(filePath, maxBytes) {
	const handle = await open(filePath, "r");
	const chunks = [];
	let totalBytes = 0;
	try {
		while (totalBytes <= maxBytes) {
			const remaining = maxBytes + 1 - totalBytes;
			const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			chunks.push(chunk.subarray(0, bytesRead));
			totalBytes += bytesRead;
		}
	} finally {
		await handle.close();
	}
	return { buffer: Buffer.concat(chunks, totalBytes), exceeded: totalBytes > maxBytes };
}

function decodeUtf8(buffer) {
	return UTF8_DECODER.decode(buffer);
}

function splitNullTerminated(buffer) {
	const values = [];
	let start = 0;
	for (let index = 0; index < buffer.length; index += 1) {
		if (buffer[index] !== 0) continue;
		if (index > start) values.push(buffer.subarray(start, index));
		start = index + 1;
	}
	if (start < buffer.length) values.push(buffer.subarray(start));
	return values;
}

function displayValue(value) {
	return JSON.stringify(String(value));
}

function escapeControls(value) {
	return String(value).replace(/[\u0000-\u001f\u007f]/g, (character) => {
		switch (character) {
			case "\n":
				return "\\n";
			case "\r":
				return "\\r";
			case "\t":
				return "\\t";
			default:
				return `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`;
		}
	});
}

function errorMessage(error) {
	return escapeControls(error instanceof Error ? error.message : String(error));
}

function isNodeError(error, code) {
	return error instanceof Error && "code" in error && error.code === code;
}

function isMaxBufferError(error) {
	return error instanceof Error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left, right) {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

const mainPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (mainPath === fileURLToPath(import.meta.url)) {
	process.exitCode = await run(process.argv.slice(2));
}
