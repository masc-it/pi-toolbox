import { HARD_LIMITS, compareText, escapeControls } from "./analyzer-contract.mjs";

const MAX_REPORTED_TOP_LEVEL_IMPERATIVE_SPANS = 10;

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

function countScopeHardLimitViolations(scope) {
	let count = 0;
	if (scope.cyclomaticComplexity > HARD_LIMITS.cyclomaticComplexity) count += 1;
	if (scope.maxNestingDepth > HARD_LIMITS.maxNestingDepth) count += 1;
	if (scope.scopeKind !== "module" && scope.logicalLineCount > HARD_LIMITS.logicalLineCount) count += 1;
	if (scope.scopeKind === "callable" && (scope.parameterCount ?? 0) > HARD_LIMITS.parameterCount) count += 1;
	return count;
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
