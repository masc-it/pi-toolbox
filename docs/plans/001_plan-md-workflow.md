# Implementation Plan: Plan MD Workflow

## Plan Metadata

| Field | Value |
|---|---|
| schema_version | `plan-md/v1` |
| plan_id | `PLAN-001` |
| plan_index | `001` |
| slug | `plan-md-workflow` |
| title | `Plan MD Workflow` |
| status | `draft` |
| priority | `P1` |
| effort | `XL` |
| risk | `medium` |
| created_at | `2026-08-01` |
| updated_at | `2026-08-01` |
| source | `user-request` |
| source_reference | `Add a Plan MD workflow that creates and tracks machine-parseable implementation plans.` |
| file_path | `docs/plans/001_plan-md-workflow.md` |

## Progress Summary

| Field | Value |
|---|---|
| total_phases | `5` |
| completed_phases | `0` |
| total_milestones | `5` |
| completed_milestones | `0` |
| total_tasks | `13` |
| completed_tasks | `0` |
| blocked_tasks | `0` |
| progress_percent | `0` |
| current_task | `none` |

## Plan Objective

| Field | Value |
|---|---|
| objective | `Add a standalone Plan MD workflow that converts a user's future feature request into a deterministic, machine-parseable Markdown implementation plan stored under docs/plans/<idx>_<slug>.md, then lets the user inspect progress and update task status.` |
| success_condition | `A generated plan can be parsed, validated, rendered identically, reopened after external edits, and tracked by phase, milestone, task, dependency, and status without SQLite becoming the source of truth.` |

## Scope

### In Scope

| ID | Description |
|---|---|
| `SCOPE-001` | Define and document the `plan-md/v1` Markdown contract. |
| `SCOPE-002` | Generate plan data through schema-constrained model output and deterministic Markdown rendering. |
| `SCOPE-003` | Store plans in the current checkout under `docs/plans/<idx>_<slug>.md`. |
| `SCOPE-004` | Discover, parse, validate, list, inspect, and refresh plan files. |
| `SCOPE-005` | Update task status through the Toolbox while keeping the Markdown file canonical. |
| `SCOPE-006` | Show progress, dependencies, priority, effort, risks, acceptance criteria, and validation steps. |
| `SCOPE-007` | Add a landing entry and `/tb-plan` command with an independent model profile. |

### Out of Scope

| ID | Description |
|---|---|
| `NON-GOAL-001` | Automatically execute plan tasks. |
| `NON-GOAL-002` | Infer task completion from Git changes or model output. |
| `NON-GOAL-003` | Import existing Feature Spec records into Plan MD. |
| `NON-GOAL-004` | Synchronize plan state to the Toolbox SQLite database. |
| `NON-GOAL-005` | Support arbitrary Markdown layouts or legacy plan formats in `plan-md/v1`. |

## Sequencing Rules

| Rule ID | Rule |
|---|---|
| `SEQ-001` | Phases MUST appear in ascending `sequence` order and MUST use the five phase categories defined in this plan. |
| `SEQ-002` | Milestones MUST appear inside their owning phase and in ascending `sequence` order. |
| `SEQ-003` | Tasks MUST appear inside their owning milestone and in ascending global `sequence` order. |
| `SEQ-004` | Every dependency MUST reference a phase, milestone, task, or existing component declared earlier in the document. |
| `SEQ-005` | A task MUST NOT move to `in_progress` until every required task dependency has status `done`. |
| `SEQ-006` | Progress fields are derived from task status and MUST be recalculated whenever the file is rewritten. |

## Risk Register

| Risk ID | Level | Status | Description | Mitigation | Owner Task |
|---|---|---|---|---|---|
| `RISK-001` | `high` | `open` | Model-authored Markdown may violate the deterministic format. | Generate schema-constrained structured data and render Markdown in application code. | `TASK-007` |
| `RISK-002` | `high` | `open` | External edits may create invalid identifiers, dependencies, or status summaries. | Parse and validate before displaying or mutating; report exact line and field errors. | `TASK-004` |
| `RISK-003` | `medium` | `open` | Concurrent plan creation may allocate the same numeric index. | Use exclusive creation with collision retry and atomic rename. | `TASK-006` |
| `RISK-004` | `medium` | `open` | Re-rendering may destroy user-authored content not represented by the schema. | Make every supported content area explicit and reject unknown structural sections. | `TASK-005` |
| `RISK-005` | `medium` | `open` | A large plan may exceed the overlay viewport. | Use compact summaries and bounded scrolling for phase, milestone, and task detail views. | `TASK-009` |

## Phase PHASE-01: Foundations and Shared Infrastructure

### Phase Metadata

| Field | Value |
|---|---|
| phase_id | `PHASE-01` |
| sequence | `1` |
| category | `foundations` |
| title | `Foundations and Shared Infrastructure` |
| status | `todo` |
| dependencies | `none` |
| objective | `Establish the canonical format contract and safe project-local path conventions used by every later layer.` |

### Milestone MILESTONE-001: Format and Storage Foundations

#### Milestone Metadata

| Field | Value |
|---|---|
| milestone_id | `MILESTONE-001` |
| sequence | `1` |
| phase_id | `PHASE-01` |
| status | `todo` |
| dependencies | `none` |
| completion_rule | `TASK-001 and TASK-002 are done.` |

#### Task TASK-001: Define the plan-md/v1 Contract

##### Task Metadata

| Field | Value |
|---|---|
| task_id | `TASK-001` |
| sequence | `1` |
| phase_id | `PHASE-01` |
| milestone_id | `MILESTONE-001` |
| status | `todo` |
| priority | `P0` |
| effort | `L` |
| risk | `high` |
| dependencies | `none` |
| objective | `Specify the exact Markdown grammar, required fields, allowed values, nesting, identifier rules, dependency rules, and canonical rendering behavior for plan-md/v1.` |

##### Inputs

| Input ID | Source | Description | Required |
|---|---|---|---|
| `INPUT-001-01` | `user-request` | Requirements for deterministic phases, milestones, tasks, status, dependencies, and validation. | `yes` |
| `INPUT-001-02` | `docs/plans/001_plan-md-workflow.md` | This plan as the first representative document. | `yes` |

