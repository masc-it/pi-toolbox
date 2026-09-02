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
const SOFT_LIMITS = Object.freeze({
	cyclomaticComplexity: 4,
	maxNestingDepth: 2,
	logicalLineCount: 20,
	parameterCount: 4,
	localBindingCount: 8,
	moduleLogicalLineCount: 250,
});
const HARD_LIMITS = Object.freeze({
	cyclomaticComplexity: 10,
	maxNestingDepth: 4,
	logicalLineCount: 40,
	parameterCount: 6,
});
const TOP_LEVEL_IMPERATIVE_PENALTY = 0.25;
const MAX_SCORED_TOP_LEVEL_IMPERATIVE_STATEMENTS = 20;
const MAX_REPORTED_TOP_LEVEL_IMPERATIVE_SPANS = 10;
const DECISION_OPERATORS = new Set([
	ts.SyntaxKind.AmpersandAmpersandToken,
	ts.SyntaxKind.BarBarToken,
	ts.SyntaxKind.QuestionQuestionToken,
	ts.SyntaxKind.AmpersandAmpersandEqualsToken,
	ts.SyntaxKind.BarBarEqualsToken,
	ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

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
	const metrics = await parseSourceFiles(files, limits);
	return { root, files, metrics };
}

export async function run(argv, options = {}) {
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	try {
		const { repoRoot } = parseArguments(argv);
		const { metrics } = await inspectRepository(repoRoot, { limits: options.limits ?? DEFAULT_LIMITS });
		const ranked = rankFiles(metrics);
		if (ranked.length === 0) throw new Error("Repository ranking is empty after successful analysis");
		stdout.write(renderReport(ranked[0]));
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
	const metrics = [];
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
		metrics.push(analyzeSourceFile(file.relativePath, parsed));
	}
	return metrics;
}

export function analyzeSourceFile(relativePath, sourceFile) {
	const scopes = collectExecutableScopes(sourceFile);
	const topLevelImperativeSpans = collectTopLevelImperativeSpans(sourceFile);
	const moduleLogicalLineCount = collectModuleLogicalLines(sourceFile);
	const hardLimitViolationCount = countHardLimitViolations(scopes);
	const qualityScore = scoreFile(scopes, moduleLogicalLineCount, topLevelImperativeSpans.length);
	let highestComplexity = 0;
	let deepestNesting = 0;
	let largestNonModuleScope = 0;
	for (const scope of scopes) {
		highestComplexity = Math.max(highestComplexity, scope.cyclomaticComplexity);
		deepestNesting = Math.max(deepestNesting, scope.maxNestingDepth);
		if (scope.scopeKind !== "module") {
			largestNonModuleScope = Math.max(largestNonModuleScope, scope.logicalLineCount);
		}
	}
	const metrics = {
		path: relativePath,
		moduleLogicalLineCount,
		topLevelImperativeSpans,
		scopes,
		qualityScore,
		hardLimitViolationCount,
		highestComplexity,
		deepestNesting,
		largestNonModuleScope,
	};
	validateFileMetrics(metrics);
	return metrics;
}

function collectExecutableScopes(sourceFile) {
	const scopes = [];
	const moduleDescriptor = {
		scopeKind: "module",
		syntaxKind: null,
		role: null,
		name: "<module>",
		qualifiedName: "<module>",
		startLine: 1,
		endLine: lineAtEnd(sourceFile, sourceFile),
		parameterCount: null,
		localBindingCount: null,
	};
	scopes.push(analyzeScope(sourceFile, moduleDescriptor, sourceFile));

	for (const statement of sourceFile.statements) collectNestedScopes(statement, [], sourceFile, scopes);
	return scopes;
}

function collectNestedScopes(node, containers, sourceFile, scopes) {
	if (isCallableWithBody(node)) {
		const identity = inferCallableIdentity(node, sourceFile);
		const qualifiedName = joinQualifiedName(containers, identity.name);
		const descriptor = {
			scopeKind: "callable",
			syntaxKind: callableSyntaxKind(node),
			role: identity.role,
			name: identity.name,
			qualifiedName,
			...nodeSpan(node, sourceFile),
			parameterCount: countParameters(node),
			localBindingCount: 0,
		};
		scopes.push(analyzeScope(node, descriptor, sourceFile));
		const nestedContainers = [...containers, identity.name];
		for (const decorator of nodeDecorators(node)) collectNestedScopes(decorator.expression, nestedContainers, sourceFile, scopes);
		for (const parameter of node.parameters) {
			for (const decorator of nodeDecorators(parameter)) {
				collectNestedScopes(decorator.expression, nestedContainers, sourceFile, scopes);
			}
			if (parameter.initializer) collectNestedScopes(parameter.initializer, nestedContainers, sourceFile, scopes);
		}
		collectNestedScopes(node.body, nestedContainers, sourceFile, scopes);
		return;
	}

	if (ts.isClassStaticBlockDeclaration(node)) {
		const startLine = lineAtStart(node, sourceFile);
		const name = `<static@L${startLine}>`;
		const descriptor = {
			scopeKind: "static-block",
			syntaxKind: null,
			role: null,
			name,
			qualifiedName: joinQualifiedName(containers, name),
			...nodeSpan(node, sourceFile),
			parameterCount: null,
			localBindingCount: 0,
		};
		scopes.push(analyzeScope(node, descriptor, sourceFile));
		collectNestedScopes(node.body, [...containers, name], sourceFile, scopes);
		return;
	}

	if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
		const className = inferClassName(node, sourceFile);
		const nestedContainers = [...containers, className];
		for (const decorator of nodeDecorators(node)) collectNestedScopes(decorator.expression, nestedContainers, sourceFile, scopes);
		for (const clause of node.heritageClauses ?? []) {
			for (const type of clause.types) collectNestedScopes(type.expression, nestedContainers, sourceFile, scopes);
		}
		for (const member of node.members) {
			for (const decorator of nodeDecorators(member)) {
				collectNestedScopes(decorator.expression, nestedContainers, sourceFile, scopes);
			}
			if (member.name && ts.isComputedPropertyName(member.name)) {
				collectNestedScopes(member.name.expression, nestedContainers, sourceFile, scopes);
			}
			if (ts.isClassStaticBlockDeclaration(member) || isCallableWithBody(member)) {
				collectNestedScopes(member, nestedContainers, sourceFile, scopes);
			} else if (ts.isPropertyDeclaration(member) && member.initializer) {
				collectNestedScopes(member.initializer, nestedContainers, sourceFile, scopes);
			}
		}
		return;
	}

	if (ts.isModuleDeclaration(node)) {
		const namespaceName = propertyNameText(node.name, sourceFile);
		if (node.body) collectNestedScopes(node.body, [...containers, namespaceName], sourceFile, scopes);
		return;
	}

	if (ts.isObjectLiteralExpression(node)) {
		const objectName = inferAssignedExpressionName(node, sourceFile);
		const nestedContainers = objectName ? [...containers, objectName] : containers;
		ts.forEachChild(node, (child) => collectNestedScopes(child, nestedContainers, sourceFile, scopes));
		return;
	}

	ts.forEachChild(node, (child) => collectNestedScopes(child, containers, sourceFile, scopes));
}

