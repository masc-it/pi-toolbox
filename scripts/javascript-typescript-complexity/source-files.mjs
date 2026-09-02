import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import {
	AnalysisError,
	BoundaryError,
	DEFAULT_LIMITS,
	ResourceLimitError,
	compareText,
	displayValue,
	errorMessage,
	escapeControls,
	isNodeError,
	validateLimits,
} from "./analyzer-contract.mjs";
import { analyzeSourceFile } from "./scope-metrics.mjs";

const execFileAsync = promisify(execFile);
const CONFIG_FILENAME = ".pi-toolbox.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
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
	".venv",
	".yarn",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"out",
	"site-packages",
	"venv",
]);
const TEST_DIRECTORIES = new Set(["test", "tests", "__tests__"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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
	if (!(await repositoryConfigExists(configPath))) return [];
	const resolvedConfig = await resolveRepositoryConfig(root, configPath);
	await validateRepositoryConfigFile(resolvedConfig);
	const source = await readRepositoryConfigSource(resolvedConfig);
	return parseExcludePaths(parseRepositoryConfig(source));
}

async function repositoryConfigExists(configPath) {
	try {
		await access(configPath, fsConstants.F_OK);
		return true;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return false;
		throw new BoundaryError(`Unable to access ${CONFIG_FILENAME}: ${errorMessage(error)}`);
	}
}

async function resolveRepositoryConfig(root, configPath) {
	let resolvedConfig;
	try {
		resolvedConfig = await realpath(configPath);
	} catch (error) {
		throw new BoundaryError(`Unable to resolve ${CONFIG_FILENAME}: ${errorMessage(error)}`);
	}
	if (!isInsideRoot(root, resolvedConfig)) {
		throw new BoundaryError(`${CONFIG_FILENAME} resolves outside the repository root`);
	}
	return resolvedConfig;
}

async function validateRepositoryConfigFile(resolvedConfig) {
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
}

async function readRepositoryConfigSource(resolvedConfig) {
	try {
		const result = await readBoundedFile(resolvedConfig, MAX_CONFIG_BYTES);
		if (result.exceeded) throw new BoundaryError(`${CONFIG_FILENAME} exceeds the 64 KiB size limit`);
		return decodeUtf8(result.buffer);
	} catch (error) {
		if (error instanceof BoundaryError) throw error;
		throw new BoundaryError(`Unable to read ${CONFIG_FILENAME} as UTF-8: ${errorMessage(error)}`);
	}
}

function parseRepositoryConfig(source) {
	try {
		return JSON.parse(source);
	} catch (error) {
		throw new BoundaryError(`Unable to parse ${CONFIG_FILENAME}: ${errorMessage(error)}`);
	}
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
		const file = await discoverSourceFile(root, rawPath, excludePaths);
		if (file) resolvedFiles.set(file.absolutePath, file);
	}
	return [...resolvedFiles.values()].sort((left, right) => compareText(left.relativePath, right.relativePath));
}

async function discoverSourceFile(root, rawPath, excludePaths) {
	const initialRelative = validateDiscoveredPath(rawPath, excludePaths);
	if (!initialRelative) return null;
	const candidate = sourceCandidatePath(root, initialRelative);
	const resolved = await resolveSourceCandidate(root, candidate, initialRelative);
	if (!resolved) return null;
	return inspectSourceCandidate(root, resolved, initialRelative, excludePaths);
}

function validateDiscoveredPath(rawPath, excludePaths) {
	if (path.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath)) {
		throw new BoundaryError(`Discovered path is outside the repository root: ${displayValue(rawPath)}`);
	}
	const initialRelative = normalizeRelativePath(rawPath);
	if (!sourceSuffix(initialRelative) || isExcludedPath(initialRelative, false, excludePaths)) return null;
	return initialRelative;
}

function sourceCandidatePath(root, initialRelative) {
	const candidate = path.resolve(root, ...initialRelative.split("/"));
	if (!isInsideRoot(root, candidate)) {
		throw new BoundaryError(`Discovered path is outside the repository root: ${displayValue(initialRelative)}`);
	}
	return candidate;
}