##### Outputs

| Output ID | Path or Symbol | Description |
|---|---|---|
| `OUTPUT-001-01` | `docs/plan-md-spec.md` | Normative plan-md/v1 specification with exact headings, tables, field names, allowed values, and parsing rules. |
| `OUTPUT-001-02` | `docs/plan-md-spec.md#complete-example` | A complete conforming example implementation plan. |
| `OUTPUT-001-03` | `src/plan-md/constants.ts` | Shared schema version, allowed values, heading names, and identifier patterns. |

##### Subtasks

| Subtask ID | Status | Description |
|---|---|---|
| `SUBTASK-001-01` | `todo` | Define required top-level sections and their exact order. |
| `SUBTASK-001-02` | `todo` | Define phase, milestone, task, input, output, subtask, acceptance, validation, and risk structures. |
| `SUBTASK-001-03` | `todo` | Define allowed status, priority, effort, risk, and validation-method values. |
| `SUBTASK-001-04` | `todo` | Define stable identifier and dependency-reference rules. |
| `SUBTASK-001-05` | `todo` | Define canonical whitespace, table, escaping, and newline behavior. |

##### Acceptance Criteria

| Criterion ID | Status | Criterion |
|---|---|---|
| `AC-001-01` | `todo` | Every required heading and table field has an exact case-sensitive name. |
| `AC-001-02` | `todo` | Allowed values and identifier regular expressions are explicit. |
| `AC-001-03` | `todo` | Unknown fields, duplicate IDs, forward dependencies, and omitted sections have defined error behavior. |
| `AC-001-04` | `todo` | The specification contains a complete example covering all supported element types. |
| `AC-001-05` | `todo` | A program can parse the format without interpreting informal prose or position-dependent unlabeled values. |

##### Validation Steps

| Validation ID | Status | Method | Procedure | Expected Result |
|---|---|---|---|---|
| `VAL-001-01` | `todo` | `review` | Compare every user requirement with a normative rule in `docs/plan-md-spec.md`. | Every requirement maps to at least one explicit rule. |
| `VAL-001-02` | `todo` | `fixture` | Parse the complete example with the parser created by TASK-004. | The example validates with zero warnings or errors. |

#### Task TASK-002: Define Project-local Plan Paths and Index Allocation

##### Task Metadata

| Field | Value |
|---|---|
| task_id | `TASK-002` |
| sequence | `2` |
| phase_id | `PHASE-01` |
| milestone_id | `MILESTONE-001` |
| status | `todo` |
| priority | `P1` |
| effort | `M` |
| risk | `medium` |
| dependencies | `TASK-001` |
| objective | `Define deterministic, safe file naming and sequential index allocation for plans under the current checkout's docs/plans directory.` |

##### Inputs

| Input ID | Source | Description | Required |
|---|---|---|---|
| `INPUT-002-01` | `TASK-001` | Identifier and canonical-format conventions. | `yes` |
| `INPUT-002-02` | `ProjectContext.checkout.root` | Canonical current-project checkout root. | `yes` |

##### Outputs

| Output ID | Path or Symbol | Description |
|---|---|---|
| `OUTPUT-002-01` | `src/plan-md/path.ts` | Path resolution, slug normalization, filename parsing, and index allocation helpers. |
| `OUTPUT-002-02` | `docs/plans/` | Lazily created project-local plan directory. |

##### Subtasks

| Subtask ID | Status | Description |
|---|---|---|
| `SUBTASK-002-01` | `todo` | Accept filenames matching `^[0-9]{3}_[a-z0-9]+(?:-[a-z0-9]+)*\.md$`. |
| `SUBTASK-002-02` | `todo` | Allocate one greater than the highest valid existing index, starting at `001`. |
| `SUBTASK-002-03` | `todo` | Normalize titles to lowercase ASCII kebab-case with deterministic fallback text. |
| `SUBTASK-002-04` | `todo` | Resolve and verify all paths remain beneath `<checkout>/docs/plans`. |
| `SUBTASK-002-05` | `todo` | Define explicit exhaustion behavior after index `999`. |

##### Acceptance Criteria

| Criterion ID | Status | Criterion |
|---|---|---|
| `AC-002-01` | `todo` | `Add User Authentication` maps to `001_add-user-authentication.md` in an empty plan directory. |
| `AC-002-02` | `todo` | Invalid filenames are ignored for index allocation and reported during discovery. |
| `AC-002-03` | `todo` | Slugs cannot escape or replace the configured plan directory. |
| `AC-002-04` | `todo` | Existing valid files are never overwritten during creation. |

##### Validation Steps

| Validation ID | Status | Method | Procedure | Expected Result |
|---|---|---|---|---|
| `VAL-002-01` | `todo` | `automated` | Run path tests with empty, sparse, malformed, Unicode, and maximum-index fixtures. | Every fixture returns the documented filename or explicit error. |
| `VAL-002-02` | `todo` | `security` | Test `..`, absolute paths, separators, symlinks, and empty slug inputs. | No resolved plan path escapes `docs/plans`. |

## Phase PHASE-02: Core Domain Models and Interfaces

### Phase Metadata

| Field | Value |
|---|---|
| phase_id | `PHASE-02` |
| sequence | `2` |
| category | `domain` |
| title | `Core Domain Models and Interfaces` |
| status | `todo` |
| dependencies | `PHASE-01` |
| objective | `Represent plan-md/v1 as typed data and provide strict parsing, semantic validation, and canonical rendering.` |

### Milestone MILESTONE-002: Typed Plan Document Round Trip

#### Milestone Metadata

| Field | Value |
|---|---|
| milestone_id | `MILESTONE-002` |
| sequence | `2` |
| phase_id | `PHASE-02` |
| status | `todo` |
| dependencies | `MILESTONE-001` |
| completion_rule | `TASK-003, TASK-004, and TASK-005 are done.` |

#### Task TASK-003: Add Plan Domain Types and Structured-output Schemas

##### Task Metadata

