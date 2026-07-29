# Pi Toolbox — Release 1 Specification

**Status:** Specification 1  
**Artifact:** Pi extension package

## 1. Purpose and scope

Pi Toolbox provides three independent, keyboard-first tools through a shared Pi overlay:

1. **Prompt Polish** improves the text in the Pi editor.
2. **Feature Spec** clarifies and persists a feature specification, tasks, and manual QA checkpoints.
3. **Implementation** discovers approved specifications and starts or resumes their implementation.

The tools share UI infrastructure, but only Feature Spec and Implementation share persistent domain data.

```text
Prompt Polish ── editor text only

Feature Spec ── writes ──┐
                         ├── SQLite
Implementation ── reads ─┘
```

Release 1 does not include a separate terminal pane, web UI, multi-user synchronization, concurrent feature runs, or a general-purpose project manager.

## 2. Foundations

### 2.1 Design principles

- **Independent workflows:** Prompt Polish, Feature Spec, and Implementation do not invoke one another.
- **Explicit integration:** Feature Spec and Implementation communicate through repository interfaces backed by SQLite.
- **Durable state:** Closing an overlay or restarting Pi must not lose specification or implementation state.
- **Explicit transitions:** Workflow statuses change only through validated operations.
- **User control:** Implementation never resumes automatically after a restart, pause, or manual QA checkpoint.
- **Single writer path:** Workflow code changes state through repositories, not ad hoc SQL.
- **Minimal UI:** One shared overlay shell hosts separate workflow views.
- **No inferred completion:** An implementation task completes only through a structured report.
- **Repository-scoped state:** Feature and implementation data always belongs to an identified Git repository.
- **Independent model profiles:** Each workflow owns its model and thinking-effort configuration.
- **User QA only:** Acceptance relies on user-operated QA checkpoints; Release 1 has no unit, integration, or automated code-test suite.

### 2.2 Terminology

- **Requirements interview:** the questions asked while creating a Feature Spec.
- **Manual QA:** user testing performed at implementation checkpoints.
- **Feature:** the durable record connecting an approved specification to implementation work.
- **Run:** one execution of an approved specification revision.

## 3. Persistence

### 3.1 Database

One global SQLite database is the canonical store for every project's Feature Spec and Implementation state. Prompt Polish content is not persisted.

```text
<agent-dir>/pi-toolbox/toolbox.sqlite
```

The database remains outside repositories. Every project-owned row is related, directly or transitively, to a `project_id`; repository queries must always be project-scoped.

### 3.2 Git project identity

Feature Spec and Implementation require the current directory to belong to a Git repository. Prompt Polish remains available outside one.

The extension identifies a project as follows:

1. Resolve the canonical checkout root with `git rev-parse --show-toplevel`.
2. Read `remote.origin.url` through `git config`, rather than parsing `.git/config` directly; this also supports worktrees and `.git` files.
3. Canonicalize the remote by removing credentials, protocol differences, query/fragment data, a trailing slash, and a trailing `.git`. Preserve the host plus full owner/group path so repositories with the same basename do not collide.
4. Use the canonical value, such as `github.com/acme/payments`, as the unique repository key.
5. Derive the display name, such as `payments`, from the final path component.
6. Look up the repository key and create a generated project ID only when it has not been seen before. Record the checkout root as a last-seen checkout, not as project identity.

SSH and HTTPS forms of the same remote normalize to the same key. Moving the checkout or opening another worktree retains project state. A missing `origin` blocks Feature Spec and Implementation with a clear setup message. An origin change creates a new identity until the user explicitly relinks it to an existing project. The extension never merges projects based only on their display names.

### 3.3 Configuration

User settings are stored atomically in:

```text
<agent-dir>/pi-toolbox/config.json
```

The file contains independent Prompt Polish, Feature Spec, and Implementation model profiles. It contains no feature or run state.

### 3.4 Database requirements