function analyzeScope(root, descriptor, sourceFile) {
	const state = {
		cyclomaticComplexity: 1,
		maxNestingDepth: 0,
		nestingDepth: 0,
		logicalLines: new Set(),
		localBindings: new Set(),
	};

	if (root === sourceFile) {
		for (const statement of sourceFile.statements) visitScopeNode(statement, root, sourceFile, state);
	} else if (isCallableWithBody(root)) {
		if (ts.isBlock(root.body)) {
			for (const statement of root.body.statements) visitScopeNode(statement, root, sourceFile, state);
		} else {
			state.logicalLines.add(lineAtStart(root.body, sourceFile));
			visitScopeNode(root.body, root, sourceFile, state);
		}
	} else {
		for (const statement of root.body.statements) visitScopeNode(statement, root, sourceFile, state);
	}

	const metrics = {
		...descriptor,
		cyclomaticComplexity: state.cyclomaticComplexity,
		maxNestingDepth: state.maxNestingDepth,
		logicalLineCount: state.logicalLines.size,
		localBindingCount: descriptor.localBindingCount === null ? null : state.localBindings.size,
		qualityScore: 100,
	};
	metrics.qualityScore = scoreScope(metrics);
	return metrics;
}

function visitScopeNode(node, root, sourceFile, state) {
	if (node !== root && isCallableWithBody(node)) {
		state.logicalLines.add(lineAtStart(node, sourceFile));
		if (ts.isFunctionDeclaration(node) && node.name) state.localBindings.add(node.name.text);
		return;
	}
	if (node !== root && ts.isClassStaticBlockDeclaration(node)) return;
	if (isTypeOnlyRuntimeNode(node)) return;

	if (isCountedStatement(node)) state.logicalLines.add(lineAtStart(node, sourceFile));
	if (ts.isVariableDeclaration(node)) collectBindingNames(node.name, state.localBindings);
	if (ts.isClassDeclaration(node) && node.name) state.localBindings.add(node.name.text);

	if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
		visitClassRuntimeExpressions(node, root, sourceFile, state);
		return;
	}
	if (ts.isIfStatement(node)) {
		state.cyclomaticComplexity += 1;
		visitScopeNode(node.expression, root, sourceFile, state);
		visitNested(node.thenStatement, root, sourceFile, state);
		if (node.elseStatement) {
			if (ts.isIfStatement(node.elseStatement)) visitScopeNode(node.elseStatement, root, sourceFile, state);
			else visitNested(node.elseStatement, root, sourceFile, state);
		}
		return;
	}
	if (ts.isForStatement(node)) {
		state.cyclomaticComplexity += 1;
		if (node.initializer) visitScopeNode(node.initializer, root, sourceFile, state);
		if (node.condition) visitScopeNode(node.condition, root, sourceFile, state);
		if (node.incrementor) visitScopeNode(node.incrementor, root, sourceFile, state);
		visitNested(node.statement, root, sourceFile, state);
		return;
	}
	if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
		state.cyclomaticComplexity += 1;
		visitScopeNode(node.initializer, root, sourceFile, state);
		visitScopeNode(node.expression, root, sourceFile, state);
		visitNested(node.statement, root, sourceFile, state);
		return;
	}
	if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
		state.cyclomaticComplexity += 1;
		visitScopeNode(node.expression, root, sourceFile, state);
		visitNested(node.statement, root, sourceFile, state);
		return;
	}
	if (ts.isSwitchStatement(node)) {
		state.cyclomaticComplexity += node.caseBlock.clauses.filter(ts.isCaseClause).length;
		visitScopeNode(node.expression, root, sourceFile, state);
		withNesting(state, () => {
			for (const clause of node.caseBlock.clauses) {
				if (ts.isCaseClause(clause)) visitScopeNode(clause.expression, root, sourceFile, state);
				for (const statement of clause.statements) visitScopeNode(statement, root, sourceFile, state);
			}
		});
		return;
	}
	if (ts.isTryStatement(node)) {
		visitNested(node.tryBlock, root, sourceFile, state);
		if (node.catchClause) {
			state.cyclomaticComplexity += 1;
			if (node.catchClause.variableDeclaration) {
				collectBindingNames(node.catchClause.variableDeclaration.name, state.localBindings);
			}
			visitNested(node.catchClause.block, root, sourceFile, state);
		}
		if (node.finallyBlock) visitNested(node.finallyBlock, root, sourceFile, state);
		return;
	}
	if (ts.isConditionalExpression(node)) {
		state.cyclomaticComplexity += 1;
		ts.forEachChild(node, (child) => visitScopeNode(child, root, sourceFile, state));
		return;
	}
	if (ts.isBinaryExpression(node) && DECISION_OPERATORS.has(node.operatorToken.kind)) {
		state.cyclomaticComplexity += 1;
	}
	ts.forEachChild(node, (child) => visitScopeNode(child, root, sourceFile, state));
}