| Field | Value |
|---|---|
| task_id | `TASK-003` |
| sequence | `3` |
| phase_id | `PHASE-02` |
| milestone_id | `MILESTONE-002` |
| status | `todo` |
| priority | `P0` |
| effort | `L` |
| risk | `medium` |
| dependencies | `TASK-001` |
| objective | `Create one typed PlanDocument model shared by model generation, parsing, validation, rendering, progress calculation, and UI presentation.` |

##### Inputs

| Input ID | Source | Description | Required |
|---|---|---|---|
| `INPUT-003-01` | `OUTPUT-001-01` | Normative plan-md/v1 fields and allowed values. | `yes` |
| `INPUT-003-02` | `src/model/schemas.ts` | Existing TypeBox and semantic-validation patterns. | `yes` |

##### Outputs

| Output ID | Path or Symbol | Description |
|---|---|---|
| `OUTPUT-003-01` | `src/plan-md/domain.ts` | Plan, progress, phase, milestone, task, subtask, criterion, validation, and risk types. |
| `OUTPUT-003-02` | `src/plan-md/schema.ts` | Provider-compatible TypeBox schemas for constrained generation. |
| `OUTPUT-003-03` | `PlanStatus`, `TaskStatus`, `PlanPriority`, `PlanEffort`, `RiskLevel` | Closed allowed-value unions. |

##### Subtasks

| Subtask ID | Status | Description |
|---|---|---|
| `SUBTASK-003-01` | `todo` | Model all required metadata and nested entities without optional structural ambiguity. |
| `SUBTASK-003-02` | `todo` | Use nullable required fields where strict providers require every property. |
| `SUBTASK-003-03` | `todo` | Keep provider schemas structural and enforce unsupported JSON Schema constraints semantically. |
| `SUBTASK-003-04` | `todo` | Represent all dependencies as stable ID arrays. |

##### Acceptance Criteria

| Criterion ID | Status | Criterion |
|---|---|---|
| `AC-003-01` | `todo` | The model can represent every field required by `plan-md/v1`. |
| `AC-003-02` | `todo` | Status, priority, effort, risk, phase category, and validation method reject unknown values. |
| `AC-003-03` | `todo` | TypeBox schemas work with Pi's `constrainedSampling: { type: "json_schema", strict: "prefer" }`. |
| `AC-003-04` | `todo` | No UI-specific or filesystem-specific state appears in PlanDocument. |

##### Validation Steps

| Validation ID | Status | Method | Procedure | Expected Result |
|---|---|---|---|---|
| `VAL-003-01` | `todo` | `automated` | Validate complete and malformed PlanDocument fixtures. | Complete fixtures pass; missing, mistyped, and unknown enum values fail. |
| `VAL-003-02` | `todo` | `typecheck` | Run `npm run typecheck`. | No TypeScript errors. |

#### Task TASK-004: Implement the Strict Markdown Parser and Semantic Validator

##### Task Metadata

| Field | Value |
|---|---|
| task_id | `TASK-004` |
| sequence | `4` |
| phase_id | `PHASE-02` |
| milestone_id | `MILESTONE-002` |
| status | `todo` |
| priority | `P0` |
| effort | `XL` |
| risk | `high` |
| dependencies | `TASK-003` |
| objective | `Parse canonical Markdown into PlanDocument and reject structural or semantic ambiguity with actionable diagnostics.` |

##### Inputs

| Input ID | Source | Description | Required |
|---|---|---|---|
| `INPUT-004-01` | `OUTPUT-001-01` | Exact grammar and ordering rules. | `yes` |
| `INPUT-004-02` | `OUTPUT-003-01` | Typed PlanDocument target. | `yes` |

##### Outputs

| Output ID | Path or Symbol | Description |
|---|---|---|
| `OUTPUT-004-01` | `src/plan-md/parser.ts` | Line-aware Markdown parser for the exact v1 structure. |
| `OUTPUT-004-02` | `src/plan-md/validator.ts` | Cross-reference, order, transition, count, and semantic validation. |
| `OUTPUT-004-03` | `PlanDiagnostic` | Stable diagnostic code, severity, line, field, entity ID, and message. |

##### Subtasks

| Subtask ID | Status | Description |
|---|---|---|
| `SUBTASK-004-01` | `todo` | Parse headings and tables using exact names and expected nesting. |
| `SUBTASK-004-02` | `todo` | Parse lists, checklists, escaped cells, code spans, and `none` values deterministically. |
| `SUBTASK-004-03` | `todo` | Reject duplicate IDs, unknown references, forward dependencies, invalid phase order, and count mismatches. |
| `SUBTASK-004-04` | `todo` | Verify filenames agree with `plan_index` and `slug` metadata. |
| `SUBTASK-004-05` | `todo` | Return all safe-to-collect diagnostics in one validation pass. |

##### Acceptance Criteria

| Criterion ID | Status | Criterion |
|---|---|---|
| `AC-004-01` | `todo` | A valid canonical file produces exactly one PlanDocument. |
| `AC-004-02` | `todo` | Missing headings, reordered sections, duplicate table fields, and unknown structural content fail explicitly. |
| `AC-004-03` | `todo` | Every diagnostic identifies a stable code and source line. |
| `AC-004-04` | `todo` | Dependencies can reference only earlier declared entities and existing registered components. |
| `AC-004-05` | `todo` | Task and summary status inconsistencies are detected rather than silently repaired during read. |

##### Validation Steps

| Validation ID | Status | Method | Procedure | Expected Result |
|---|---|---|---|---|
| `VAL-004-01` | `todo` | `automated` | Run parser fixtures with one mutation per normative rule. | Each invalid fixture emits its expected diagnostic code. |
| `VAL-004-02` | `todo` | `fuzz` | Apply bounded heading, table, delimiter, newline, and ID mutations to a valid fixture. | The parser either returns the original meaning or a controlled diagnostic; it never guesses. |

#### Task TASK-005: Implement the Canonical Markdown Renderer

##### Task Metadata

| Field | Value |
|---|---|
| task_id | `TASK-005` |
| sequence | `5` |
| phase_id | `PHASE-02` |
| milestone_id | `MILESTONE-002` |
| status | `todo` |
| priority | `P0` |
| effort | `L` |
| risk | `high` |
| dependencies | `TASK-003`, `TASK-004` |
| objective | `Render any valid PlanDocument into one byte-stable canonical plan-md/v1 representation.` |