- Apply versioned migrations from the first release.
- Enable foreign keys.
- Enable WAL mode and configure a busy timeout.
- Perform workflow transitions in transactions.
- Use stable generated IDs rather than titles, paths, or repository names as database identifiers.
- Enforce uniqueness for canonical repository keys and normalized checkout roots.
- Keep approved specification revisions immutable.
- Do not store model reasoning text.
- Roll back partial approvals, task reports, and QA results.

### 3.5 Tables

| Table | Purpose |
|---|---|
| `schema_migrations` | Applied schema versions |
| `projects` | Stable generated project IDs and display metadata |
| `project_identities` | Unique canonical Git remote keys, including explicitly relinked aliases |
| `project_checkouts` | Last-seen normalized checkout roots for each project |
| `feature_specs` | Feature metadata and lifecycle state |
| `spec_revisions` | Immutable generated or edited specification revisions |
| `spec_questions` | Requirements interview questions |
| `spec_answers` | Persisted answers |
| `tasks` | Implementation and manual QA tasks |
| `task_dependencies` | Task ordering constraints |
| `implementation_runs` | Run state, model profile, checkout, and associated Pi session |
| `task_attempts` | Structured agent reports and acceptance evidence |
| `qa_results` | User QA reports |
| `workflow_events` | Auditable state-transition history |

## 4. Data model

### 4.1 Project

```typescript
interface Project {
  id: string;
  name: string;
  primaryRepositoryKey: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectCheckout {
  id: string;
  projectId: string;
  root: string;
  lastSeenAt: string;
}
```

`Project.id` is generated and stable. Neither the display name nor checkout path is an identifier. A run is bound to the checkout in which it starts so agent work always targets an explicit repository root.

### 4.2 Workflow model profile

```typescript
type WorkflowId = "prompt_polish" | "feature_spec" | "implementation";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface WorkflowModelProfile {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}
```

A profile stores model identity and thinking effort together. Persisted drafts and runs snapshot the profile they use so resumable work remains deterministic; changing a default does not silently alter existing work.

### 4.3 Feature specification

```typescript
type SpecStage = "draft" | "interview" | "review" | "approved";

type ImplementationStatus =
  | "todo"
  | "in_progress"
  | "paused"
  | "qa_pending"
  | "done";

interface FeatureSpec {
  id: string;
  projectId: string;
  title: string;
  stage: SpecStage;
  modelProfile: WorkflowModelProfile;
  implementationStatus?: ImplementationStatus;
  approvedRevisionId?: string;
  createdAt: string;
  updatedAt: string;
}
```

`implementationStatus` is absent until approval. Approval creates tasks and sets it to `todo` in one transaction.

### 4.4 Specification revision

An approved revision contains:

- problem statement;
- goals and non-goals;
- user-visible behavior;
- constraints and decisions;
- acceptance criteria;
- affected repository areas;
- risks and unresolved items;
- ordered tasks and dependencies;
- manual QA checkpoints.

Editing an approved specification creates a new revision. A run remains tied to the revision with which it started.

### 4.5 Tasks

```typescript
type TaskKind = "implementation" | "user_qa";
type TaskStatus = "todo" | "in_progress" | "done";

interface Task {
  id: string;
  revisionId: string;
  kind: TaskKind;
  title: string;
  objective: string;
  context: string;
  acceptanceCriteria: string[];
  order: number;
  status: TaskStatus;
}
```

A `user_qa` task also stores:

- prerequisite tasks;
- checkpoint rationale;
- setup instructions;
- scenarios;
- expected results;
- stress areas;
- failure-report guidance.

QA checkpoints follow meaningful vertical slices rather than a fixed task interval. They are the acceptance mechanism for implemented work. Feature Spec must not generate unit, integration, snapshot, or mock-based test tasks.

### 4.6 Implementation run

A run records:

- feature and approved revision IDs;
- current feature status;
- associated project checkout root and every Pi session identifier exposed by the runtime;
- selected model profile;
- current task;
- pause or failure reason;
- start and update timestamps.

