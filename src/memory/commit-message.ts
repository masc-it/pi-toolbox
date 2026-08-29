const MAX_COMMIT_MESSAGE_LENGTH = 72;
const COMMIT_MESSAGE_PREFIX = /^memory(?:\([a-z0-9]+(?:-[a-z0-9]+)*\))?: [a-z]/;

export function validateMemoryCommitMessage(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error("Memory commit message must be a non-empty string");
	}
	if (value !== value.trim() || /[\r\n\u0000-\u001f\u007f]/.test(value)) {
		throw new Error("Memory commit message must be one trimmed line");
	}
	if (value.length > MAX_COMMIT_MESSAGE_LENGTH) {
		throw new Error(`Memory commit message must not exceed ${MAX_COMMIT_MESSAGE_LENGTH} characters`);
	}
	if (!COMMIT_MESSAGE_PREFIX.test(value)) {
		throw new Error("Memory commit message must use 'memory(<scope>): <summary>' or 'memory: <summary>'");
	}
	if (value.endsWith(".")) {
		throw new Error("Memory commit message must not end with a period");
	}
	return value;
}