##### Inputs

| Input ID | Source | Description | Required |
|---|---|---|---|
| `INPUT-005-01` | `OUTPUT-003-01` | Valid PlanDocument. | `yes` |
| `INPUT-005-02` | `OUTPUT-001-01` | Canonical formatting rules. | `yes` |

##### Outputs

| Output ID | Path or Symbol | Description |
|---|---|---|
| `OUTPUT-005-01` | `src/plan-md/renderer.ts` | Deterministic Markdown renderer. |
| `OUTPUT-005-02` | `renderPlanDocument()` | Pure rendering API with final newline and no environment-dependent output. |

##### Subtasks

| Subtask ID | Status | Description |
|---|---|---|
| `SUBTASK-005-01` | `todo` | Render sections and entities in canonical sequence order. |
| `SUBTASK-005-02` | `todo` | Escape pipes, backticks, backslashes, and line breaks consistently. |
| `SUBTASK-005-03` | `todo` | Recalculate derived progress before rendering. |
| `SUBTASK-005-04` | `todo` | Normalize dates, `none`, comma-separated dependency IDs, blank lines, and final newline. |

##### Acceptance Criteria

| Criterion ID | Status | Criterion |
|---|---|---|
| `AC-005-01` | `todo` | Rendering the same PlanDocument always produces identical UTF-8 bytes. |
| `AC-005-02` | `todo` | `parse(render(document))` is deeply equal to the normalized document. |
| `AC-005-03` | `todo` | `render(parse(render(document)))` is byte-identical to the first render. |
| `AC-005-04` | `todo` | Rendering does not depend on locale, terminal width, or object insertion order. |

##### Validation Steps

| Validation ID | Status | Method | Procedure | Expected Result |
|---|---|---|---|---|
| `VAL-005-01` | `todo` | `automated` | Run round-trip and golden-file tests. | All semantic and byte-stability assertions pass. |
| `VAL-005-02` | `todo` | `fixture` | Render strings containing every escaped character. | Parsing restores the original normalized values. |

## Phase PHASE-03: Services and Business Logic

### Phase Metadata

| Field | Value |
|---|---|
| phase_id | `PHASE-03` |
| sequence | `3` |
| category | `services` |
| title | `Services and Business Logic` |
| status | `todo` |
| dependencies | `PHASE-01`, `PHASE-02` |
| objective | `Provide safe file persistence, model-backed plan creation, status transitions, and progress calculation.` |

### Milestone MILESTONE-003: Plan Lifecycle Services

#### Milestone Metadata

| Field | Value |
|---|---|
| milestone_id | `MILESTONE-003` |
| sequence | `3` |
| phase_id | `PHASE-03` |
| status | `todo` |
| dependencies | `MILESTONE-001`, `MILESTONE-002` |
| completion_rule | `TASK-006, TASK-007, and TASK-008 are done.` |

#### Task TASK-006: Implement the Project Plan File Repository

##### Task Metadata

| Field | Value |
|---|---|
| task_id | `TASK-006` |
| sequence | `6` |
| phase_id | `PHASE-03` |
| milestone_id | `MILESTONE-003` |
| status | `todo` |
| priority | `P0` |
| effort | `L` |
| risk | `high` |
| dependencies | `TASK-002`, `TASK-004`, `TASK-005` |
| objective | `Discover, read, create, validate, and atomically rewrite canonical plan files without using SQLite as plan state.` |

##### Inputs

| Input ID | Source | Description | Required |
|---|---|---|---|
| `INPUT-006-01` | `OUTPUT-002-01` | Safe plan path and index helpers. | `yes` |
| `INPUT-006-02` | `OUTPUT-004-01` | Parser and validator. | `yes` |
| `INPUT-006-03` | `OUTPUT-005-01` | Canonical renderer. | `yes` |
| `INPUT-006-04` | `withFileMutationQueue()` | Pi's per-file mutation serialization utility. | `yes` |

##### Outputs

| Output ID | Path or Symbol | Description |
|---|---|---|
| `OUTPUT-006-01` | `src/plan-md/repository.ts` | Filesystem-backed PlanRepository. |
| `OUTPUT-006-02` | `PlanFileSummary` | Lightweight list metadata with path and validation status. |

##### Subtasks

| Subtask ID | Status | Description |
|---|---|---|
| `SUBTASK-006-01` | `todo` | Discover only regular `.md` files with valid indexed filenames. |
| `SUBTASK-006-02` | `todo` | Create `docs/plans` lazily and allocate indices with collision retry. |
| `SUBTASK-006-03` | `todo` | Write through a same-directory temporary file and atomic rename. |
| `SUBTASK-006-04` | `todo` | Queue read-modify-write status updates by canonical absolute path. |
| `SUBTASK-006-05` | `todo` | Surface malformed files in list results without hiding valid plans. |

##### Acceptance Criteria

| Criterion ID | Status | Criterion |
|---|---|---|
| `AC-006-01` | `todo` | Creating the first plan writes `docs/plans/001_<slug>.md`. |
| `AC-006-02` | `todo` | Concurrent creation never overwrites an existing plan. |
| `AC-006-03` | `todo` | A failed validation or write leaves the previous file unchanged. |
| `AC-006-04` | `todo` | External edits appear after refresh or reopening the view. |
| `AC-006-05` | `todo` | Repository methods never resolve outside the current checkout's `docs/plans` directory. |

##### Validation Steps

| Validation ID | Status | Method | Procedure | Expected Result |
|---|---|---|---|---|
| `VAL-006-01` | `todo` | `automated` | Run repository tests in isolated temporary Git checkouts. | Discovery, creation, collision, update, malformed-file, and rollback scenarios pass. |
| `VAL-006-02` | `todo` | `concurrency` | Start multiple creations with the same title concurrently. | Every successful creation has a unique sequential filename and valid content. |

#### Task TASK-007: Generate Plans through Structured Model Output

##### Task Metadata