Release 1 permits exactly one active feature run per project.

### 4.7 Status transitions

```text
todo
  └── start ──────────────> in_progress

in_progress
  ├── pause/block ────────> paused
  ├── QA checkpoint ──────> qa_pending
  └── all work complete ──> done

paused
  └── resume ─────────────> in_progress

qa_pending
  ├── pass ───────────────> in_progress
  └── fail/remediation ───> in_progress
```

A feature reaches `done` only after every required task and QA checkpoint is complete.

## 5. Shared interfaces

Workflow services depend on interfaces, not SQLite details.

```typescript
interface GitProjectResolver {
  resolve(cwd: string): Promise<ResolvedGitProject>;
}

interface ProjectRepository {
  findByRepositoryKey(key: string): Promise<Project | undefined>;
  create(input: CreateProjectInput): Promise<Project>;
  recordCheckout(input: RecordCheckoutInput): Promise<ProjectCheckout>;
  relinkIdentity(input: RelinkProjectInput): Promise<void>;
}

interface FeatureSpecRepository {
  createDraft(input: CreateDraftInput): Promise<FeatureSpec>;
  saveAnswer(input: SaveAnswerInput): Promise<void>;
  saveReview(input: SaveReviewInput): Promise<SpecRevision>;
  approve(input: ApproveSpecInput): Promise<ApprovedFeatureSpec>;
  getById(id: string): Promise<FeatureSpec | undefined>;
  listDrafts(projectId: string): Promise<FeatureSpec[]>;
}

interface ImplementationRepository {
  listCandidates(projectId: string): Promise<ImplementationCandidate[]>;
  start(input: StartRunInput): Promise<ImplementationRun>;
  getActiveRun(projectId: string): Promise<ImplementationRun | undefined>;
  getNextReadyTask(runId: string): Promise<Task | undefined>;
  recordTaskReport(input: TaskReportInput): Promise<void>;
  pause(input: PauseRunInput): Promise<void>;
  requestQa(input: RequestQaInput): Promise<void>;
  submitQaResult(input: QaResultInput): Promise<void>;
}
```

Rules:

- Git identity is resolved once at workflow entry and converted to a stable `projectId` before querying feature data.
- Feature Spec never calls Implementation services.
- Implementation only consumes approved revisions.
- Repository methods validate the expected current state.
- The database is canonical; Pi session entries contain only lightweight references such as a run ID.

## 6. Model integration

### 6.1 Independent profiles

Each workflow has its own `WorkflowModelProfile`. Changing one profile does not affect the defaults of another.

Default profiles:

| Workflow | Model | Thinking |
|---|---|---|
| Prompt Polish | `openai/gpt-5.6-luna` | `high` |
| Feature Spec | Current Pi model, captured and persisted on first use | `high` |
| Implementation | Current Pi model, captured and persisted on first use | `high` |

The Toolbox UI edits these defaults. Each workflow screen displays its current model and thinking level and provides a keyboard-accessible picker populated from `ctx.modelRegistry`. The picker provides `Use Once` and `Save as Default` actions.

Prompt Polish captures the selected profile for one invocation. A Feature Spec draft and an Implementation run persist their selected profiles for restart-safe resumption. The start and resume screens provide an explicit action to replace the saved profile.

### 6.2 Execution behavior

Prompt Polish and Feature Spec make isolated model calls with their selected profiles and must not switch the active Pi model.

Implementation uses the active Pi agent. Before dispatching each task, the extension applies the run's model and thinking level with `pi.setModel()` and `pi.setThinkingLevel()`. The UI states that starting or resuming a run temporarily changes the active agent configuration. On pause or completion, the extension restores the pre-run configuration when the user has not changed the active configuration during the run.

All profiles are resolved through Pi's model registry and authentication system. Unsupported thinking levels, unavailable models, and missing authentication open the picker or show an explicit error; there is no silent fallback.

## 7. Pi integration

The extension uses:

- `pi.registerShortcut()` for keyboard entry points;
- `pi.registerCommand()` for fallback commands;
- `ctx.ui.custom(..., { overlay: true })` for the Toolbox UI;
- `OverlayHandle` for focus and visibility;
- `ctx.ui.getEditorText()` and `setEditorText()` for Prompt Polish;
- `pi.registerTool()` for structured task completion;
- `pi.sendUserMessage()` to dispatch implementation tasks;
- `agent_settled` to advance the outer task loop;
- `session_start` and `session_shutdown` for recovery and cleanup;
- `ctx.modelRegistry` for model discovery and authentication;
- `pi.setModel()` and `pi.setThinkingLevel()` for Implementation runs;
- `pi.events` for same-process UI refresh notifications.

## 8. Shared overlay

### 8.1 Entry points

| Entry point | Opened view |
|---|---|
| `ctrl+shift+enter` | Landing |
| `ctrl+enter` | Prompt Polish |
| `/toolbox` | Landing |
| `/tb-polish` | Prompt Polish |
| `/tb-spec` | Feature Spec |
| `/tb-implement` | Implementation |

The key names registered with Pi are `ctrl+shift+enter` and `ctrl+enter`.

All entry points use one overlay controller:

```text
openOverlay({ view: "landing" })
openOverlay({ view: "polish" })
openOverlay({ view: "feature-spec-list" })
openOverlay({ view: "implementation-list" })
```

Direct Prompt Polish entry must open the same view used by landing navigation.

### 8.2 Toggle and navigation

- `ctrl+shift+enter` opens the landing when closed and closes the overlay when open.
- `ctrl+enter` opens or navigates to Prompt Polish.
- `up` and `down` change list selection.
- `enter` opens or confirms.
- `escape` goes back; from the landing it closes.
- Closing restores focus to the Pi editor.
- Editor text is preserved unless Prompt Polish is explicitly accepted.

The overlay spike verifies modified Enter support in the active terminal. Tmux environments use Pi's documented extended-key setup. Slash commands guarantee access when the terminal does not emit distinct modified Enter sequences.

### 8.3 Layout

Layout:

```typescript
{
  overlay: true,
  overlayOptions: {
    anchor: "right-center",
    width: "45%",
    minWidth: 50,
    maxHeight: "90%",
    margin: 1
  }
}
```

The overlay uses Pi's active theme, remains within the supplied render width, and adapts to narrow terminals.

Landing example:

```text
╭─ Pi Toolbox ─────────────────────╮
│ Project: acme/payments           │
│                                 │
│ > Prompt Polish                 │
│   Feature Spec                  │
│   Implementation                │
│                                 │
│ ↑↓ navigate  Enter open  Esc    │
╰─────────────────────────────────╯
```

The landing and project-owned screens show the resolved owner/group and repository name, not only the basename. This makes accidental cross-project work visible.

### 8.4 Model controls

Prompt Polish, Feature Spec, and Implementation screens show a compact model/effort selector. The reusable picker writes to the selected workflow's independent profile. Every action works by keyboard; mouse support is outside Release 1 scope.

### 8.5 Screen stack

```text
landing
├── polish
├── feature-spec-list
│   ├── feature-spec-interview
│   └── feature-spec-review
└── implementation-list
    ├── implementation-detail
    └── qa-report
```

### 8.6 Overlay spike

Before building full workflows, verify:

1. Both shortcuts are distinguishable and reliable.
2. Focus returns correctly after close and nested dialogs.
3. Agent events refresh a visible overlay.
4. A visible overlay releases focus while the agent runs.
5. Escape does not accidentally abort the agent.
6. Resize and narrow-terminal rendering remain valid.

When a persistent overlay interferes with agent interaction, starting implementation closes it and shows progress in a compact Pi widget. Reopening the overlay reconstructs state from SQLite.

## 9. Prompt Polish workflow

Prompt Polish is standalone and never reads or writes feature state.

### 9.1 Input and model call