function visitNested(node, root, sourceFile, state) {
	withNesting(state, () => visitScopeNode(node, root, sourceFile, state));
}

function withNesting(state, callback) {
	state.nestingDepth += 1;
	state.maxNestingDepth = Math.max(state.maxNestingDepth, state.nestingDepth);
	try {
		callback();
	} finally {
		state.nestingDepth -= 1;
	}
}

function visitClassRuntimeExpressions(node, root, sourceFile, state) {
	for (const decorator of nodeDecorators(node)) visitScopeNode(decorator.expression, root, sourceFile, state);
	for (const clause of node.heritageClauses ?? []) {
		for (const type of clause.types) visitScopeNode(type.expression, root, sourceFile, state);
	}
	for (const member of node.members) {
		for (const decorator of nodeDecorators(member)) visitScopeNode(decorator.expression, root, sourceFile, state);
		if (member.name && ts.isComputedPropertyName(member.name)) {
			visitScopeNode(member.name.expression, root, sourceFile, state);
		}
		if (isStaticMember(member) && ts.isPropertyDeclaration(member) && member.initializer) {
			visitScopeNode(member.initializer, root, sourceFile, state);
		}
	}
}

function collectBindingNames(name, bindings) {
	if (ts.isIdentifier(name)) {
		bindings.add(name.text);
		return;
	}
	for (const element of name.elements) {
		if (!ts.isOmittedExpression(element)) collectBindingNames(element.name, bindings);
	}
}