| Field | Value |
|---|---|
| task_id | `TASK-007` |
| sequence | `7` |
| phase_id | `PHASE-03` |
| milestone_id | `MILESTONE-003` |
| status | `todo` |
| priority | `P0` |
| effort | `XL` |
| risk | `high` |
| dependencies | `TASK-003`, `TASK-005`, `TASK-006` |
| objective | `Convert a user's request and repository context into a valid PlanDocument using constrained tool output, then persist only renderer-produced Markdown.` |

##### Inputs

| Input ID | Source | Description | Required |
|---|---|---|---|
| `INPUT-007-01` | `user-request` | Future feature or implementation request entered by the user. | `yes` |
| `INPUT-007-02` | `RepositoryInspector` | Bounded repository facts relevant to the requested work. | `yes` |
| `INPUT-007-03` | `WorkflowModelClient.completeStructured()` | Provider-authenticated schema-constrained completion. | `yes` |
| `INPUT-007-04` | `OUTPUT-003-02` | PlanDocument tool schema. | `yes` |

##### Outputs

| Output ID | Path or Symbol | Description |
|---|---|---|
| `OUTPUT-007-01` | `src/workflows/plan-md.ts` | Cancellable plan-generation workflow. |
| `OUTPUT-007-02` | `src/model/plan-md-prompts.ts` | Bottom-up planning instructions and repository-aware prompt builder. |
| `OUTPUT-007-03` | `docs/plans/<idx>_<slug>.md` | Valid canonical generated plan. |

##### Subtasks

| Subtask ID | Status | Description |
|---|---|---|
| `SUBTASK-007-01` | `todo` | Add a dedicated `submit_plan_document` constrained-output tool schema. |
| `SUBTASK-007-02` | `todo` | Require the five fixed bottom-up phase categories and global task sequence. |
| `SUBTASK-007-03` | `todo` | Require explicit task dependencies, inputs, outputs, subtasks, acceptance criteria, and validation steps. |
| `SUBTASK-007-04` | `todo` | Apply semantic validation after TypeBox validation and before any file write. |
| `SUBTASK-007-05` | `todo` | Derive the plan title and slug deterministically from validated output. |

##### Acceptance Criteria

| Criterion ID | Status | Criterion |
|---|---|---|
| `AC-007-01` | `todo` | The model never writes Markdown directly. |
| `AC-007-02` | `todo` | Supported providers use strict JSON Schema sampling when available and validated fallback tool calls otherwise. |
| `AC-007-03` | `todo` | Invalid model output produces an actionable error and no plan file. |
| `AC-007-04` | `todo` | Every generated task belongs to exactly one milestone and one fixed phase. |
| `AC-007-05` | `todo` | Every generated dependency points to an earlier task or registered existing component. |

##### Validation Steps

| Validation ID | Status | Method | Procedure | Expected Result |
|---|---|---|---|---|
| `VAL-007-01` | `todo` | `integration` | Generate plans for a UI-only feature, a database migration, and a cross-cutting refactor. | Each plan validates and preserves bottom-up dependency order. |
| `VAL-007-02` | `todo` | `cancellation` | Cancel generation before completion. | No partial plan file remains. |
| `VAL-007-03` | `todo` | `provider` | Exercise one strict-capable and one fallback model. | Both return valid PlanDocument values or explicit errors. |

#### Task TASK-008: Implement Status Transitions and Progress Calculation

##### Task Metadata

| Field | Value |
|---|---|
| task_id | `TASK-008` |
| sequence | `8` |
| phase_id | `PHASE-03` |
| milestone_id | `MILESTONE-003` |
| status | `todo` |
| priority | `P0` |
| effort | `L` |
| risk | `medium` |
| dependencies | `TASK-004`, `TASK-005`, `TASK-006` |
| objective | `Apply explicit task status transitions, dependency guards, and derived progress updates through validated atomic file rewrites.` |

##### Inputs

| Input ID | Source | Description | Required |
|---|---|---|---|
| `INPUT-008-01` | `OUTPUT-004-02` | Semantic validator and dependency graph. | `yes` |
| `INPUT-008-02` | `OUTPUT-006-01` | Atomic PlanRepository update API. | `yes` |

##### Outputs

| Output ID | Path or Symbol | Description |
|---|---|---|
| `OUTPUT-008-01` | `src/plan-md/status.ts` | Transition policy and progress derivation. |
| `OUTPUT-008-02` | `PlanRepository.updateTaskStatus()` | Validated status mutation operation. |

##### Subtasks

| Subtask ID | Status | Description |
|---|---|---|
| `SUBTASK-008-01` | `todo` | Define transitions among `todo`, `in_progress`, `blocked`, `done`, and `skipped`. |
| `SUBTASK-008-02` | `todo` | Prevent `in_progress` when required dependencies are not `done`. |
| `SUBTASK-008-03` | `todo` | Recalculate milestone, phase, plan, count, percentage, current-task, and blocked-task fields. |
| `SUBTASK-008-04` | `todo` | Require an explicit reopen action before moving a `done` task backward. |
| `SUBTASK-008-05` | `todo` | Reparse and revalidate the rendered result before atomic replacement. |

##### Acceptance Criteria

| Criterion ID | Status | Criterion |
|---|---|---|
| `AC-008-01` | `todo` | A task cannot start while any declared task dependency is not `done`. |
| `AC-008-02` | `todo` | Completing a task updates all derived summaries deterministically. |
| `AC-008-03` | `todo` | Blocked tasks expose their blocking dependencies in the detail view. |
| `AC-008-04` | `todo` | Invalid external status edits are reported and never silently normalized on read. |
| `AC-008-05` | `todo` | Status updates preserve all non-derived PlanDocument values. |

##### Validation Steps

| Validation ID | Status | Method | Procedure | Expected Result |
|---|---|---|---|---|
| `VAL-008-01` | `todo` | `automated` | Test every allowed and forbidden transition. | Allowed transitions persist; forbidden transitions return stable errors. |
| `VAL-008-02` | `todo` | `automated` | Complete and block tasks across milestone and phase boundaries. | All derived status and progress fields remain correct. |

## Phase PHASE-04: User-facing Features and Integrations

### Phase Metadata

