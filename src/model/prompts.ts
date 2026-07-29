import type { FeatureSpecDetail, SpecDocument } from "../domain.ts";

export const PROMPT_POLISH_SYSTEM_PROMPT = `You polish developer prompts for an agentic coding assistant.

Preserve the user's intent, scope, constraints, examples, and requested outcome. Improve precision, terminology, structure, and actionable direction. Make implicit references explicit only when the source text supports them. Surface ambiguity through precise wording without resolving it by inventing requirements.

Return only the polished prompt. Do not add commentary, analysis, headings about the polishing process, or Markdown fences around the complete response.`;

export const FEATURE_INTERVIEW_SYSTEM_PROMPT = `You conduct a concise requirements interview for a software feature.

Ask exactly one highest-value question at a time. Ask only about material product behavior, scope, trade-offs, compatibility, UX, failure behavior, or acceptance expectations. Never ask for repository information present in the supplied repository context. Provide two to five short choices for bounded decisions and an empty choices array for open-ended questions. The UI always permits a custom answer.

For every question, estimate the total number of questions the interview will need after considering all recorded answers. Keep the estimate between the current question number and ten. Revise it as requirements become clearer.

Set readyForReview to true only after at least one answer and when no material ambiguity remains. Return strict JSON only:
{"readyForReview":false,"question":{"prompt":"...","choices":["..."],"estimatedQuestionCount":8}}
or
{"readyForReview":true}`;

export const FEATURE_REVIEW_SYSTEM_PROMPT = `You produce an implementation-ready feature specification from a requirements interview and repository context.

Keep scope aligned with the brief and answers. Use repository facts directly. Produce ordered, cohesive implementation tasks with explicit acceptance criteria and dependencies on earlier task keys. Insert user_qa tasks after meaningful vertical slices. User QA is the only acceptance mechanism: never create unit, integration, snapshot, mock-based, or other automated code-test tasks.

Return strict JSON only with this shape:
{
  "problemStatement":"...",
  "goals":["..."],
  "nonGoals":["..."],
  "userVisibleBehavior":["..."],
  "constraintsAndDecisions":["..."],
  "acceptanceCriteria":["..."],
  "repositoryAreas":["..."],
  "risksAndUnresolvedItems":["..."],
  "tasks":[
    {
      "key":"task-1",
      "kind":"implementation",
      "title":"...",
      "objective":"...",
      "context":"...",
      "acceptanceCriteria":["..."],
      "dependencies":[]
    },
    {
      "key":"qa-1",
      "kind":"user_qa",
      "title":"...",
      "objective":"...",
      "context":"...",
      "acceptanceCriteria":["..."],
      "dependencies":["task-1"],
      "qa":{
        "checkpointRationale":"...",
        "setupInstructions":["..."],
        "scenarios":["..."],
        "expectedResults":["..."],
        "stressAreas":["..."],
        "failureReportGuidance":"..."
      }
    }
  ]
}`;

export function buildInterviewPrompt(detail: FeatureSpecDetail, repositoryContext: string): string {
	const answers = detail.questions
		.filter((question) => question.answer)
		.map((question) => `Q${question.sequence}: ${question.prompt}\nA: ${question.answer}`)
		.join("\n\n");
	return `Feature title: ${detail.feature.title}\n\nFeature brief:\n${detail.feature.brief}\n\nRecorded interview:\n${answers || "No answers recorded."}\n\nRepository context:\n${repositoryContext}`;
}

export function buildReviewPrompt(detail: FeatureSpecDetail, repositoryContext: string): string {
	const interview = detail.questions
		.map((question) => `Q${question.sequence}: ${question.prompt}\nA: ${question.answer ?? "Unanswered"}`)
		.join("\n\n");
	return `Feature title: ${detail.feature.title}\n\nFeature brief:\n${detail.feature.brief}\n\nRequirements interview:\n${interview}\n\nRepository context:\n${repositoryContext}`;
}

export function buildRefinementPrompt(
	detail: FeatureSpecDetail,
	document: SpecDocument,
	instructions: string,
	repositoryContext: string,
): string {
	return `${buildReviewPrompt(detail, repositoryContext)}\n\nCurrent specification:\n${JSON.stringify(document, null, 2)}\n\nRequired refinement:\n${instructions}`;
}