async function resolveSourceCandidate(root, candidate, initialRelative) {
	let resolved;
	try {
		resolved = await realpath(candidate);
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw new BoundaryError(`Unable to resolve discovered path ${displayValue(initialRelative)}: ${errorMessage(error)}`);
	}
	if (!isInsideRoot(root, resolved)) {
		throw new BoundaryError(`Discovered source resolves outside the repository root: ${displayValue(initialRelative)}`);
	}
	return resolved;
}

async function inspectSourceCandidate(root, resolved, initialRelative, excludePaths) {
	let details;
	try {
		details = await stat(resolved);
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw new BoundaryError(`Unable to inspect discovered path ${displayValue(initialRelative)}: ${errorMessage(error)}`);
	}
	if (!details.isFile()) return null;
	const relativePath = toPosixPath(path.relative(root, resolved));
	if (isExcludedPath(relativePath, false, excludePaths)) return null;
	return { absolutePath: resolved, relativePath, size: details.size };
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
		const entries = await readSourceDirectory(current);
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			collectDirectoryEntry(entries[index], current, pending, discovered, excludePaths);
		}
	}
	return discovered;
}

async function readSourceDirectory(current) {
	let entries;
	try {
		entries = await readdir(current.absolutePath, { withFileTypes: true });
	} catch (error) {
		throw new BoundaryError(
			`Unable to discover repository files under ${displayValue(current.relativePath || ".")}: ${errorMessage(error)}`,
		);
	}
	entries.sort((left, right) => compareText(left.name, right.name));
	return entries;
}

function collectDirectoryEntry(entry, current, pending, discovered, excludePaths) {
	const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
	if (entry.isDirectory()) {
		if (!isExcludedPath(relativePath, true, excludePaths)) {
			pending.push({ absolutePath: path.join(current.absolutePath, entry.name), relativePath });
		}
		return;
	}
	if (sourceSuffix(relativePath) && !isExcludedPath(relativePath, false, excludePaths)) {
		discovered.push(relativePath);
	}
}

export function isExcludedPath(relativePath, isDirectory, excludePaths = []) {
	const normalized = normalizeRelativePath(relativePath);
	if (matchesExcludePrefix(normalized, excludePaths)) return true;
	const parts = normalized.split("/");
	const directoryParts = isDirectory ? parts : parts.slice(0, -1);
	if (directoryParts.some((part) => EXCLUDED_DIRECTORIES.has(part) || TEST_DIRECTORIES.has(part))) return true;
	if (isDirectory) return false;
	return isExcludedSourceFilename(parts.at(-1));
}

function isExcludedSourceFilename(filename) {
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
	const metrics = [];
	let totalBytes = 0;
	for (const file of files) {
		const buffer = await readSourceFile(file, limits.maxFileBytes);
		totalBytes += buffer.length;
		if (totalBytes > limits.maxTotalBytes) {
			throw new ResourceLimitError(`Total source size ${totalBytes} bytes exceeds limit ${limits.maxTotalBytes}`);
		}
		const source = decodeSourceFile(file.relativePath, buffer);
		const parsed = parseSourceFile(file.relativePath, source);
		metrics.push(analyzeSourceFile(file.relativePath, parsed));
	}
	return metrics;
}

async function readSourceFile(file, maxFileBytes) {
	try {
		const result = await readBoundedFile(file.absolutePath, maxFileBytes);
		if (result.exceeded) {
			throw new ResourceLimitError(
				`${displayValue(file.relativePath)}: source exceeds per-file limit ${maxFileBytes}`,
			);
		}
		return result.buffer;
	} catch (error) {
		if (error instanceof ResourceLimitError) throw error;
		throw new AnalysisError(file.relativePath, `unable to read source: ${errorMessage(error)}`);
	}
}

function decodeSourceFile(relativePath, buffer) {
	try {
		return decodeUtf8(buffer);
	} catch (error) {
		throw new AnalysisError(relativePath, `source is not valid UTF-8: ${errorMessage(error)}`);
	}
}

function parseSourceFile(relativePath, source) {
	const parsed = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(relativePath));
	const diagnostic = parsed.parseDiagnostics[0];
	if (diagnostic) throw new AnalysisError(relativePath, formatParseDiagnostic(parsed, diagnostic));
	return parsed;
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

function isMaxBufferError(error) {
	return error instanceof Error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