| Field | Value |
|---|---|
| phase_id | `PHASE-04` |
| sequence | `4` |
| category | `user-facing` |
| title | `User-facing Features and Integrations` |
| status | `todo` |
| dependencies | `PHASE-01`, `PHASE-02`, `PHASE-03` |
| objective | `Expose plan creation, browsing, detail inspection, status management, model configuration, and project-local file paths through Pi Toolbox.` |

### Milestone MILESTONE-004: Plan MD Toolbox Experience

#### Milestone Metadata

| Field | Value |
|---|---|
| milestone_id | `MILESTONE-004` |
| sequence | `4` |
| phase_id | `PHASE-04` |
| status | `todo` |
| dependencies | `MILESTONE-001`, `MILESTONE-002`, `MILESTONE-003` |
| completion_rule | `TASK-009, TASK-010, and TASK-011 are done.` |

#### Task TASK-009: Build Plan List, Creation, and Detail Screens

##### Task Metadata

| Field | Value |
|---|---|
| task_id | `TASK-009` |
| sequence | `9` |
| phase_id | `PHASE-04` |
| milestone_id | `MILESTONE-004` |
| status | `todo` |
| priority | `P1` |
| effort | `XL` |
| risk | `medium` |
| dependencies | `TASK-006`, `TASK-007` |
| objective | `Provide a keyboard-first Plan MD screen for entering a request, generating a file, listing project plans, refreshing external edits, and inspecting structured progress.` |

##### Inputs

| Input ID | Source | Description | Required |
|---|---|---|---|
| `INPUT-009-01` | `OUTPUT-006-01` | Plan discovery and read operations. | `yes` |
| `INPUT-009-02` | `OUTPUT-007-01` | Plan-generation workflow. | `yes` |
| `INPUT-009-03` | `src/ui/feature-spec.ts` | Existing async, editor, model-picker, list, and detail interaction patterns. | `yes` |

##### Outputs

| Output ID | Path or Symbol | Description |
|---|---|---|
| `OUTPUT-009-01` | `src/ui/plan-md.ts` | Plan list, create-request editor, generation progress, error, and detail modes. |
| `OUTPUT-009-02` | `Plan MD detail view` | Phase, milestone, task, progress, dependency, risk, and validation presentation. |

##### Subtasks

| Subtask ID | Status | Description |
|---|---|---|
| `SUBTASK-009-01` | `todo` | List valid and invalid plan files with status and progress summaries. |
| `SUBTASK-009-02` | `todo` | Add an editable future-request textarea and model picker. |
| `SUBTASK-009-03` | `todo` | Show cancellable repository inspection and plan generation progress. |
| `SUBTASK-009-04` | `todo` | Open generated plans immediately and display their project-relative path. |
| `SUBTASK-009-05` | `todo` | Add bounded scrolling and compact task summaries for full-screen rendering. |
| `SUBTASK-009-06` | `todo` | Add explicit Refresh so externally edited Markdown is reparsed. |

##### Acceptance Criteria

| Criterion ID | Status | Criterion |
|---|---|---|---|
| `AC-009-01` | `todo` | A user can generate a plan from a request without leaving the Toolbox. |
| `AC-009-02` | `todo` | The generated file path is visible and points beneath the current checkout's `docs/plans`. |
| `AC-009-03` | `todo` | List and detail views show canonical status and progress from the Markdown file. |
| `AC-009-04` | `todo` | Invalid files remain visible with actionable parser diagnostics. |
| `AC-009-05` | `todo` | Escape cancellation never leaves a partial file or changes Pi's editor text. |

##### Validation Steps

| Validation ID | Status | Method | Procedure | Expected Result |
|---|---|---|---|---|
| `VAL-009-01` | `todo` | `user-qa` | Generate, inspect, close, externally edit, refresh, and reopen a plan. | The UI consistently reflects canonical file contents. |
| `VAL-009-02` | `todo` | `resize` | Exercise narrow, short, and resized terminals with long plans. | Content remains bounded and all primary actions remain reachable. |

#### Task TASK-010: Add Interactive Task Status Management

##### Task Metadata

| Field | Value |
|---|---|
| task_id | `TASK-010` |
| sequence | `10` |
| phase_id | `PHASE-04` |
| milestone_id | `MILESTONE-004` |
| status | `todo` |
| priority | `P1` |
| effort | `L` |
| risk | `medium` |
| dependencies | `TASK-008`, `TASK-009` |
| objective | `Let the user select an addressable task, inspect its complete contract, and apply valid status changes to the Markdown source of truth.` |

##### Inputs

| Input ID | Source | Description | Required |
|---|---|---|---|
| `INPUT-010-01` | `OUTPUT-008-02` | Validated task-status update operation. | `yes` |
| `INPUT-010-02` | `OUTPUT-009-02` | Structured task detail view. | `yes` |

##### Outputs

| Output ID | Path or Symbol | Description |
|---|---|---|
| `OUTPUT-010-01` | `Task status selector` | Allowed transitions with dependency-aware descriptions. |
| `OUTPUT-010-02` | `Task detail panel` | Objective, inputs, outputs, dependencies, subtasks, acceptance, validation, priority, effort, and risk. |

##### Subtasks

| Subtask ID | Status | Description |
|---|---|---|
| `SUBTASK-010-01` | `todo` | Navigate tasks by stable ID and canonical sequence. |
| `SUBTASK-010-02` | `todo` | Show dependency status and explain disabled transitions. |
| `SUBTASK-010-03` | `todo` | Confirm destructive transitions such as skip or reopen. |
| `SUBTASK-010-04` | `todo` | Persist, reparse, and rerender after each transition. |
| `SUBTASK-010-05` | `todo` | Keep selection on the same task after a successful update. |

##### Acceptance Criteria

| Criterion ID | Status | Criterion |
|---|---|---|
| `AC-010-01` | `todo` | Every task can be addressed directly by its stable task ID. |
| `AC-010-02` | `todo` | Only allowed status transitions are selectable. |
| `AC-010-03` | `todo` | A successful transition updates task, milestone, phase, plan, and progress fields in one file rewrite. |
| `AC-010-04` | `todo` | A failed transition leaves the file and current UI state unchanged. |

##### Validation Steps

