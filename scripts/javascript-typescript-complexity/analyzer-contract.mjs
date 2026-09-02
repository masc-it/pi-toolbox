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

export const HARD_LIMITS = Object.freeze({
	cyclomaticComplexity: 10,
	maxNestingDepth: 4,
	logicalLineCount: 40,
	parameterCount: 6,
});

export class AnalyzerError extends Error {
	constructor(message, exitCode) {
		super(message);
		this.name = new.target.name;
		this.exitCode = exitCode;
	}
}

export class BoundaryError extends AnalyzerError {
	constructor(message) {
		super(message, EXIT_BOUNDARY);
	}
}

export class NoFilesError extends AnalyzerError {
	constructor(message) {
		super(message, EXIT_NO_FILES);
	}
}

export class AnalysisError extends AnalyzerError {
	constructor(relativePath, message) {
		super(`${displayValue(relativePath)}: ${message}`, EXIT_ANALYSIS);
	}
}

export class ResourceLimitError extends AnalyzerError {
	constructor(message) {
		super(message, EXIT_RESOURCE);
	}
}

export function validateLimits(limits) {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid analyzer limit ${name}`);
	}
}

export function displayValue(value) {
	return JSON.stringify(String(value));
}

export function escapeControls(value) {
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

export function errorMessage(error) {
	return escapeControls(error instanceof Error ? error.message : String(error));
}

export function isNodeError(error, code) {
	return error instanceof Error && "code" in error && error.code === code;
}

export function compareText(left, right) {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
