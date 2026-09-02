import ts from "typescript";
import {
	callableSyntaxKind,
	countParameters,
	inferAssignedExpressionName,
	inferCallableIdentity,
	inferClassName,
	isCallableWithBody,
	joinQualifiedName,
	lineAtEnd,
	lineAtStart,
	nodeDecorators,
	nodeSpan,
	propertyNameText,
} from "./typescript-nodes.mjs";

export function collectExecutableScopeRoots(sourceFile) {
	const records = [{ root: sourceFile, descriptor: createModuleDescriptor(sourceFile) }];
	const context = { containers: [], sourceFile, records };
	for (const statement of sourceFile.statements) collectNestedScopes(statement, context);
	return records;
}

function createModuleDescriptor(sourceFile) {
	return {
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
}

function collectNestedScopes(node, context) {
	if (isCallableWithBody(node)) {
		collectCallableScope(node, context);
		return;
	}
	if (ts.isClassStaticBlockDeclaration(node)) {
		collectStaticBlockScope(node, context);
		return;
	}
	if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
		collectClassScopes(node, context);
		return;
	}
	if (ts.isModuleDeclaration(node)) {
		collectModuleScopes(node, context);
		return;
	}
	if (ts.isObjectLiteralExpression(node)) {
		collectObjectLiteralScopes(node, context);
		return;
	}
	collectChildScopes(node, context);
}

function collectCallableScope(node, context) {
	const identity = inferCallableIdentity(node, context.sourceFile);
	const descriptor = {
		scopeKind: "callable",
		syntaxKind: callableSyntaxKind(node),
		role: identity.role,
		name: identity.name,
		qualifiedName: joinQualifiedName(context.containers, identity.name),
		...nodeSpan(node, context.sourceFile),
		parameterCount: countParameters(node),
		localBindingCount: 0,
	};
	context.records.push({ root: node, descriptor });
	collectCallableChildren(node, childContext(context, identity.name));
}

function collectCallableChildren(node, context) {
	for (const decorator of nodeDecorators(node)) collectNestedScopes(decorator.expression, context);
	for (const parameter of node.parameters) collectParameterScopes(parameter, context);
	collectNestedScopes(node.body, context);
}

function collectParameterScopes(parameter, context) {
	for (const decorator of nodeDecorators(parameter)) collectNestedScopes(decorator.expression, context);
	if (parameter.initializer) collectNestedScopes(parameter.initializer, context);
}

function collectStaticBlockScope(node, context) {
	const startLine = lineAtStart(node, context.sourceFile);
	const name = `<static@L${startLine}>`;
	const descriptor = {
		scopeKind: "static-block",
		syntaxKind: null,
		role: null,
		name,
		qualifiedName: joinQualifiedName(context.containers, name),
		...nodeSpan(node, context.sourceFile),
		parameterCount: null,
		localBindingCount: 0,
	};
	context.records.push({ root: node, descriptor });
	collectNestedScopes(node.body, childContext(context, name));
}

function collectClassScopes(node, context) {
	const className = inferClassName(node, context.sourceFile);
	const nestedContext = childContext(context, className);
	for (const decorator of nodeDecorators(node)) collectNestedScopes(decorator.expression, nestedContext);
	for (const clause of node.heritageClauses ?? []) collectHeritageScopes(clause, nestedContext);
	for (const member of node.members) collectClassMemberScopes(member, nestedContext);
}

function collectHeritageScopes(clause, context) {
	for (const type of clause.types) collectNestedScopes(type.expression, context);
}

function collectClassMemberScopes(member, context) {
	for (const decorator of nodeDecorators(member)) collectNestedScopes(decorator.expression, context);
	if (member.name && ts.isComputedPropertyName(member.name)) {
		collectNestedScopes(member.name.expression, context);
	}
	if (ts.isClassStaticBlockDeclaration(member) || isCallableWithBody(member)) {
		collectNestedScopes(member, context);
		return;
	}
	if (ts.isPropertyDeclaration(member) && member.initializer) {
		collectNestedScopes(member.initializer, context);
	}
}

function collectModuleScopes(node, context) {
	if (!node.body) return;
	const namespaceName = propertyNameText(node.name, context.sourceFile);
	collectNestedScopes(node.body, childContext(context, namespaceName));
}

function collectObjectLiteralScopes(node, context) {
	const objectName = inferAssignedExpressionName(node, context.sourceFile);
	const nestedContext = objectName ? childContext(context, objectName) : context;
	collectChildScopes(node, nestedContext);
}

function collectChildScopes(node, context) {
	ts.forEachChild(node, (child) => collectNestedScopes(child, context));
}

function childContext(context, name) {
	return { ...context, containers: [...context.containers, name] };
}