| Validation ID | Status | Method | Procedure | Expected Result |
|---|---|---|---|---|
| `VAL-010-01` | `todo` | `user-qa` | Advance a dependency chain from todo through done. | Tasks unlock only after dependencies complete and progress updates after every transition. |
| `VAL-010-02` | `todo` | `user-qa` | Block, unblock, skip, and reopen representative tasks. | Confirmation, persistence, and derived status follow the specification. |

#### Task TASK-011: Wire Plan MD into Toolbox Configuration and Navigation

##### Task Metadata

| Field | Value |
|---|---|
| task_id | `TASK-011` |
| sequence | `11` |
| phase_id | `PHASE-04` |
| milestone_id | `MILESTONE-004` |
| status | `todo` |
| priority | `P1` |
| effort | `M` |
| risk | `low` |
| dependencies | `TASK-007`, `TASK-009`, `TASK-010` |
| objective | `Register Plan MD as an independent Toolbox workflow with project resolution, model defaults, command access, and runtime composition.` |

##### Inputs

| Input ID | Source | Description | Required |
|---|---|---|---|
| `INPUT-011-01` | `src/domain.ts` | Workflow and view identifiers. | `yes` |
| `INPUT-011-02` | `src/config.ts` | Independent workflow model-profile persistence. | `yes` |
| `INPUT-011-03` | `src/ui/screens.ts` | Screen dependency composition. | `yes` |
| `INPUT-011-04` | `src/pi/commands.ts` | Slash command registration. | `yes` |

##### Outputs

| Output ID | Path or Symbol | Description |
|---|---|---|
| `OUTPUT-011-01` | `WorkflowId: plan_md` | Independent Plan MD model profile. |
| `OUTPUT-011-02` | `ToolboxView: plan-list` | Plan MD navigation target. |
| `OUTPUT-011-03` | `/tb-plan` | Direct Plan MD command. |
| `OUTPUT-011-04` | `LandingScreen Plan MD item` | Discoverable Toolbox entry. |
| `OUTPUT-011-05` | `ToolboxRuntime Plan MD factories` | Repository and workflow construction for the current checkout. |

##### Subtasks

| Subtask ID | Status | Description |
|---|---|---|
| `SUBTASK-011-01` | `todo` | Extend config parsing and defaults without invalidating existing config files. |
| `SUBTASK-011-02` | `todo` | Add Plan MD to landing navigation and screen factories. |
| `SUBTASK-011-03` | `todo` | Register `/tb-plan` with no conflicting global keyboard shortcut. |
| `SUBTASK-011-04` | `todo` | Resolve the current Git checkout before file access. |
| `SUBTASK-011-05` | `todo` | Update README entry points and workflow documentation. |

##### Acceptance Criteria

| Criterion ID | Status | Criterion |
|---|---|---|
| `AC-011-01` | `todo` | `/tb-plan` and landing navigation open the same Plan MD screen. |
| `AC-011-02` | `todo` | Plan MD model changes do not affect Prompt Polish, Feature Spec, or Implementation defaults. |
| `AC-011-03` | `todo` | Existing configuration without `plan_md` loads successfully. |
| `AC-011-04` | `todo` | Running outside a Git checkout produces an explicit project error and writes no files. |

##### Validation Steps

| Validation ID | Status | Method | Procedure | Expected Result |
|---|---|---|---|---|
| `VAL-011-01` | `todo` | `integration` | Open Plan MD through landing and `/tb-plan` in two repositories. | Each checkout lists and creates only its own `docs/plans` files. |
| `VAL-011-02` | `todo` | `configuration` | Save and reload every workflow's model profile. | All four profiles remain independent and backward compatible. |

## Phase PHASE-05: Testing, Documentation, and Operational Work

### Phase Metadata

| Field | Value |
|---|---|
| phase_id | `PHASE-05` |
| sequence | `5` |
| category | `quality` |
| title | `Testing, Documentation, and Operational Work` |
| status | `todo` |
| dependencies | `PHASE-01`, `PHASE-02`, `PHASE-03`, `PHASE-04` |
| objective | `Prove parser determinism, persistence safety, provider reliability, UI usability, and documented recovery behavior.` |

### Milestone MILESTONE-005: Plan MD Release Readiness

#### Milestone Metadata

| Field | Value |
|---|---|
| milestone_id | `MILESTONE-005` |
| sequence | `5` |
| phase_id | `PHASE-05` |
| status | `todo` |
| dependencies | `MILESTONE-001`, `MILESTONE-002`, `MILESTONE-003`, `MILESTONE-004` |
| completion_rule | `TASK-012 and TASK-013 are done.` |

#### Task TASK-012: Add Automated Contract and Workflow Validation

##### Task Metadata

| Field | Value |
|---|---|
| task_id | `TASK-012` |
| sequence | `12` |
| phase_id | `PHASE-05` |
| milestone_id | `MILESTONE-005` |
| status | `todo` |
| priority | `P0` |
| effort | `XL` |
| risk | `medium` |
| dependencies | `TASK-004`, `TASK-005`, `TASK-006`, `TASK-007`, `TASK-008`, `TASK-009`, `TASK-010`, `TASK-011` |
| objective | `Create repeatable validation for the format contract, round trips, file safety, generation boundaries, status transitions, and core keyboard workflow.` |

##### Inputs

| Input ID | Source | Description | Required |
|---|---|---|---|
| `INPUT-012-01` | `OUTPUT-001-02` | Complete canonical example. | `yes` |
| `INPUT-012-02` | `OUTPUT-004-03` | Stable diagnostics. | `yes` |
| `INPUT-012-03` | `fauxProvider()` | Deterministic model-call test support. | `yes` |

##### Outputs

| Output ID | Path or Symbol | Description |
|---|---|---|
| `OUTPUT-012-01` | `test/plan-md/` | Parser, renderer, schema, repository, workflow, status, and UI-focused tests. |
| `OUTPUT-012-02` | `test/fixtures/plan-md/` | Canonical valid and rule-specific invalid plan files. |
| `OUTPUT-012-03` | `package.json#scripts.test` | Repeatable test command. |

##### Subtasks