function countParameters(node) {
	return node.parameters.filter(
		(parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === "this"),
	).length;
}

function isCallableWithBody(node) {
	return (
		(ts.isFunctionDeclaration(node) ||
			ts.isFunctionExpression(node) ||
			ts.isArrowFunction(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isConstructorDeclaration(node) ||
			ts.isGetAccessorDeclaration(node) ||
			ts.isSetAccessorDeclaration(node)) &&
		node.body !== undefined
	);
}

function callableSyntaxKind(node) {
	if (ts.isArrowFunction(node)) return "arrow";
	if (ts.isMethodDeclaration(node)) return "method";
	if (ts.isConstructorDeclaration(node)) return "constructor";
	if (ts.isGetAccessorDeclaration(node)) return "getter";
	if (ts.isSetAccessorDeclaration(node)) return "setter";
	return "function";
}

function inferCallableIdentity(node, sourceFile) {
	if (ts.isFunctionDeclaration(node)) {
		const name = node.name?.text ?? (hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? "default" : anonymousName("anonymous", node, sourceFile));
		return { name, role: "declaration" };
	}
	if (
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	) {
		const name = ts.isConstructorDeclaration(node) ? "constructor" : propertyNameText(node.name, sourceFile);
		return { name, role: "declaration" };
	}

	const context = expressionContext(node);
	const assignedName = assignedNameFromContext(context.expression, context.parent, sourceFile);
	if (assignedName) return { name: assignedName, role: "assigned" };
	if (context.parent && (ts.isCallExpression(context.parent) || ts.isNewExpression(context.parent))) {
		if (context.parent.expression === context.expression) {
			return {
				name: node.name?.text ?? anonymousName("anonymous", node, sourceFile),
				role: "immediate",
			};
		}
		if (context.parent.arguments?.includes(context.expression)) {
			return {
				name: node.name?.text ?? anonymousName("callback", node, sourceFile),
				role: "callback",
			};
		}
	}
	return { name: node.name?.text ?? anonymousName("anonymous", node, sourceFile), role: "anonymous" };
}

function expressionContext(node) {
	let expression = node;
	let parent = node.parent;
	while (parent && isTransparentExpression(parent, expression)) {
		expression = parent;
		parent = parent.parent;
	}
	return { expression, parent };
}

function isTransparentExpression(parent, child) {
	return (
		((ts.isParenthesizedExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isTypeAssertionExpression(parent) ||
			ts.isNonNullExpression(parent) ||
			ts.isSatisfiesExpression(parent)) &&
			parent.expression === child) ||
		(ts.isJsxExpression(parent) && parent.expression === child)
	);
}

function assignedNameFromContext(expression, parent, sourceFile) {
	if (!parent) return null;
	if (ts.isVariableDeclaration(parent) && parent.initializer === expression) {
		return bindingNameText(parent.name, sourceFile);
	}
	if (
		(ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isJsxAttribute(parent)) &&
		parent.initializer === expression
	) {
		return propertyNameText(parent.name, sourceFile);
	}
	if (ts.isBinaryExpression(parent) && parent.right === expression && isAssignmentOperator(parent.operatorToken.kind)) {
		return safeExpressionName(parent.left, sourceFile);
	}
	if (ts.isExportAssignment(parent) && parent.expression === expression) return "default";
	return null;
}

function inferAssignedExpressionName(node, sourceFile) {
	const context = expressionContext(node);
	return assignedNameFromContext(context.expression, context.parent, sourceFile);
}

function inferClassName(node, sourceFile) {
	if (node.name) return node.name.text;
	if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) return "default";
	return inferAssignedExpressionName(node, sourceFile) ?? anonymousName("anonymous-class", node, sourceFile);
}

