import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
	FeatureSpec,
	FeatureSpecDetail,
	ImplementationCandidate,
	ImplementationStatus,
	PlannedTask,
	Project,
	ProjectCheckout,
	ProjectContext,
	SpecDocument,
	SpecQuestion,
	SpecRevision,
	SpecStage,
	WorkflowModelProfile,
} from "../domain.ts";
import type { ResolvedGitProject } from "../project/git-identity.ts";

export interface CreateDraftInput {
	projectId: string;
	title: string;
	brief: string;
	modelProfile: WorkflowModelProfile;
}

export interface SaveQuestionInput {
	featureSpecId: string;
	prompt: string;
	choices: string[];
	estimatedQuestionCount: number;
}

export interface SaveReviewInput {
	featureSpecId: string;
	document: SpecDocument;
}

export interface FeatureSpecRepository {
	createDraft(input: CreateDraftInput): Promise<FeatureSpec>;
	updateModelProfile(featureSpecId: string, profile: WorkflowModelProfile): Promise<void>;
	saveQuestion(input: SaveQuestionInput): Promise<SpecQuestion>;
	saveAnswer(questionId: string, answer: string): Promise<void>;
	saveReview(input: SaveReviewInput): Promise<SpecRevision>;
	approve(featureSpecId: string, revisionId: string): Promise<FeatureSpec>;
	getById(id: string): Promise<FeatureSpecDetail | undefined>;
	listForProject(projectId: string): Promise<FeatureSpec[]>;
}

export interface ImplementationRepository {
	listCandidates(projectId: string): Promise<ImplementationCandidate[]>;
}

export class SqliteProjectRepository {
	constructor(private readonly database: Database.Database) {}

	async resolve(identity: ResolvedGitProject): Promise<ProjectContext> {
		return this.database.transaction(() => {
			const now = new Date().toISOString();
			let project = this.findByRepositoryKeySync(identity.repositoryKey);
			if (!project) {
				project = {
					id: randomUUID(),
					name: identity.name,
					primaryRepositoryKey: identity.repositoryKey,
					createdAt: now,
					updatedAt: now,
				};
				this.database
					.prepare(
						`INSERT INTO projects (id, name, primary_repository_key, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?)`,
					)
					.run(project.id, project.name, project.primaryRepositoryKey, now, now);
				this.database
					.prepare(
						`INSERT INTO project_identities (repository_key, project_id, is_primary, created_at)
						 VALUES (?, ?, 1, ?)`,
					)
					.run(identity.repositoryKey, project.id, now);
			}

			const checkout = this.recordCheckoutSync(project.id, identity.checkoutRoot, now);
			return { project, checkout, repositoryLabel: identity.repositoryLabel };
		})();
	}

	async findByRepositoryKey(key: string): Promise<Project | undefined> {
		return this.findByRepositoryKeySync(key);
	}

	async relinkIdentity(repositoryKey: string, projectId: string): Promise<void> {
		this.database.transaction(() => {
			const project = this.database.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
			if (!project) {
				throw new Error(`Project ${projectId} does not exist`);
			}
			this.database
				.prepare(
					`INSERT INTO project_identities (repository_key, project_id, is_primary, created_at)
					 VALUES (?, ?, 0, ?)`,
				)
				.run(repositoryKey, projectId, new Date().toISOString());
		})();
	}

	private findByRepositoryKeySync(key: string): Project | undefined {
		const row = this.database
			.prepare(
				`SELECT p.*
				 FROM projects p
				 JOIN project_identities i ON i.project_id = p.id
				 WHERE i.repository_key = ?`,
			)
			.get(key) as ProjectRow | undefined;
		return row ? mapProject(row) : undefined;
	}

	private recordCheckoutSync(projectId: string, root: string, now: string): ProjectCheckout {
		const existing = this.database.prepare("SELECT * FROM project_checkouts WHERE root = ?").get(root) as
			| ProjectCheckoutRow
			| undefined;
		if (existing && existing.project_id !== projectId) {
			throw new Error("This checkout belongs to another Pi Toolbox project. Relink the repository identity explicitly.");
		}
		if (existing) {
			this.database.prepare("UPDATE project_checkouts SET last_seen_at = ? WHERE id = ?").run(now, existing.id);
			return mapProjectCheckout({ ...existing, last_seen_at: now });
		}

		const checkout: ProjectCheckout = { id: randomUUID(), projectId, root, lastSeenAt: now };
		this.database
			.prepare("INSERT INTO project_checkouts (id, project_id, root, last_seen_at) VALUES (?, ?, ?, ?)")
			.run(checkout.id, checkout.projectId, checkout.root, checkout.lastSeenAt);
		return checkout;
	}
}