1. Capture `ctx.ui.getEditorText()` when the view opens.
2. Reject empty input without calling the model.
3. Keep the editor unchanged during generation.
4. Let the user keep or change the Prompt Polish model profile.
5. Resolve its model and authentication.
6. Generate a polished prompt with cancellation support.

The model must preserve intent, scope, constraints, and examples; improve terminology and structure; expose ambiguity; avoid invented requirements; and return only the polished prompt.

### 9.2 Result actions

```text
Accept | Edit | Retry | Cancel
```

- **Accept:** replace editor text and close.
- **Edit:** modify the generated result before accepting.
- **Retry:** repeat using the captured source input.
- **Cancel:** close without changing the editor.

The view shows both source and polished text using tabs or stacked panels when side-by-side rendering is too narrow.

## 10. Feature Spec workflow

### 10.1 List and creation

The Feature Spec view lists resumable drafts, interviews, reviews, and approved specifications for the current Git project. The view provides `Create Draft` and `Resume` actions. New drafts snapshot the selected Feature Spec model profile.

Approved specifications are reference-only here; implementation actions belong to the Implementation view.

### 10.2 Requirements interview

The interview asks one to ten questions, one at a time:

1. Evaluate the draft and all recorded answers.
2. Ask the highest-value unresolved question.
3. Offer choices for bounded decisions and always permit custom text.
4. Persist the answer immediately.
5. Continue only while a material ambiguity remains.
6. Stop when ready or after the tenth answer.

Questions focus on behavior, scope, trade-offs, compatibility, UX, failures, and acceptance expectations. The workflow inspects repository facts and never asks the user to provide discoverable information.

The interview is resumable after cancellation or restart.

### 10.3 Review and approval

The generated revision contains the fields defined in Section 4.4 and structured tasks from Section 4.5.

The review screen provides `Edit`, `Request Refinement`, `Approve`, and `Close in Review` actions. Approval atomically:

1. freezes the approved revision;
2. saves its tasks and dependencies;
3. sets the feature stage to `approved`;
4. sets implementation status to `todo`.

It does not start implementation.

## 11. Implementation workflow

### 11.1 Candidate list

Every time the view opens, it resolves the current Git project, queries SQLite only for that project, and groups approved features by:

```text
TODO
IN PROGRESS
PAUSED
QA PENDING
DONE
```

The header shows the Implementation model and thinking level. Start snapshots the selected profile on the run; Resume shows the saved profile and allows an explicit change before dispatch.

Actions:

| Status | Actions |
|---|---|
| `todo` | Inspect, Start |
| `in_progress` | Inspect, Continue, Pause |
| `paused` | Inspect, Resume |
| `qa_pending` | Inspect checkpoint, Submit QA result |
| `done` | Inspect history |

### 11.2 Outer task loop

Pi manages the inner model/tool loop. Pi Toolbox manages one run across tasks:

```text
claim next ready task
  -> send focused prompt to active Pi agent
  -> receive structured task report
  -> persist result
  -> wait for agent_settled
  -> dispatch next task or enter QA pending
```

A task prompt includes the approved revision ID, concise feature context, current task, relevant completed-task summaries, acceptance criteria, and required acceptance evidence. The agent remains responsible for inspecting the repository.

### 11.3 Structured task report

The agent completes or blocks a task through `toolbox_task_report` with:

- run ID;
- task ID;
- result: `completed` or `blocked`;
- summary;
- changed files;
- evidence against the acceptance criteria;
- unresolved concerns.

A valid completion updates the task transactionally. A blocked report pauses the run. If the agent settles without a valid report, the run pauses instead of inferring success from prose.

### 11.4 Manual QA

When the next task is `user_qa`:

1. stop task dispatch;
2. set the feature to `qa_pending`;
3. show setup, scenarios, stress areas, and expected results;
4. wait for an explicit pass or fail report.

A pass completes the checkpoint and returns the run to `in_progress`. A failure records the user's notes, creates associated remediation work, and returns to `in_progress`. No model work continues while `qa_pending`.

