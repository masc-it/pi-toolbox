import ts from "typescript";
import { HARD_LIMITS } from "./analyzer-contract.mjs";
import { collectExecutableScopeRoots } from "./scope-discovery.mjs";
import {
	isAssignmentOperator,
	isCallableWithBody,
	isCountedDeclaration,
	isCountedStatement,
	isStaticMember,
	isTypeOnlyRuntimeNode,
	lineAtStart,
	nodeDecorators,
	nodeSpan,
} from "./typescript-nodes.mjs";

const SOFT_LIMITS = Object.freeze({
	cyclomaticComplexity: 4,
	maxNestingDepth: 2,
	logicalLineCount: 20,
	parameterCount: 4,
	localBindingCount: 8,
	moduleLogicalLineCount: 250,
});
const TOP_LEVEL_IMPERATIVE_PENALTY = 0.25;
const MAX_SCORED_TOP_LEVEL_IMPERATIVE_STATEMENTS = 20;
const DECISION_OPERATORS = new Set([
	ts.SyntaxKind.AmpersandAmpersandToken,
	ts.SyntaxKind.BarBarToken,
	ts.SyntaxKind.QuestionQuestionToken,
	ts.SyntaxKind.AmpersandAmpersandEqualsToken,
	ts.SyntaxKind.BarBarEqualsToken,
	ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

export function analyzeSourceFile(relativePath, sourceFile) {
	const scopes = collectExecutableScopeRoots(sourceFile).map(({ root, descriptor }) =>
		analyzeScope(root, descriptor, sourceFile),
	);
	const topLevelImperativeSpans = collectTopLevelImperativeSpans(sourceFile);
	const moduleLogicalLineCount = collectModuleLogicalLines(sourceFile);
	const hardLimitViolationCount = countHardLimitViolations(scopes);
	const qualityScore = scoreFile(scopes, moduleLogicalLineCount, topLevelImperativeSpans.length);
	const aggregates = aggregateScopeMetrics(scopes);
	const metrics = {
		path: relativePath,
		moduleLogicalLineCount,
		topLevelImperativeSpans,
		scopes,
		qualityScore,
		hardLimitViolationCount,
		...aggregates,
	};
	validateFileMetrics(metrics);
	return metrics;
}

function aggregateScopeMetrics(scopes) {
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
	return { highestComplexity, deepestNesting, largestNonModuleScope };
}

function analyzeScope(root, descriptor, sourceFile) {
	const state = {
		cyclomaticComplexity: 1,
		maxNestingDepth: 0,
		nestingDepth: 0,
		logicalLines: new Set(),
		localBindings: new Set(),
	};
	const context = { root, sourceFile, state };
	visitScopeBody(root, sourceFile, context);

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

function visitScopeBody(root, sourceFile, context) {
	if (root === sourceFile) {
		for (const statement of sourceFile.statements) visitScopeNode(statement, context);
		return;
	}
	if (isCallableWithBody(root) && !ts.isBlock(root.body)) {
		context.state.logicalLines.add(lineAtStart(root.body, sourceFile));
		visitScopeNode(root.body, context);
		return;
	}
	for (const statement of root.body.statements) visitScopeNode(statement, context);
}

function visitScopeNode(node, context) {
	if (visitScopeBoundary(node, context)) return;
	if (isTypeOnlyRuntimeNode(node)) return;
	recordNodeMetrics(node, context);
	if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
		visitClassRuntimeExpressions(node, context);
		return;
	}
	if (visitControlFlowNode(node, context)) return;
	visitExpressionNode(node, context);
}

function visitScopeBoundary(node, context) {
	if (node === context.root) return false;
	if (isCallableWithBody(node)) {
		context.state.logicalLines.add(lineAtStart(node, context.sourceFile));
		if (ts.isFunctionDeclaration(node) && node.name) context.state.localBindings.add(node.name.text);
		return true;
	}
	return ts.isClassStaticBlockDeclaration(node);
}

function recordNodeMetrics(node, context) {
	if (isCountedStatement(node)) context.state.logicalLines.add(lineAtStart(node, context.sourceFile));
	if (ts.isVariableDeclaration(node)) collectBindingNames(node.name, context.state.localBindings);
	if (ts.isClassDeclaration(node) && node.name) context.state.localBindings.add(node.name.text);
}

function visitControlFlowNode(node, context) {
	if (ts.isIfStatement(node)) {
		visitIfStatement(node, context);
		return true;
	}
	if (ts.isForStatement(node)) {
		visitForStatement(node, context);
		return true;
	}
	if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
		visitForInOrOfStatement(node, context);
		return true;
	}
	if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
		visitWhileStatement(node, context);
		return true;
	}
	if (ts.isSwitchStatement(node)) {
		visitSwitchStatement(node, context);
		return true;
	}
	if (!ts.isTryStatement(node)) return false;
	visitTryStatement(node, context);
	return true;
}