export class SqliteFeatureSpecRepository implements FeatureSpecRepository {
	constructor(private readonly database: Database.Database) {}

	async createDraft(input: CreateDraftInput): Promise<FeatureSpec> {
		const title = input.title.trim();
		const brief = input.brief.trim();
		if (title.length === 0 || brief.length === 0) {
			throw new Error("A feature draft requires a title and description");
		}

		const now = new Date().toISOString();
		const feature: FeatureSpec = {
			id: randomUUID(),
			projectId: input.projectId,
			title,
			brief,
			stage: "draft",
			modelProfile: input.modelProfile,
			createdAt: now,
			updatedAt: now,
		};
		this.database
			.prepare(
				`INSERT INTO feature_specs (
					id, project_id, title, brief, stage, model_provider, model_id, thinking_level, created_at, updated_at
				) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
			)
			.run(
				feature.id,
				feature.projectId,
				feature.title,
				feature.brief,
				feature.modelProfile.provider,
				feature.modelProfile.model,
				feature.modelProfile.thinkingLevel,
				now,
				now,
			);
		this.recordEvent(feature.projectId, feature.id, "feature_draft_created", { title });
		return feature;
	}

	async updateModelProfile(featureSpecId: string, profile: WorkflowModelProfile): Promise<void> {
		const feature = this.requireFeature(featureSpecId);
		if (feature.stage === "approved") {
			throw new Error("The model profile of an approved specification is immutable");
		}
		const now = new Date().toISOString();
		this.database
			.prepare(
				`UPDATE feature_specs
				 SET model_provider = ?, model_id = ?, thinking_level = ?, updated_at = ?
				 WHERE id = ? AND stage <> 'approved'`,
			)
			.run(profile.provider, profile.model, profile.thinkingLevel, now, featureSpecId);
		this.recordEvent(feature.projectId, feature.id, "spec_model_profile_changed", profile);
	}

	async saveQuestion(input: SaveQuestionInput): Promise<SpecQuestion> {
		return this.database.transaction(() => {
			const feature = this.requireFeature(input.featureSpecId);
			if (feature.stage !== "draft" && feature.stage !== "interview") {
				throw new Error(`Cannot add a question while the feature is ${feature.stage}`);
			}
			const count = this.database
				.prepare("SELECT COUNT(*) AS count FROM spec_questions WHERE feature_spec_id = ?")
				.get(feature.id) as { count: number };
			if (count.count >= 10) {
				throw new Error("The requirements interview has reached ten questions");
			}
			const sequence = count.count + 1;
			if (
				!Number.isInteger(input.estimatedQuestionCount) ||
				input.estimatedQuestionCount < sequence ||
				input.estimatedQuestionCount > 10
			) {
				throw new Error(`Question ${sequence} requires a total estimate between ${sequence} and 10`);
			}

			const now = new Date().toISOString();
			const question: SpecQuestion = {
				id: randomUUID(),
				featureSpecId: feature.id,
				sequence,
				estimatedQuestionCount: input.estimatedQuestionCount,
				prompt: input.prompt.trim(),
				choices: input.choices,
				createdAt: now,
			};
			this.database
				.prepare(
					`INSERT INTO spec_questions (
						id, feature_spec_id, sequence, estimated_question_count, prompt, choices_json, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					question.id,
					question.featureSpecId,
					question.sequence,
					question.estimatedQuestionCount,
					question.prompt,
					JSON.stringify(question.choices),
					now,
				);
			this.database
				.prepare("UPDATE feature_specs SET stage = 'interview', updated_at = ? WHERE id = ?")
				.run(now, feature.id);
			this.recordEvent(feature.projectId, feature.id, "spec_question_created", { sequence: question.sequence });
			return question;
		})();
	}

	async saveAnswer(questionId: string, answer: string): Promise<void> {
		const normalizedAnswer = answer.trim();
		if (normalizedAnswer.length === 0) {
			throw new Error("An interview answer cannot be empty");
		}

		this.database.transaction(() => {
			const question = this.database
				.prepare(
					`SELECT q.id, q.feature_spec_id, f.project_id
					 FROM spec_questions q
					 JOIN feature_specs f ON f.id = q.feature_spec_id
					 WHERE q.id = ?`,
				)
				.get(questionId) as { id: string; feature_spec_id: string; project_id: string } | undefined;
			if (!question) {
				throw new Error(`Question ${questionId} does not exist`);
			}
			const now = new Date().toISOString();
			const result = this.database
				.prepare("INSERT INTO spec_answers (id, question_id, answer, created_at) VALUES (?, ?, ?, ?)")
				.run(randomUUID(), questionId, normalizedAnswer, now);
			if (result.changes !== 1) {
				throw new Error("The interview answer was not saved");
			}
			this.database.prepare("UPDATE feature_specs SET updated_at = ? WHERE id = ?").run(now, question.feature_spec_id);
			this.recordEvent(question.project_id, question.feature_spec_id, "spec_answer_saved", { questionId });
		})();
	}

	async saveReview(input: SaveReviewInput): Promise<SpecRevision> {
		return this.database.transaction(() => {
			const feature = this.requireFeature(input.featureSpecId);
			if (feature.stage === "approved") {
				throw new Error("An approved feature requires a new specification revision workflow");
			}
			const row = this.database
				.prepare("SELECT COALESCE(MAX(revision_number), 0) AS revision FROM spec_revisions WHERE feature_spec_id = ?")
				.get(feature.id) as { revision: number };
			const now = new Date().toISOString();
			const revision: SpecRevision = {
				id: randomUUID(),
				featureSpecId: feature.id,
				revisionNumber: row.revision + 1,
				document: input.document,
				createdAt: now,
			};
			this.database
				.prepare(
					`INSERT INTO spec_revisions (id, feature_spec_id, revision_number, document_json, created_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(revision.id, revision.featureSpecId, revision.revisionNumber, JSON.stringify(revision.document), now);
			this.database.prepare("UPDATE feature_specs SET stage = 'review', updated_at = ? WHERE id = ?").run(now, feature.id);
			this.recordEvent(feature.projectId, feature.id, "spec_review_created", { revisionId: revision.id });
			return revision;
		})();
	}

	async approve(featureSpecId: string, revisionId: string): Promise<FeatureSpec> {
		return this.database.transaction(() => {
			const feature = this.requireFeature(featureSpecId);
			if (feature.stage !== "review") {
				throw new Error(`Cannot approve a feature while it is ${feature.stage}`);
			}
			const revisionRow = this.database
				.prepare("SELECT * FROM spec_revisions WHERE id = ? AND feature_spec_id = ?")
				.get(revisionId, featureSpecId) as SpecRevisionRow | undefined;
			if (!revisionRow) {
				throw new Error("The selected specification revision does not exist");
			}
			const latest = this.database
				.prepare("SELECT MAX(revision_number) AS revision FROM spec_revisions WHERE feature_spec_id = ?")
				.get(featureSpecId) as { revision: number };
			if (revisionRow.revision_number !== latest.revision) {
				throw new Error("Only the latest specification revision can be approved");
			}

			const revision = mapRevision(revisionRow);
			validateTaskPlan(revision.document.tasks);
			const now = new Date().toISOString();
			const taskIds = new Map<string, string>();
			for (const task of revision.document.tasks) {
				taskIds.set(task.key, randomUUID());
			}
			for (const [index, task] of revision.document.tasks.entries()) {
				this.insertTask(revision.id, taskIds.get(task.key)!, task, index + 1);
			}
			for (const task of revision.document.tasks) {
				for (const dependency of task.dependencies) {
					this.database
						.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)")
						.run(taskIds.get(task.key), taskIds.get(dependency));
				}
			}
			this.database.prepare("UPDATE spec_revisions SET approved_at = ? WHERE id = ?").run(now, revision.id);
			this.database
				.prepare(
					`UPDATE feature_specs
					 SET stage = 'approved', implementation_status = 'todo', approved_revision_id = ?, updated_at = ?
					 WHERE id = ?`,
				)
				.run(revision.id, now, feature.id);
			this.recordEvent(feature.projectId, feature.id, "spec_approved", { revisionId: revision.id });
			const approvedFeature: FeatureSpec = {
				...feature,
				stage: "approved",
				implementationStatus: "todo",
				approvedRevisionId: revision.id,
				updatedAt: now,
			};
			return approvedFeature;
		})();
	}

	async getById(id: string): Promise<FeatureSpecDetail | undefined> {
		const row = this.database.prepare("SELECT * FROM feature_specs WHERE id = ?").get(id) as FeatureSpecRow | undefined;
		if (!row) {
			return undefined;
		}
		const questions = this.database
			.prepare(
				`SELECT q.*, a.answer
				 FROM spec_questions q
				 LEFT JOIN spec_answers a ON a.question_id = q.id
				 WHERE q.feature_spec_id = ?
				 ORDER BY q.sequence`,
			)
			.all(id) as SpecQuestionRow[];
		const reviewRow = this.database
			.prepare("SELECT * FROM spec_revisions WHERE feature_spec_id = ? ORDER BY revision_number DESC LIMIT 1")
			.get(id) as SpecRevisionRow | undefined;
		return {
			feature: mapFeatureSpec(row),
			questions: questions.map(mapQuestion),
			...(reviewRow ? { review: mapRevision(reviewRow) } : {}),
		};
	}

	async listForProject(projectId: string): Promise<FeatureSpec[]> {
		const rows = this.database
			.prepare("SELECT * FROM feature_specs WHERE project_id = ? ORDER BY updated_at DESC")
			.all(projectId) as FeatureSpecRow[];
		return rows.map(mapFeatureSpec);
	}

	private requireFeature(id: string): FeatureSpec {
		const row = this.database.prepare("SELECT * FROM feature_specs WHERE id = ?").get(id) as FeatureSpecRow | undefined;
		if (!row) {
			throw new Error(`Feature ${id} does not exist`);
		}
		return mapFeatureSpec(row);
	}

	private insertTask(revisionId: string, id: string, task: PlannedTask, order: number): void {
		this.database
			.prepare(
				`INSERT INTO tasks (
					id, revision_id, kind, title, objective, context, acceptance_criteria_json, task_order, status, qa_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?)`,
			)
			.run(
				id,
				revisionId,
				task.kind,
				task.title,
				task.objective,
				task.context,
				JSON.stringify(task.acceptanceCriteria),
				order,
				task.qa ? JSON.stringify(task.qa) : null,
			);
	}

	private recordEvent(projectId: string, featureSpecId: string, eventType: string, payload: object): void {
		this.database
			.prepare(
				`INSERT INTO workflow_events (id, project_id, feature_spec_id, event_type, payload_json, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(randomUUID(), projectId, featureSpecId, eventType, JSON.stringify(payload), new Date().toISOString());
	}
}

export class SqliteImplementationRepository implements ImplementationRepository {
	constructor(private readonly database: Database.Database) {}

	async listCandidates(projectId: string): Promise<ImplementationCandidate[]> {
		const rows = this.database
			.prepare(
				`SELECT f.*, r.id AS revision_id, r.feature_spec_id AS revision_feature_spec_id,
					r.revision_number, r.document_json, r.created_at AS revision_created_at, r.approved_at,
					COUNT(t.id) AS task_count,
					SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS completed_task_count
				 FROM feature_specs f
				 JOIN spec_revisions r ON r.id = f.approved_revision_id
				 LEFT JOIN tasks t ON t.revision_id = r.id
				 WHERE f.project_id = ? AND f.stage = 'approved'
				 GROUP BY f.id, r.id
				 ORDER BY f.updated_at DESC`,
			)
			.all(projectId) as CandidateRow[];

		return rows.map((row) => ({
			feature: mapFeatureSpec(row),
			revision: mapRevision({
				id: row.revision_id,
				feature_spec_id: row.revision_feature_spec_id,
				revision_number: row.revision_number,
				document_json: row.document_json,
				created_at: row.revision_created_at,
				approved_at: row.approved_at,
			}),
			taskCount: row.task_count,
			completedTaskCount: row.completed_task_count,
		}));
	}
}

interface ProjectRow {
	id: string;
	name: string;
	primary_repository_key: string;
	created_at: string;
	updated_at: string;
}

interface ProjectCheckoutRow {
	id: string;
	project_id: string;
	root: string;
	last_seen_at: string;
}

interface FeatureSpecRow {
	id: string;
	project_id: string;
	title: string;
	brief: string;
	stage: SpecStage;
	model_provider: string;
	model_id: string;
	thinking_level: WorkflowModelProfile["thinkingLevel"];
	implementation_status: ImplementationStatus | null;
	approved_revision_id: string | null;
	created_at: string;
	updated_at: string;
}

interface SpecQuestionRow {
	id: string;
	feature_spec_id: string;
	sequence: number;
	estimated_question_count: number | null;
	prompt: string;
	choices_json: string;
	answer: string | null;
	created_at: string;
}

interface SpecRevisionRow {
	id: string;
	feature_spec_id: string;
	revision_number: number;
	document_json: string;
	created_at: string;
	approved_at: string | null;
}

interface CandidateRow extends FeatureSpecRow {
	revision_id: string;
	revision_feature_spec_id: string;
	revision_number: number;
	document_json: string;
	revision_created_at: string;
	approved_at: string | null;
	task_count: number;
	completed_task_count: number;
}

function mapProject(row: ProjectRow): Project {
	return {
		id: row.id,
		name: row.name,
		primaryRepositoryKey: row.primary_repository_key,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapProjectCheckout(row: ProjectCheckoutRow): ProjectCheckout {
	return { id: row.id, projectId: row.project_id, root: row.root, lastSeenAt: row.last_seen_at };
}

function mapFeatureSpec(row: FeatureSpecRow): FeatureSpec {
	return {
		id: row.id,
		projectId: row.project_id,
		title: row.title,
		brief: row.brief,
		stage: row.stage,
		modelProfile: {
			provider: row.model_provider,
			model: row.model_id,
			thinkingLevel: row.thinking_level,
		},
		...(row.implementation_status ? { implementationStatus: row.implementation_status } : {}),
		...(row.approved_revision_id ? { approvedRevisionId: row.approved_revision_id } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapQuestion(row: SpecQuestionRow): SpecQuestion {
	return {
		id: row.id,
		featureSpecId: row.feature_spec_id,
		sequence: row.sequence,
		estimatedQuestionCount: row.estimated_question_count ?? 10,
		prompt: row.prompt,
		choices: JSON.parse(row.choices_json) as string[],
		...(row.answer ? { answer: row.answer } : {}),
		createdAt: row.created_at,
	};
}

function mapRevision(row: SpecRevisionRow): SpecRevision {
	return {
		id: row.id,
		featureSpecId: row.feature_spec_id,
		revisionNumber: row.revision_number,
		document: JSON.parse(row.document_json) as SpecDocument,
		createdAt: row.created_at,
		...(row.approved_at ? { approvedAt: row.approved_at } : {}),
	};
}

function validateTaskPlan(tasks: PlannedTask[]): void {
	if (tasks.length === 0) {
		throw new Error("A specification requires at least one task");
	}
	const taskOrder = new Map<string, number>();
	for (const [index, task] of tasks.entries()) {
		if (task.key.trim().length === 0 || task.title.trim().length === 0 || task.objective.trim().length === 0) {
			throw new Error(`Task ${index + 1} requires a key, title, and objective`);
		}
		if (task.acceptanceCriteria.length === 0) {
			throw new Error(`Task ${task.key} requires acceptance criteria`);
		}
		if (taskOrder.has(task.key)) {
			throw new Error(`Duplicate task key: ${task.key}`);
		}
		if (task.kind === "user_qa" && !task.qa) {
			throw new Error(`User QA task ${task.key} requires QA instructions`);
		}
		if (task.kind === "implementation" && task.qa) {
			throw new Error(`Implementation task ${task.key} cannot contain QA instructions`);
		}
		taskOrder.set(task.key, index);
	}
	for (const [index, task] of tasks.entries()) {
		for (const dependency of task.dependencies) {
			const dependencyIndex = taskOrder.get(dependency);
			if (dependencyIndex === undefined) {
				throw new Error(`Task ${task.key} depends on unknown task ${dependency}`);
			}
			if (dependencyIndex >= index) {
				throw new Error(`Task ${task.key} must depend only on an earlier task`);
			}
		}
	}
}