### 11.5 Pause and recovery

- Pausing an active agent turn requires confirmation before aborting it.
- Closing only the overlay does not pause the run.
- Restarted or stale `in_progress` work is shown as recoverable.
- Resume always requires user action.
- State is reconstructed from SQLite on `session_start`.

## 12. Development QA checkpoints

Development pauses at three user-validation gates. These checkpoints are performed by the user, validate Pi Toolbox itself, and are separate from the `user_qa` tasks generated for implemented features. No other acceptance mechanism is required.

### 12.1 Overlay and Prompt Polish

**When:** The overlay shell, shortcuts, navigation, and Prompt Polish work end-to-end.

**User validation:**

- `ctrl+shift+enter` toggles the landing overlay.
- Keyboard navigation, Back, Escape, and focus restoration feel natural.
- `ctrl+enter` and landing navigation open the same Prompt Polish view.
- Cancel preserves editor text; Accept replaces it correctly.
- Polishing improves clarity without changing intent or scope.
- Changing the Prompt Polish model or effort affects Polish only; `Save as Default` persists the selection.

**Gate:** Confirm or adjust the overlay interaction model before building the Feature Spec screens on it.

### 12.2 Feature Spec persistence boundary

**When:** Interview, review, approval, persistence, and Implementation candidate listing work end-to-end.

**User validation:**

1. Create a small realistic feature.
2. Answer several generated questions.
3. Stop, restart Pi, and resume the interview.
4. Review and edit the resulting specification.
5. Approve it and confirm that Implementation lists it as `todo`.
6. Inspect whether its tasks and QA checkpoints are appropriately scoped.
7. Confirm the draft retains its chosen Feature Spec model profile after restart.

**Gate:** Confirm the interview quality and Feature Spec-to-Implementation data contract before building agent orchestration.

### 12.3 Implementation control loop

**When:** Sequential dispatch, structured reporting, pause, and resume work with a small two- or three-task feature.

**User validation:**

- Select an Implementation model and effort, start a `todo` feature, and confirm Pi applies that profile.
- Inspect the task sent to the agent.
- Confirm the agent remains focused on the current task.
- Confirm completion requires `toolbox_task_report`.
- Pause, close and reopen the overlay, then resume.
- Restart Pi and confirm the run is recoverable but does not resume automatically.
- Confirm the next task starts only after the current task report is persisted.

**Gate:** Confirm the orchestration and recovery model before release hardening.

## 13. Project structure

```text
pi-toolbox/
├── package.json
├── docs/
│   └── spec_1.md
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── domain.ts
│   ├── db/
│   │   ├── database.ts
│   │   ├── migrations.ts
│   │   └── repositories.ts
│   ├── project/
│   │   └── git-identity.ts
│   ├── model/
│   │   ├── client.ts
│   │   ├── prompts.ts
│   │   └── schemas.ts
│   ├── workflows/
│   │   ├── polish.ts
│   │   ├── feature-spec.ts
│   │   └── implementation.ts
│   ├── pi/
│   │   ├── commands.ts
│   │   ├── shortcuts.ts
│   │   ├── tools.ts
│   │   └── events.ts
│   └── ui/
│       ├── overlay.ts
│       ├── navigation.ts
│       ├── landing.ts
│       ├── model-picker.ts
│       ├── polish.ts
│       ├── feature-spec.ts
│       └── implementation.ts
```

Modules are cohesive and contain no trivial wrappers or comments that merely restate code.

## 14. Release acceptance

Release 1 is accepted only after the user completes the three development QA checkpoints in Section 12 and approves their outcomes. Any failed checkpoint is corrected and repeated before development continues.

Final acceptance confirms that all three tools are keyboard-accessible through the overlay, Prompt Polish remains standalone, multiple Git projects remain isolated in one database, every workflow supports independent model and thinking-effort selection, approved specs are durably discoverable by Implementation, sequential runs support safe pause and resume, and required user QA gates completion.
