import type { SpecDocument } from "../domain.ts";

export function formatSpecDocument(document: SpecDocument): string[] {
	const lines: string[] = ["Problem", document.problemStatement, ""];
	appendList(lines, "Goals", document.goals);
	appendList(lines, "Non-goals", document.nonGoals);
	appendList(lines, "User-visible behavior", document.userVisibleBehavior);
	appendList(lines, "Constraints and decisions", document.constraintsAndDecisions);
	appendList(lines, "Acceptance criteria", document.acceptanceCriteria);
	appendList(lines, "Repository areas", document.repositoryAreas);
	appendList(lines, "Risks and unresolved items", document.risksAndUnresolvedItems);
	lines.push("Tasks");
	for (const [index, task] of document.tasks.entries()) {
		lines.push(`${index + 1}. [${task.kind === "user_qa" ? "USER QA" : "IMPLEMENT"}] ${task.title}`);
		lines.push(`   ${task.objective}`);
		if (task.dependencies.length > 0) {
			lines.push(`   Depends on: ${task.dependencies.join(", ")}`);
		}
	}
	return lines;
}

function appendList(lines: string[], heading: string, items: string[]): void {
	lines.push(heading);
	if (items.length === 0) {
		lines.push("- None");
	} else {
		lines.push(...items.map((item) => `- ${item}`));
	}
	lines.push("");
}