| Subtask ID | Status | Description |
|---|---|---|
| `SUBTASK-012-01` | `todo` | Add golden render and semantic round-trip coverage. |
| `SUBTASK-012-02` | `todo` | Add one invalid fixture per required field, allowed value, order, and dependency rule. |
| `SUBTASK-012-03` | `todo` | Add repository atomicity, collision, path traversal, and concurrent update coverage. |
| `SUBTASK-012-04` | `todo` | Add structured-generation success, invalid output, cancellation, and no-partial-file coverage. |
| `SUBTASK-012-05` | `todo` | Add status graph and derived progress coverage. |
| `SUBTASK-012-06` | `todo` | Add focused UI probes for creation, refresh, detail navigation, and status mutation. |

##### Acceptance Criteria

| Criterion ID | Status | Criterion |
|---|---|---|
| `AC-012-01` | `todo` | Every normative plan-md/v1 rule has an automated assertion or fixture. |
| `AC-012-02` | `todo` | Tests run without network access or user credentials. |
| `AC-012-03` | `todo` | Temporary repositories and files are removed after every run. |
| `AC-012-04` | `todo` | `npm test` and `npm run typecheck` pass from a clean checkout. |

##### Validation Steps

| Validation ID | Status | Method | Procedure | Expected Result |
|---|---|---|---|---|
| `VAL-012-01` | `todo` | `automated` | Run `npm test`. | All Plan MD tests pass. |
| `VAL-012-02` | `todo` | `typecheck` | Run `npm run typecheck`. | No TypeScript errors. |
| `VAL-012-03` | `todo` | `repeatability` | Run golden and concurrency suites repeatedly. | Results and rendered bytes remain stable. |

#### Task TASK-013: Document, Exercise, and Release Plan MD

##### Task Metadata

| Field | Value |
|---|---|
| task_id | `TASK-013` |
| sequence | `13` |
| phase_id | `PHASE-05` |
| milestone_id | `MILESTONE-005` |
| status | `todo` |
| priority | `P1` |
| effort | `L` |
| risk | `low` |
| dependencies | `TASK-001`, `TASK-011`, `TASK-012` |
| objective | `Document the user workflow and format contract, complete project-local QA, and define recovery for malformed or conflicting plan files.` |

##### Inputs

| Input ID | Source | Description | Required |
|---|---|---|---|
| `INPUT-013-01` | `OUTPUT-001-01` | Normative format specification. | `yes` |
| `INPUT-013-02` | `OUTPUT-011-03` | Final command and UI entry points. | `yes` |
| `INPUT-013-03` | `OUTPUT-012-01` | Passing automated coverage. | `yes` |

##### Outputs

| Output ID | Path or Symbol | Description |
|---|---|---|
| `OUTPUT-013-01` | `README.md#plan-md` | Creation, location, navigation, status, refresh, and troubleshooting guide. |
| `OUTPUT-013-02` | `docs/plan-md-spec.md` | Final reviewed contract and complete example. |
| `OUTPUT-013-03` | `docs/spec_1.md` | Toolbox product behavior and user-validation checkpoint updates. |
| `OUTPUT-013-04` | `Plan MD QA record` | Recorded user validation for creation, external edits, status updates, and multi-project isolation. |

##### Subtasks

| Subtask ID | Status | Description |
|---|---|---|
| `SUBTASK-013-01` | `todo` | Document filename allocation and the Markdown source-of-truth rule. |
| `SUBTASK-013-02` | `todo` | Document allowed manual edits and parser diagnostic recovery. |
| `SUBTASK-013-03` | `todo` | Exercise two repositories with multiple plans and overlapping titles. |
| `SUBTASK-013-04` | `todo` | Verify generated plans are readable and useful outside Pi. |
| `SUBTASK-013-05` | `todo` | Record remaining limitations and deferred Implementation integration. |

##### Acceptance Criteria

| Criterion ID | Status | Criterion |
|---|---|---|
| `AC-013-01` | `todo` | A user can find every generated plan directly under the current project's `docs/plans` directory. |
| `AC-013-02` | `todo` | Documentation explains how to diagnose and repair an invalid externally edited plan. |
| `AC-013-03` | `todo` | Plan files remain useful in Git review without requiring Pi Toolbox. |
| `AC-013-04` | `todo` | User QA confirms plan creation, refresh, progress inspection, status updates, and project isolation. |
| `AC-013-05` | `todo` | Deferred automatic execution and Feature Spec integration are explicitly identified as non-goals. |

##### Validation Steps

| Validation ID | Status | Method | Procedure | Expected Result |
|---|---|---|---|---|
| `VAL-013-01` | `todo` | `user-qa` | Generate a plan, inspect its file in an editor, update statuses in Toolbox, and review the Git diff. | File location, readability, deterministic updates, and progress are satisfactory. |
| `VAL-013-02` | `todo` | `user-qa` | Corrupt one required field, refresh, repair it, and refresh again. | The UI reports a precise diagnostic and recovers after repair. |
| `VAL-013-03` | `todo` | `release` | Run `npm test`, `npm run typecheck`, and `git diff --check`. | All checks pass and no temporary plan files remain. |

## Completion Criteria

| Criterion ID | Status | Criterion |
|---|---|---|
| `PLAN-AC-001` | `todo` | The Plan MD workflow creates canonical files only at `docs/plans/<idx>_<slug>.md` in the current project checkout. |
| `PLAN-AC-002` | `todo` | Every created file parses and validates under the documented `plan-md/v1` contract. |
| `PLAN-AC-003` | `todo` | Plans follow the fixed bottom-up phase order and contain explicit earlier-only dependencies. |
| `PLAN-AC-004` | `todo` | Users can inspect plan, phase, milestone, and task progress and address tasks by stable ID. |
| `PLAN-AC-005` | `todo` | Users can apply valid status changes while Markdown remains the canonical source of truth. |
| `PLAN-AC-006` | `todo` | External edits are visible after refresh and malformed files produce precise diagnostics. |
| `PLAN-AC-007` | `todo` | Generation is schema-constrained and Markdown rendering is deterministic. |
| `PLAN-AC-008` | `todo` | Automated checks and project-local user QA pass. |