function bindingNameText(name, sourceFile) {
	return ts.isIdentifier(name) ? name.text : `<computed@L${lineAtStart(name, sourceFile)}>`;
}

function propertyNameText(name, sourceFile) {
	if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
	if (ts.isStringLiteral(name)) return JSON.stringify(name.text);
	if (ts.isNumericLiteral(name)) return name.text;
	return `<computed@L${lineAtStart(name, sourceFile)}>`;
}

function safeExpressionName(node, sourceFile) {
	if (ts.isIdentifier(node)) return node.text;
	if (node.kind === ts.SyntaxKind.ThisKeyword) return "this";
	if (node.kind === ts.SyntaxKind.SuperKeyword) return "super";
	if (ts.isPropertyAccessExpression(node)) {
		const left = safeExpressionName(node.expression, sourceFile);
		return left ? `${left}.${propertyNameText(node.name, sourceFile)}` : null;
	}
	if (ts.isElementAccessExpression(node) && node.argumentExpression) {
		const left = safeExpressionName(node.expression, sourceFile);
		if (!left) return null;
		if (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) {
			return `${left}[${JSON.stringify(node.argumentExpression.text)}]`;
		}
	}
	return `<computed@L${lineAtStart(node, sourceFile)}>`;
}

function anonymousName(label, node, sourceFile) {
	return `<${label}@L${lineAtStart(node, sourceFile)}>`;
}

function joinQualifiedName(containers, name) {
	return [...containers, name].join(".");
}