function visitIfStatement(node, context) {
	context.state.cyclomaticComplexity += 1;
	visitScopeNode(node.expression, context);
	visitNested(node.thenStatement, context);
	if (!node.elseStatement) return;
	if (ts.isIfStatement(node.elseStatement)) visitScopeNode(node.elseStatement, context);
	else visitNested(node.elseStatement, context);
}

function visitForStatement(node, context) {
	context.state.cyclomaticComplexity += 1;
	if (node.initializer) visitScopeNode(node.initializer, context);
	if (node.condition) visitScopeNode(node.condition, context);
	if (node.incrementor) visitScopeNode(node.incrementor, context);
	visitNested(node.statement, context);
}

function visitForInOrOfStatement(node, context) {
	context.state.cyclomaticComplexity += 1;
	visitScopeNode(node.initializer, context);
	visitScopeNode(node.expression, context);
	visitNested(node.statement, context);
}

function visitWhileStatement(node, context) {
	context.state.cyclomaticComplexity += 1;
	visitScopeNode(node.expression, context);
	visitNested(node.statement, context);
}

function visitSwitchStatement(node, context) {
	context.state.cyclomaticComplexity += node.caseBlock.clauses.filter(ts.isCaseClause).length;
	visitScopeNode(node.expression, context);
	withNesting(context.state, () => {
		for (const clause of node.caseBlock.clauses) visitSwitchClause(clause, context);
	});
}

function visitSwitchClause(clause, context) {
	if (ts.isCaseClause(clause)) visitScopeNode(clause.expression, context);
	for (const statement of clause.statements) visitScopeNode(statement, context);
}

function visitTryStatement(node, context) {
	visitNested(node.tryBlock, context);
	if (node.catchClause) visitCatchClause(node.catchClause, context);
	if (node.finallyBlock) visitNested(node.finallyBlock, context);
}

function visitCatchClause(catchClause, context) {
	context.state.cyclomaticComplexity += 1;
	if (catchClause.variableDeclaration) {
		collectBindingNames(catchClause.variableDeclaration.name, context.state.localBindings);
	}
	visitNested(catchClause.block, context);
}

function visitExpressionNode(node, context) {
	if (ts.isConditionalExpression(node)) {
		context.state.cyclomaticComplexity += 1;
		visitChildren(node, context);
		return;
	}
	if (ts.isBinaryExpression(node) && DECISION_OPERATORS.has(node.operatorToken.kind)) {
		context.state.cyclomaticComplexity += 1;
	}
	visitChildren(node, context);
}

function visitChildren(node, context) {
	ts.forEachChild(node, (child) => visitScopeNode(child, context));
}

