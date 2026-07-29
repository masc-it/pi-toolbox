import type Database from "better-sqlite3";

interface Migration {
	version: number;
	name: string;
	up: string;
}

const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: "initial_schema",
		up: `
CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	primary_repository_key TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE project_identities (
	repository_key TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
	created_at TEXT NOT NULL
);

CREATE TABLE project_checkouts (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	root TEXT NOT NULL UNIQUE,
	last_seen_at TEXT NOT NULL
);

CREATE TABLE feature_specs (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	title TEXT NOT NULL,
	brief TEXT NOT NULL,
	stage TEXT NOT NULL CHECK (stage IN ('draft', 'interview', 'review', 'approved')),
	model_provider TEXT NOT NULL,
	model_id TEXT NOT NULL,
	thinking_level TEXT NOT NULL CHECK (thinking_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
	implementation_status TEXT CHECK (implementation_status IN ('todo', 'in_progress', 'paused', 'qa_pending', 'done')),
	approved_revision_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX feature_specs_project_stage_idx ON feature_specs(project_id, stage, updated_at DESC);
CREATE INDEX feature_specs_project_status_idx ON feature_specs(project_id, implementation_status, updated_at DESC);

CREATE TABLE spec_revisions (
	id TEXT PRIMARY KEY,
	feature_spec_id TEXT NOT NULL REFERENCES feature_specs(id) ON DELETE CASCADE,
	revision_number INTEGER NOT NULL CHECK (revision_number > 0),
	document_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	approved_at TEXT,
	UNIQUE (feature_spec_id, revision_number)
);

CREATE TABLE spec_questions (
	id TEXT PRIMARY KEY,
	feature_spec_id TEXT NOT NULL REFERENCES feature_specs(id) ON DELETE CASCADE,
	sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 10),
	prompt TEXT NOT NULL,
	choices_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	UNIQUE (feature_spec_id, sequence)
);

CREATE TABLE spec_answers (
	id TEXT PRIMARY KEY,
	question_id TEXT NOT NULL UNIQUE REFERENCES spec_questions(id) ON DELETE CASCADE,
	answer TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE TABLE tasks (
	id TEXT PRIMARY KEY,
	revision_id TEXT NOT NULL REFERENCES spec_revisions(id) ON DELETE RESTRICT,
	kind TEXT NOT NULL CHECK (kind IN ('implementation', 'user_qa')),
	title TEXT NOT NULL,
	objective TEXT NOT NULL,
	context TEXT NOT NULL,
	acceptance_criteria_json TEXT NOT NULL,
	task_order INTEGER NOT NULL CHECK (task_order > 0),
	status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'done')),
	qa_json TEXT,
	UNIQUE (revision_id, task_order)
);

CREATE TABLE task_dependencies (
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
	PRIMARY KEY (task_id, depends_on_task_id),
	CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE implementation_runs (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	feature_spec_id TEXT NOT NULL REFERENCES feature_specs(id) ON DELETE RESTRICT,
	revision_id TEXT NOT NULL REFERENCES spec_revisions(id) ON DELETE RESTRICT,
	checkout_id TEXT NOT NULL REFERENCES project_checkouts(id) ON DELETE RESTRICT,
	status TEXT NOT NULL CHECK (status IN ('in_progress', 'paused', 'qa_pending', 'done')),
	model_provider TEXT NOT NULL,
	model_id TEXT NOT NULL,
	thinking_level TEXT NOT NULL,
	pi_session_id TEXT,
	pi_session_file TEXT,
	current_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
	pause_reason TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX implementation_runs_one_active_per_project
	ON implementation_runs(project_id)
	WHERE status IN ('in_progress', 'paused', 'qa_pending');

CREATE TABLE task_attempts (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES implementation_runs(id) ON DELETE CASCADE,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
	result TEXT NOT NULL CHECK (result IN ('completed', 'blocked')),
	summary TEXT NOT NULL,
	changed_files_json TEXT NOT NULL,
	evidence_json TEXT NOT NULL,
	unresolved_concerns_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE TABLE qa_results (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES implementation_runs(id) ON DELETE CASCADE,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
	result TEXT NOT NULL CHECK (result IN ('pass', 'fail')),
	notes TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE TABLE workflow_events (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	feature_spec_id TEXT REFERENCES feature_specs(id) ON DELETE CASCADE,
	run_id TEXT REFERENCES implementation_runs(id) ON DELETE CASCADE,
	event_type TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX workflow_events_project_created_idx ON workflow_events(project_id, created_at);

CREATE TRIGGER immutable_approved_revision_update
BEFORE UPDATE ON spec_revisions
WHEN OLD.approved_at IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'approved specification revisions are immutable');
END;

CREATE TRIGGER immutable_approved_revision_delete
BEFORE DELETE ON spec_revisions
WHEN OLD.approved_at IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'approved specification revisions are immutable');
END;
`,
	},
];

export function applyMigrations(database: Database.Database): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at TEXT NOT NULL
		)
	`);

	const appliedVersions = new Set(
		database.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: number }).version),
	);
	const migrate = database.transaction((migration: Migration) => {
		database.exec(migration.up);
		database
			.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
			.run(migration.version, migration.name, new Date().toISOString());
	});

	for (const migration of MIGRATIONS) {
		if (!appliedVersions.has(migration.version)) {
			migrate(migration);
		}
	}
}