function nodeDecorators(node) {
	return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function isStaticMember(node) {
	return hasModifier(node, ts.SyntaxKind.StaticKeyword);
}

function hasModifier(node, kind) {
	return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function isAssignmentOperator(kind) {
	return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isCountedStatement(node) {
	return ts.isStatement(node) && !ts.isBlock(node) && !ts.isEmptyStatement(node) && !isTypeOnlyRuntimeNode(node);
}

function isCountedDeclaration(node) {
	return (
		ts.isPropertyDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isClassStaticBlockDeclaration(node)
	);
}

function isTypeOnlyRuntimeNode(node) {
	if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return true;
	if (hasDeclareModifier(node)) return true;
	if (ts.isFunctionDeclaration(node) && !node.body) return true;
	if (ts.isImportDeclaration(node)) return isTypeOnlyImport(node);
	if (ts.isImportEqualsDeclaration(node)) return node.isTypeOnly;
	if (ts.isExportDeclaration(node)) return isTypeOnlyExport(node);
	return false;
}

function hasDeclareModifier(node) {
	return ts.canHaveModifiers(node)
		? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
		: false;
}

function isTypeOnlyImport(node) {
	const clause = node.importClause;
	if (!clause) return false;
	if (clause.isTypeOnly) return true;
	return (
		!clause.name &&
		clause.namedBindings !== undefined &&
		ts.isNamedImports(clause.namedBindings) &&
		clause.namedBindings.elements.length > 0 &&
		clause.namedBindings.elements.every((element) => element.isTypeOnly)
	);
}

function isTypeOnlyExport(node) {
	if (node.isTypeOnly) return true;
	return (
		node.exportClause !== undefined &&
		ts.isNamedExports(node.exportClause) &&
		node.exportClause.elements.length > 0 &&
		node.exportClause.elements.every((element) => element.isTypeOnly)
	);
}

function collectModuleLogicalLines(sourceFile) {
	const lines = new Set();
	function visit(node) {
		if (isTypeOnlyRuntimeNode(node)) return;
		if (isCountedStatement(node) || isCountedDeclaration(node)) lines.add(lineAtStart(node, sourceFile));
		ts.forEachChild(node, visit);
	}
	for (const statement of sourceFile.statements) visit(statement);
	return lines.size;
}

function collectTopLevelImperativeSpans(sourceFile) {
	return sourceFile.statements
		.filter((statement) => isTopLevelImperativeStatement(statement))
		.map((statement) => nodeSpan(statement, sourceFile));
}

function isTopLevelImperativeStatement(statement) {
	if (
		ts.isIfStatement(statement) ||
		ts.isSwitchStatement(statement) ||
		ts.isForStatement(statement) ||
		ts.isForInStatement(statement) ||
		ts.isForOfStatement(statement) ||
		ts.isWhileStatement(statement) ||
		ts.isDoStatement(statement) ||
		ts.isTryStatement(statement) ||
		ts.isThrowStatement(statement)
	) {
		return true;
	}
	if (ts.isExpressionStatement(statement)) return !ts.isStringLiteral(statement.expression);
	if (ts.isExportAssignment(statement)) return containsImperativeExpression(statement.expression);
	if (ts.isVariableStatement(statement)) {
		return statement.declarationList.declarations.some(
			(declaration) => declaration.initializer && containsImperativeExpression(declaration.initializer),
		);
	}
	if (ts.isClassDeclaration(statement)) return classHasImperativeInitialization(statement);
	return false;
}

function containsImperativeExpression(node) {
	if (isCallableWithBody(node)) return false;
	if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return classHasImperativeInitialization(node);
	if (
		ts.isCallExpression(node) ||
		ts.isNewExpression(node) ||
		ts.isAwaitExpression(node) ||
		ts.isTaggedTemplateExpression(node) ||
		ts.isDeleteExpression(node) ||
		(ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) ||
		((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
			(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken))
	) {
		return true;
	}
	let found = false;
	ts.forEachChild(node, (child) => {
		if (!found && containsImperativeExpression(child)) found = true;
	});
	return found;
}

function classHasImperativeInitialization(node) {
	if (nodeDecorators(node).length > 0) return true;
	return node.members.some((member) => {
		if (nodeDecorators(member).length > 0 || ts.isClassStaticBlockDeclaration(member)) return true;
		return (
			isStaticMember(member) &&
			ts.isPropertyDeclaration(member) &&
			member.initializer !== undefined &&
			containsImperativeExpression(member.initializer)
		);
	});
}

function scoreScope(metrics) {
	let penalty = 0;
	penalty += Math.max(0, metrics.cyclomaticComplexity - SOFT_LIMITS.cyclomaticComplexity) * 4;
	penalty += Math.max(0, metrics.maxNestingDepth - SOFT_LIMITS.maxNestingDepth) * 5;
	if (metrics.scopeKind !== "module") {
		penalty += Math.max(0, metrics.logicalLineCount - SOFT_LIMITS.logicalLineCount) * 1.5;
		penalty += Math.max(0, (metrics.localBindingCount ?? 0) - SOFT_LIMITS.localBindingCount);
	}
	if (metrics.scopeKind === "callable") {
		penalty += Math.max(0, (metrics.parameterCount ?? 0) - SOFT_LIMITS.parameterCount) * 3;
	}
	return Math.max(0, Math.round(100 - penalty));
}

function scoreFile(scopes, moduleLogicalLineCount, topLevelImperativeCount) {
	const scores = scopes.map((scope) => scope.qualityScore);
	const worst = scores.reduce((lowest, score) => Math.min(lowest, score), 100);
	const average = scores.reduce((total, score) => total + score, 0) / scores.length;
	const base = 0.7 * worst + 0.3 * average;
	const modulePenalty = Math.max(0, moduleLogicalLineCount - SOFT_LIMITS.moduleLogicalLineCount) * 0.1;
	const imperativePenalty =
		Math.min(topLevelImperativeCount, MAX_SCORED_TOP_LEVEL_IMPERATIVE_STATEMENTS) * TOP_LEVEL_IMPERATIVE_PENALTY;
	return Math.max(0, Math.round(base - modulePenalty - imperativePenalty));
}

function countHardLimitViolations(scopes) {
	return scopes.reduce((count, scope) => count + countScopeHardLimitViolations(scope), 0);
}

function countScopeHardLimitViolations(scope) {
	let count = 0;
	if (scope.cyclomaticComplexity > HARD_LIMITS.cyclomaticComplexity) count += 1;
	if (scope.maxNestingDepth > HARD_LIMITS.maxNestingDepth) count += 1;
	if (scope.scopeKind !== "module" && scope.logicalLineCount > HARD_LIMITS.logicalLineCount) count += 1;
	if (scope.scopeKind === "callable" && (scope.parameterCount ?? 0) > HARD_LIMITS.parameterCount) count += 1;
	return count;
}

export function rankFiles(metrics) {
	return [...metrics].sort((left, right) => {
		return (
			left.qualityScore - right.qualityScore ||
			right.hardLimitViolationCount - left.hardLimitViolationCount ||
			right.highestComplexity - left.highestComplexity ||
			right.deepestNesting - left.deepestNesting ||
			right.moduleLogicalLineCount - left.moduleLogicalLineCount ||
			compareText(left.path, right.path)
		);
	});
}

function rankScopes(scopes) {
	return [...scopes].sort((left, right) => {
		return (
			left.qualityScore - right.qualityScore ||
			right.cyclomaticComplexity - left.cyclomaticComplexity ||
			right.maxNestingDepth - left.maxNestingDepth ||
			right.logicalLineCount - left.logicalLineCount ||
			compareText(left.qualifiedName, right.qualifiedName) ||
			left.startLine - right.startLine
		);
	});
}

function isReportableHotspot(scope) {
	return scope.qualityScore <= 90 || countScopeHardLimitViolations(scope) > 0;
}

export function renderReport(metrics) {
	const scopes = rankScopes(metrics.scopes);
	const biggest = scopes[0];
	if (!biggest) throw new Error(`No executable scopes found for ${metrics.path}`);
	const counts = countScopeKinds(metrics.scopes);
	const lines = [
		`- ${markdownCodeSpan(metrics.path)}`,
		`  - Quality heuristic: ${metrics.qualityScore}/100`,
		`  - Module logical lines: ${metrics.moduleLogicalLineCount}`,
		`  - Executable scopes: ${metrics.scopes.length} (${counts.module} module, ${counts.staticBlock} ${plural(counts.staticBlock, "static block")}, ${counts.callable} ${plural(counts.callable, "callable")})`,
		`  - Hard-limit violations: ${metrics.hardLimitViolationCount}`,
	];
	if (metrics.topLevelImperativeSpans.length > 0) {
		lines.push(
			`  - Top-level imperative statements: ${metrics.topLevelImperativeSpans.length} at ${formatSpanList(metrics.topLevelImperativeSpans)}`,
		);
	}
	lines.push(`  - Biggest offender: ${markdownCodeSpan(biggest.qualifiedName)} at ${formatSpan(biggest)}`);
	lines.push(...renderExpandedScope(biggest));

	const hotspots = scopes.slice(1).filter(isReportableHotspot).slice(0, 4);
	if (hotspots.length > 0) {
		lines.push("  - Other hotspots:");
		for (const scope of hotspots) lines.push(`    - ${renderCompactScope(scope)}`);
	}
	return `${lines.join("\n")}\n`;
}

function renderExpandedScope(scope) {
	const lines = [
		`    - Scope: ${scope.scopeKind}`,
		...(scope.syntaxKind ? [`    - Kind: ${scope.syntaxKind}`, `    - Role: ${scope.role}`] : []),
		`    - Quality heuristic: ${scope.qualityScore}/100`,
		`    - Cyclomatic complexity: ${scope.cyclomaticComplexity}`,
		`    - Maximum nesting depth: ${scope.maxNestingDepth}`,
		`    - Logical lines: ${scope.logicalLineCount}`,
	];
	if (scope.parameterCount !== null) lines.push(`    - Parameters: ${scope.parameterCount}`);
	if (scope.localBindingCount !== null) lines.push(`    - Local bindings: ${scope.localBindingCount}`);
	return lines;
}

function renderCompactScope(scope) {
	const values = [
		`scope ${scope.scopeKind}`,
		...(scope.syntaxKind ? [`kind ${scope.syntaxKind}`, `role ${scope.role}`] : []),
		`quality ${scope.qualityScore}/100`,
		`complexity ${scope.cyclomaticComplexity}`,
		`nesting ${scope.maxNestingDepth}`,
		`logical lines ${scope.logicalLineCount}`,
	];
	if (scope.parameterCount !== null) values.push(`parameters ${scope.parameterCount}`);
	if (scope.localBindingCount !== null) values.push(`locals ${scope.localBindingCount}`);
	return `${markdownCodeSpan(scope.qualifiedName)} at ${formatSpan(scope)}: ${values.join(", ")}`;
}

function countScopeKinds(scopes) {
	return {
		module: scopes.filter((scope) => scope.scopeKind === "module").length,
		staticBlock: scopes.filter((scope) => scope.scopeKind === "static-block").length,
		callable: scopes.filter((scope) => scope.scopeKind === "callable").length,
	};
}

function plural(count, singular) {
	return count === 1 ? singular : `${singular}s`;
}

function formatSpan(span) {
	return span.startLine === span.endLine ? `L${span.startLine}` : `L${span.startLine}-L${span.endLine}`;
}

function formatSpanList(spans) {
	const visible = spans.slice(0, MAX_REPORTED_TOP_LEVEL_IMPERATIVE_SPANS).map(formatSpan);
	const remaining = spans.length - visible.length;
	return remaining > 0 ? `${visible.join(", ")}, and ${remaining} more` : visible.join(", ");
}

function markdownCodeSpan(value) {
	const safeValue = escapeControls(value);
	const runs = safeValue.match(/`+/g) ?? [];
	const fence = "`".repeat(Math.max(1, ...runs.map((run) => run.length + 1)));
	const needsPadding = safeValue.startsWith("`") || safeValue.endsWith("`") || /^\s|\s$/.test(safeValue);
	const content = needsPadding ? ` ${safeValue} ` : safeValue;
	return `${fence}${content}${fence}`;
}

function nodeSpan(node, sourceFile) {
	return { startLine: lineAtStart(node, sourceFile), endLine: lineAtEnd(node, sourceFile) };
}

function lineAtStart(node, sourceFile) {
	return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function lineAtEnd(node, sourceFile) {
	const position = Math.max(node.getStart(sourceFile), node.end - 1);
	return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function validateFileMetrics(metrics) {
	if (!Number.isInteger(metrics.qualityScore) || metrics.qualityScore < 0 || metrics.qualityScore > 100) {
		throw new Error(`Invalid file quality score for ${metrics.path}`);
	}
	if (metrics.scopes.filter((scope) => scope.scopeKind === "module").length !== 1) {
		throw new Error(`Expected one module scope for ${metrics.path}`);
	}
	for (const scope of metrics.scopes) {
		const values = [
			scope.startLine,
			scope.endLine,
			scope.cyclomaticComplexity,
			scope.maxNestingDepth,
			scope.logicalLineCount,
			scope.qualityScore,
			...(scope.parameterCount === null ? [] : [scope.parameterCount]),
			...(scope.localBindingCount === null ? [] : [scope.localBindingCount]),
		];
		if (values.some((value) => !Number.isInteger(value) || value < 0)) {
			throw new Error(`Invalid scope metrics for ${metrics.path}:${scope.qualifiedName}`);
		}
		if (scope.startLine < 1 || scope.endLine < scope.startLine || scope.cyclomaticComplexity < 1) {
			throw new Error(`Invalid scope span or complexity for ${metrics.path}:${scope.qualifiedName}`);
		}
		if (scope.qualityScore > 100) throw new Error(`Invalid scope quality for ${metrics.path}:${scope.qualifiedName}`);
		if (scope.scopeKind === "callable" && (!scope.syntaxKind || !scope.role || scope.parameterCount === null)) {
			throw new Error(`Incomplete callable metrics for ${metrics.path}:${scope.qualifiedName}`);
		}
		if (scope.scopeKind !== "callable" && (scope.syntaxKind !== null || scope.role !== null || scope.parameterCount !== null)) {
			throw new Error(`Invalid non-callable metrics for ${metrics.path}:${scope.qualifiedName}`);
		}
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
	return String(value).replace(/[\p{Cc}\u2028\u2029]/gu, (character) => {
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

async function isMainModule(invokedPath) {
	if (!invokedPath) return false;
	try {
		return (await realpath(path.resolve(invokedPath))) === (await realpath(fileURLToPath(import.meta.url)));
	} catch {
		return false;
	}
}

if (await isMainModule(process.argv[1])) {
	process.exitCode = await run(process.argv.slice(2));
}
