import ts from "typescript";

export function countParameters(node) {
	return node.parameters.filter(
		(parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === "this"),
	).length;
}

export function isCallableWithBody(node) {
	return isCallableNode(node) && node.body !== undefined;
}

function isCallableNode(node) {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

export function callableSyntaxKind(node) {
	if (ts.isArrowFunction(node)) return "arrow";
	if (ts.isMethodDeclaration(node)) return "method";
	if (ts.isConstructorDeclaration(node)) return "constructor";
	if (ts.isGetAccessorDeclaration(node)) return "getter";
	if (ts.isSetAccessorDeclaration(node)) return "setter";
	return "function";
}

export function inferCallableIdentity(node, sourceFile) {
	return inferDeclaredCallableIdentity(node, sourceFile) ?? inferExpressionCallableIdentity(node, sourceFile);
}

function inferDeclaredCallableIdentity(node, sourceFile) {
	if (ts.isFunctionDeclaration(node)) {
		const name =
			node.name?.text ??
			(hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? "default" : anonymousName("anonymous", node, sourceFile));
		return { name, role: "declaration" };
	}
	if (!isClassCallableDeclaration(node)) return null;
	const name = ts.isConstructorDeclaration(node) ? "constructor" : propertyNameText(node.name, sourceFile);
	return { name, role: "declaration" };
}

function isClassCallableDeclaration(node) {
	return (
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

function inferExpressionCallableIdentity(node, sourceFile) {
	const context = expressionContext(node);
	const assignedName = assignedNameFromContext(context.expression, context.parent, sourceFile);
	if (assignedName) return { name: assignedName, role: "assigned" };
	return inferInvocationIdentity(node, context, sourceFile) ?? {
		name: node.name?.text ?? anonymousName("anonymous", node, sourceFile),
		role: "anonymous",
	};
}

function inferInvocationIdentity(node, context, sourceFile) {
	if (!context.parent || !isInvocation(context.parent)) return null;
	if (context.parent.expression === context.expression) {
		return {
			name: node.name?.text ?? anonymousName("anonymous", node, sourceFile),
			role: "immediate",
		};
	}
	if (!context.parent.arguments?.includes(context.expression)) return null;
	return {
		name: node.name?.text ?? anonymousName("callback", node, sourceFile),
		role: "callback",
	};
}

function isInvocation(node) {
	return ts.isCallExpression(node) || ts.isNewExpression(node);
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
	if (ts.isJsxExpression(parent)) return parent.expression === child;
	return isTransparentWrapper(parent) && parent.expression === child;
}

function isTransparentWrapper(node) {
	return (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isTypeAssertionExpression(node) ||
		ts.isNonNullExpression(node) ||
		ts.isSatisfiesExpression(node)
	);
}

function assignedNameFromContext(expression, parent, sourceFile) {
	if (!parent) return null;
	if (ts.isVariableDeclaration(parent) && parent.initializer === expression) {
		return bindingNameText(parent.name, sourceFile);
	}
	if (isInitializedNamedNode(parent, expression)) return propertyNameText(parent.name, sourceFile);
	if (isAssignmentToExpression(parent, expression)) return safeExpressionName(parent.left, sourceFile);
	if (ts.isExportAssignment(parent) && parent.expression === expression) return "default";
	return null;
}

function isInitializedNamedNode(parent, expression) {
	if (parent.initializer !== expression) return false;
	return ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isJsxAttribute(parent);
}

function isAssignmentToExpression(parent, expression) {
	return (
		ts.isBinaryExpression(parent) &&
		parent.right === expression &&
		isAssignmentOperator(parent.operatorToken.kind)
	);
}

export function inferAssignedExpressionName(node, sourceFile) {
	const context = expressionContext(node);
	return assignedNameFromContext(context.expression, context.parent, sourceFile);
}

export function inferClassName(node, sourceFile) {
	if (node.name) return node.name.text;
	if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) return "default";
	return inferAssignedExpressionName(node, sourceFile) ?? anonymousName("anonymous-class", node, sourceFile);
}

function bindingNameText(name, sourceFile) {
	return ts.isIdentifier(name) ? name.text : `<computed@L${lineAtStart(name, sourceFile)}>`;
}

export function propertyNameText(name, sourceFile) {
	if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
	if (ts.isStringLiteral(name)) return JSON.stringify(name.text);
	if (ts.isNumericLiteral(name)) return name.text;
	return `<computed@L${lineAtStart(name, sourceFile)}>`;
}

function safeExpressionName(node, sourceFile) {
	if (ts.isIdentifier(node)) return node.text;
	if (node.kind === ts.SyntaxKind.ThisKeyword) return "this";
	if (node.kind === ts.SyntaxKind.SuperKeyword) return "super";
	if (ts.isPropertyAccessExpression(node)) return propertyAccessName(node, sourceFile);
	if (ts.isElementAccessExpression(node)) return elementAccessName(node, sourceFile);
	return `<computed@L${lineAtStart(node, sourceFile)}>`;
}

function propertyAccessName(node, sourceFile) {
	const left = safeExpressionName(node.expression, sourceFile);
	return left ? `${left}.${propertyNameText(node.name, sourceFile)}` : null;
}

function elementAccessName(node, sourceFile) {
	if (!node.argumentExpression) return `<computed@L${lineAtStart(node, sourceFile)}>`;
	const left = safeExpressionName(node.expression, sourceFile);
	if (!left) return null;
	if (!ts.isStringLiteral(node.argumentExpression) && !ts.isNumericLiteral(node.argumentExpression)) {
		return `<computed@L${lineAtStart(node, sourceFile)}>`;
	}
	return `${left}[${JSON.stringify(node.argumentExpression.text)}]`;
}

function anonymousName(label, node, sourceFile) {
	return `<${label}@L${lineAtStart(node, sourceFile)}>`;
}

export function joinQualifiedName(containers, name) {
	return [...containers, name].join(".");
}

export function nodeDecorators(node) {
	return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

export function isStaticMember(node) {
	return hasModifier(node, ts.SyntaxKind.StaticKeyword);
}

export function hasModifier(node, kind) {
	return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

export function isAssignmentOperator(kind) {
	return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

export function isCountedStatement(node) {
	return ts.isStatement(node) && !ts.isBlock(node) && !ts.isEmptyStatement(node) && !isTypeOnlyRuntimeNode(node);
}

export function isCountedDeclaration(node) {
	return (
		ts.isPropertyDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isClassStaticBlockDeclaration(node)
	);
}

export function isTypeOnlyRuntimeNode(node) {
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

export function nodeSpan(node, sourceFile) {
	return { startLine: lineAtStart(node, sourceFile), endLine: lineAtEnd(node, sourceFile) };
}

export function lineAtStart(node, sourceFile) {
	return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function lineAtEnd(node, sourceFile) {
	const position = Math.max(node.getStart(sourceFile), node.end - 1);
	return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}
