import type { PlannedTask, QaTaskDetails, SpecDocument } from "../domain.ts";

export interface InterviewDecision {
	readyForReview: boolean;
	question?: {
		prompt: string;
		choices: string[];
		estimatedQuestionCount: number;
	};
}

export function parseInterviewDecision(text: string): InterviewDecision {
	const value = parseJsonObject(text);
	if (typeof value.readyForReview !== "boolean") {
		throw new Error("Interview response requires readyForReview");
	}
	if (value.readyForReview) {
		return { readyForReview: true };
	}
	if (!isRecord(value.question)) {
		throw new Error("Interview response requires a question");
	}
	const prompt = requireString(value.question.prompt, "question.prompt");
	const choices = requireStringArray(value.question.choices, "question.choices", true);
	const estimatedQuestionCount = value.question.estimatedQuestionCount;
	if (!Number.isInteger(estimatedQuestionCount) || (estimatedQuestionCount as number) < 1 || (estimatedQuestionCount as number) > 10) {
		throw new Error("question.estimatedQuestionCount must be an integer between 1 and 10");
	}
	return {
		readyForReview: false,
		question: { prompt, choices, estimatedQuestionCount: estimatedQuestionCount as number },
	};
}

export function parseSpecDocument(text: string): SpecDocument {
	return parseSpecDocumentValue(parseJsonObject(text));
}

export function parseSpecDocumentValue(value: unknown): SpecDocument {
	if (!isRecord(value)) {
		throw new Error("Specification must be a JSON object");
	}
	const tasksValue = value.tasks;
	if (!Array.isArray(tasksValue) || tasksValue.length === 0) {
		throw new Error("Specification requires at least one task");
	}
	const tasks = tasksValue.map((task, index) => parseTask(task, index));
	validateTaskDependencies(tasks);
	if (!tasks.some((task) => task.kind === "implementation")) {
		throw new Error("Specification requires implementation work");
	}
	if (!tasks.some((task) => task.kind === "user_qa")) {
		throw new Error("Specification requires at least one user QA checkpoint");
	}

	return {
		problemStatement: requireString(value.problemStatement, "problemStatement"),
		goals: requireStringArray(value.goals, "goals"),
		nonGoals: requireStringArray(value.nonGoals, "nonGoals", true),
		userVisibleBehavior: requireStringArray(value.userVisibleBehavior, "userVisibleBehavior"),
		constraintsAndDecisions: requireStringArray(value.constraintsAndDecisions, "constraintsAndDecisions", true),
		acceptanceCriteria: requireStringArray(value.acceptanceCriteria, "acceptanceCriteria"),
		repositoryAreas: requireStringArray(value.repositoryAreas, "repositoryAreas", true),
		risksAndUnresolvedItems: requireStringArray(value.risksAndUnresolvedItems, "risksAndUnresolvedItems", true),
		tasks,
	};
}

function parseTask(value: unknown, index: number): PlannedTask {
	if (!isRecord(value)) {
		throw new Error(`tasks[${index}] must be an object`);
	}
	const kind: PlannedTask["kind"] | undefined =
		value.kind === "implementation" || value.kind === "user_qa" ? value.kind : undefined;
	if (!kind) {
		throw new Error(`tasks[${index}].kind is invalid`);
	}
	const base = {
		key: requireString(value.key, `tasks[${index}].key`),
		kind,
		title: requireString(value.title, `tasks[${index}].title`),
		objective: requireString(value.objective, `tasks[${index}].objective`),
		context: requireString(value.context, `tasks[${index}].context`),
		acceptanceCriteria: requireStringArray(value.acceptanceCriteria, `tasks[${index}].acceptanceCriteria`),
		dependencies: requireStringArray(value.dependencies, `tasks[${index}].dependencies`, true),
	};
	if (kind === "implementation") {
		return base;
	}
	return { ...base, qa: parseQaDetails(value.qa, index) };
}

function parseQaDetails(value: unknown, taskIndex: number): QaTaskDetails {
	if (!isRecord(value)) {
		throw new Error(`tasks[${taskIndex}].qa must be an object`);
	}
	return {
		checkpointRationale: requireString(value.checkpointRationale, `tasks[${taskIndex}].qa.checkpointRationale`),
		setupInstructions: requireStringArray(value.setupInstructions, `tasks[${taskIndex}].qa.setupInstructions`),
		scenarios: requireStringArray(value.scenarios, `tasks[${taskIndex}].qa.scenarios`),
		expectedResults: requireStringArray(value.expectedResults, `tasks[${taskIndex}].qa.expectedResults`),
		stressAreas: requireStringArray(value.stressAreas, `tasks[${taskIndex}].qa.stressAreas`),
		failureReportGuidance: requireString(
			value.failureReportGuidance,
			`tasks[${taskIndex}].qa.failureReportGuidance`,
		),
	};
}

function validateTaskDependencies(tasks: PlannedTask[]): void {
	const positions = new Map<string, number>();
	for (const [index, task] of tasks.entries()) {
		if (positions.has(task.key)) {
			throw new Error(`Duplicate task key: ${task.key}`);
		}
		positions.set(task.key, index);
	}
	for (const [index, task] of tasks.entries()) {
		for (const dependency of task.dependencies) {
			const position = positions.get(dependency);
			if (position === undefined) {
				throw new Error(`Task ${task.key} depends on unknown task ${dependency}`);
			}
			if (position >= index) {
				throw new Error(`Task ${task.key} must depend only on earlier tasks`);
			}
		}
	}
}

function parseJsonObject(text: string): Record<string, unknown> {
	const normalized = removeMarkdownFence(text.trim());
	let value: unknown;
	try {
		value = JSON.parse(normalized);
	} catch (error) {
		throw new Error("Model returned invalid JSON", { cause: error });
	}
	if (!isRecord(value)) {
		throw new Error("Model response must be a JSON object");
	}
	return value;
}

function removeMarkdownFence(text: string): string {
	const match = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
	return match?.[1]?.trim() ?? text;
}

function requireString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${path} must be a non-empty string`);
	}
	return value.trim();
}

function requireStringArray(value: unknown, path: string, allowEmpty = false): string[] {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
		throw new Error(`${path} must be ${allowEmpty ? "an" : "a non-empty"} array`);
	}
	return value.map((entry, index) => requireString(entry, `${path}[${index}]`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