function visitNested(node, context) {
	withNesting(context.state, () => visitScopeNode(node, context));
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

function visitClassRuntimeExpressions(node, context) {
	for (const decorator of nodeDecorators(node)) visitScopeNode(decorator.expression, context);
	for (const clause of node.heritageClauses ?? []) visitHeritageRuntimeExpressions(clause, context);
	for (const member of node.members) visitClassMemberRuntimeExpressions(member, context);
}

function visitHeritageRuntimeExpressions(clause, context) {
	for (const type of clause.types) visitScopeNode(type.expression, context);
}

function visitClassMemberRuntimeExpressions(member, context) {
	for (const decorator of nodeDecorators(member)) visitScopeNode(decorator.expression, context);
	if (member.name && ts.isComputedPropertyName(member.name)) {
		visitScopeNode(member.name.expression, context);
	}
	if (isStaticMember(member) && ts.isPropertyDeclaration(member) && member.initializer) {
		visitScopeNode(member.initializer, context);
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
	if (isImperativeControlFlowStatement(statement)) return true;
	if (ts.isExpressionStatement(statement)) return !ts.isStringLiteral(statement.expression);
	if (ts.isExportAssignment(statement)) return containsImperativeExpression(statement.expression);
	if (ts.isVariableStatement(statement)) return variableStatementHasImperativeInitializer(statement);
	if (ts.isClassDeclaration(statement)) return classHasImperativeInitialization(statement);
	return false;
}

function isImperativeControlFlowStatement(statement) {
	return (
		ts.isIfStatement(statement) ||
		ts.isSwitchStatement(statement) ||
		ts.isForStatement(statement) ||
		ts.isForInStatement(statement) ||
		ts.isForOfStatement(statement) ||
		ts.isWhileStatement(statement) ||
		ts.isDoStatement(statement) ||
		ts.isTryStatement(statement) ||
		ts.isThrowStatement(statement)
	);
}

function variableStatementHasImperativeInitializer(statement) {
	return statement.declarationList.declarations.some(
		(declaration) => declaration.initializer && containsImperativeExpression(declaration.initializer),
	);
}

function containsImperativeExpression(node) {
	if (isCallableWithBody(node)) return false;
	if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return classHasImperativeInitialization(node);
	if (isDirectImperativeExpression(node)) return true;
	return childContainsImperativeExpression(node);
}

function isDirectImperativeExpression(node) {
	if (isDirectEffectExpression(node)) return true;
	if (ts.isBinaryExpression(node)) return isAssignmentOperator(node.operatorToken.kind);
	return isUpdateExpression(node);
}

function isDirectEffectExpression(node) {
	return (
		ts.isCallExpression(node) ||
		ts.isNewExpression(node) ||
		ts.isAwaitExpression(node) ||
		ts.isTaggedTemplateExpression(node) ||
		ts.isDeleteExpression(node)
	);
}

function isUpdateExpression(node) {
	if (!ts.isPrefixUnaryExpression(node) && !ts.isPostfixUnaryExpression(node)) return false;
	return node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken;
}

function childContainsImperativeExpression(node) {
	let found = false;
	ts.forEachChild(node, (child) => {
		if (!found && containsImperativeExpression(child)) found = true;
	});
	return found;
}

function classHasImperativeInitialization(node) {
	if (nodeDecorators(node).length > 0) return true;
	return node.members.some((member) => classMemberHasImperativeInitialization(member));
}

function classMemberHasImperativeInitialization(member) {
	if (nodeDecorators(member).length > 0 || ts.isClassStaticBlockDeclaration(member)) return true;
	return (
		isStaticMember(member) &&
		ts.isPropertyDeclaration(member) &&
		member.initializer !== undefined &&
		containsImperativeExpression(member.initializer)
	);
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

function validateFileMetrics(metrics) {
	validateFileSummary(metrics);
	for (const scope of metrics.scopes) validateScopeMetrics(metrics.path, scope);
}

function validateFileSummary(metrics) {
	if (!Number.isInteger(metrics.qualityScore) || metrics.qualityScore < 0 || metrics.qualityScore > 100) {
		throw new Error(`Invalid file quality score for ${metrics.path}`);
	}
	if (metrics.scopes.filter((scope) => scope.scopeKind === "module").length !== 1) {
		throw new Error(`Expected one module scope for ${metrics.path}`);
	}
}

function validateScopeMetrics(filePath, scope) {
	if (scopeHasInvalidIntegerMetric(scope)) {
		throw new Error(`Invalid scope metrics for ${filePath}:${scope.qualifiedName}`);
	}
	if (scope.startLine < 1 || scope.endLine < scope.startLine || scope.cyclomaticComplexity < 1) {
		throw new Error(`Invalid scope span or complexity for ${filePath}:${scope.qualifiedName}`);
	}
	if (scope.qualityScore > 100) throw new Error(`Invalid scope quality for ${filePath}:${scope.qualifiedName}`);
	validateScopeDescriptor(filePath, scope);
}

function scopeHasInvalidIntegerMetric(scope) {
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
	return values.some((value) => !Number.isInteger(value) || value < 0);
}

function validateScopeDescriptor(filePath, scope) {
	if (scope.scopeKind === "callable") {
		if (!scope.syntaxKind || !scope.role || scope.parameterCount === null) {
			throw new Error(`Incomplete callable metrics for ${filePath}:${scope.qualifiedName}`);
		}
		return;
	}
	if (scope.syntaxKind !== null || scope.role !== null || scope.parameterCount !== null) {
		throw new Error(`Invalid non-callable metrics for ${filePath}:${scope.qualifiedName}`);
	}
}
