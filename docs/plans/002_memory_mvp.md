# Memory MVP

Status: done
Created: 2026-08-26

## Goal

Memory keeps a current knowledge base about the user and their work. It runs in the background during normal Pi conversations. The user does not need to call a tool or open a Toolbox screen.

The knowledge base lives at `~/work-memory`. It is a Git repository that follows Open Knowledge Format (OKF) v0.2.

Memory stores only explicit facts extracted from user or agent messages.

## Knowledge base

The existing directories define the first topic set:

- `coding`
- `docs-style`
- `personal-principles`
- `projects`
- `team`

Each knowledge concept is a Markdown file with YAML frontmatter.


The knowledge base represents the latest known state:

- New knowledge is added to the relevant concept.
- A fact that is already present causes no change.
- A newer contradiction replaces the older fact.
- Git provides the repository's history.

Root and topic `index.md` files are maintained when concepts are added, moved, or removed.

### Concept frontmatter

Memory uses a simplified variant of the OKF frontmatter.

```yaml
---
type: <concept type>
title: <display name>
description: <one-line summary>
tags: [<topic>, <optional tags>]
---
```

`type` uses a clear concept name such as `Preference`, `Project`, `Team`, `Principle`, or `Coding Practice`.

## Facts

A fact is one direct statement extracted from a conversation event. It must be understandable on its own.

Examples:

- `The pi-toolbox project uses TypeScript.`
- `The user prefers simple technical English in documentation.`
- `The Memory knowledge base is stored at ~/work-memory.`

Instructions can contain facts about a project or workflow. Feedback can contain facts about user preferences. The extractor separates those facts from the action requested in the message.

`sent_by` identifies who sent the message:

- `user`: a user submission.
- `agent`: the end of an agent run.

## SQLite storage

The database is stored under the Pi Toolbox data directory, outside the knowledge-base repository. It contains the original messages and the fact queue. SQLite foreign-key enforcement is enabled for every connection.

### Original messages

Every event is stored before extraction starts. `content` contains the original text passed to the extractor. Messages are retained indefinitely so every extraction input remains available for debugging.

```sql
CREATE TABLE memory_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pi_session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    sent_by TEXT NOT NULL
        CHECK (sent_by IN ('user', 'agent')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX memory_messages_session_idx
ON memory_messages (pi_session_id, id);
```

A message remains stored when extraction produces no facts or fails. The table has no extraction status field.

### Fact queue

The queue separates fact extraction from knowledge-base updates. Extractors can finish asynchronously while one curator updates the files at a time. Every fact references its original message.

```sql
CREATE TABLE memory_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL
        REFERENCES memory_messages (id),
    pi_session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    sent_by TEXT NOT NULL
        CHECK (sent_by IN ('user', 'agent')),
    topic TEXT NOT NULL,
    fact TEXT NOT NULL,
    created_at TEXT NOT NULL,
    processed_at TEXT
) STRICT;
```

`cwd` is converted to a canonical absolute path before insertion. `topic` must be one of the configured knowledge-base topics. Timestamps use ISO 8601 UTC values.

Processed rows remain in the table with `processed_at` set. They can be inspected for operational debugging.

### Queue indices

The common queries find the oldest pending fact, load pending facts for one working directory, and trace facts to their original message.

```sql
CREATE INDEX memory_queue_pending_fifo_idx
ON memory_queue (id)
WHERE processed_at IS NULL;

CREATE INDEX memory_queue_pending_cwd_idx
ON memory_queue (cwd, id)
WHERE processed_at IS NULL;

CREATE INDEX memory_queue_message_idx
ON memory_queue (message_id, id);
```

## Agents

Memory uses two isolated agent roles with `openai-codex/gpt-5.6-luna`.

### Extractor

Thinking effort: `none` (`off` in the current Pi API).

The extractor receives one stored message and returns a validated list of facts. For each fact it:

1. Checks that the statement is explicit.
2. Assigns one topic.
3. Writes one queue row linked to the original message, with the Pi session, working directory, sender, and creation time.

An event with no durable facts produces no queue rows. Its original message remains stored.

1 event -> [0-N] facts.

#### Extractor prompt

```text
You extract durable facts from a conversation message, sent either by the user or a coding agent.

Rules:
- Extract only facts stated directly in the event.
- Ignore requests and actions unless they also state a fact.
- Write each fact as one clear, self-contained sentence, using simplified english.
- Assign exactly one topic: coding, docs-style, personal-principles, projects, or team.
- Use the working directory only to name a project mentioned in the event. Never extract the directory itself as a fact.
- Return JSON only. Return an empty facts list when there are no facts.

Output:
{"facts":[{"topic":"projects","fact":"Uses TypeScript."}]}

Working directory: {{cwd}}
Sent by: {{sent_by}}

Event:
{{content}}
```

### Curator

Thinking effort: `medium`.

The curator receives a batch from one `cwd`. It works from `~/work-memory`, reads the existing concepts, and applies each fact in queue order. It may create, update, link, move, or deprecate concepts as needed to keep the bundle clear and current.

The curator runs in an isolated Pi process with extension discovery disabled. This prevents its own prompt and agent turn from triggering Memory again.

The curator edits complete concept documents and the root index directly. The surrounding application validates and commits the changes.

#### Curator prompt

```text
You maintain the knowledge base in the current directory.

The input facts belong to one project and are ordered from oldest to newest.

For each fact:
- Add it when it is new.
- Do nothing when it is already current.
- Replace older knowledge when it contradicts a newer fact.
- Keep unrelated current knowledge.
- Put it in its assigned topic and the clearest concept file.

Read the relevant concepts, then use edit to update each complete target document, including its frontmatter when needed. Use write for new concepts. Keep frontmatter valid YAML and quote string values that contain whitespace. Update index.md when concepts change.

Project working directory: {{cwd}}

Facts:
{{facts}}
```

## Event flow

Memory runs after every user submission and on every `agent_end` event.

```text
Pi event
  -> insert original message into SQLite
  -> extractor agent
  -> validate explicit facts
  -> insert linked facts into SQLite
  -> wake queue consumer

Queue consumer
  -> select one cwd batch
  -> curator agent updates ~/work-memory
  -> validate OKF files
  -> commit changed files with "updated" message
  -> set processed_at
```

The local message insert completes before the hook returns. Extraction runs in the background without delaying the main coding agent. A session start also wakes the consumer so pending facts survive a previous interruption.

## Batch consumption

A batch contains facts from one `cwd` only. Facts are ordered by queue `id` and bounded by both row count (10 facts max) and serialized input size. The first implementation will use internal constants for these limits.

The consumer follows this cycle:

1. Find the `cwd` of the oldest pending row.
2. Load a bounded set of pending rows for that `cwd`.
3. Run one curator agent with the ordered facts.
4. Validate every changed OKF document.
5. Commit when files changed with "updated" as message.
6. Set `processed_at` on the selected rows.
7. Continue while pending rows remain.

New facts can enter SQLite while the curator is running. They are handled by a later batch.

A module-level single-flight guard prevents overlapping consumers in one Pi process. An exclusive lock beside the SQLite database prevents different Pi processes from updating the knowledge base together. The lock covers curation, validation, and commit, but does not block queue inserts. A lock left by a stopped process is treated as stale after its owner is no longer running.

## Git behavior

The knowledge-base repository is changed only by the curator flow.

- No file change means no commit.
- One successful batch creates at most one commit.
- Queue rows are marked as processed only after a successful commit or a confirmed no-op.
- A curator, validation, or Git failure leaves the rows pending.
- The consumer stops after a failure so later facts cannot pass an unresolved earlier batch.

A retry is idempotent. If files already contain the facts, the curator performs a no-op and the rows can be marked as processed.

## Failure handling

Memory failures do not fail the user's main agent turn. Errors are stored in the SQLite `logs` table with `id`, `msg`, and `created_at`; contextual fields are serialized in `msg`. A stored original message remains available when extraction fails.

Boundary validation is strict:

- Extractor output must match the fact schema.
- Queue topics and senders must be valid.
- The knowledge-base path must remain under `~/work-memory`.
- Changed concept documents must satisfy OKF v0.2 minimum rules.
- Git must succeed before changed rows are completed.

## MVP features

- **Automatic capture:** Memory stores user submissions and completed agent runs, then extracts from them in the background.
- **Inspectable inputs:** Original messages are retained indefinitely and linked to their extracted facts.
- **Explicit knowledge:** It stores direct facts under the five initial topics and rejects inference.
- **Current-state curation:** New facts update OKF concepts, duplicates are ignored, and newer contradictions replace older values.
- **Project-aware processing:** Facts are queued durably and curated in serialized batches for one working directory.
- **Recoverable operation:** Successful file changes are committed to Git.

## Delivery plan

### Phase 1: Storage and knowledge-base boundaries

Status: done

Build the SQLite store, queue schema, indices, topic validation, canonical path handling, and OKF validation boundary.

Tasks:

- Status: done - Add Memory configuration and fixed MVP paths.
- Status: done - Add SQLite initialization and queue operations.
- Status: done - Add the pending-row queries and `cwd` batch selection.
- Status: done - Add minimum OKF document validation.

QA checkpoint:

- Insert facts for several sessions and working directories.
- Confirm pending queries use the partial indices.
- Mark one batch as processed and confirm it leaves the pending result set.
- Reject invalid topics, senders, timestamps, and paths outside the KB.

### Phase 2: Fact extraction

Status: done

Connect the lightweight extractor to user submissions and `agent_end` without blocking the main agent.

Tasks:

- Status: done - Define the extractor prompt and validated output shape.
- Status: done - Run the extractor with `gpt-5.6-luna` and no thinking.
- Status: done - Register both Pi lifecycle handlers.
- Status: done - Persist every original message before extraction.
- Status: done - Link each extracted fact to its original message.
- Status: done - Wake the consumer after facts are queued.

QA checkpoint:

- Submit instructions containing project facts and requested actions.
- Submit feedback containing an explicit preference.
- Confirm requests without durable facts store a message and create no queue rows.
- Confirm indirect or inferred statements are not queued.
- Force extraction failure and confirm the original message remains stored.
- Confirm both senders are recorded and every fact links to its original message.

### Phase 3: Curation and commits

Status: done

Consume `cwd` batches through the curator and update the knowledge base safely.

Tasks:

- Status: done - Add the single-flight consumer and cross-process lock.
- Status: done - Build bounded batches for one canonical `cwd`.
- Status: done - Run the isolated curator with medium thinking and Memory disabled.
- Status: done - Validate changes and commit only when required.
- Status: done - Set `processed_at` after commit or no-op.

QA checkpoint:

- Add new, duplicate, and contradictory facts for one project.
- Confirm the KB contains only the latest state.
- Confirm duplicates produce no commit.
- Start two Pi processes and confirm only one curator changes the KB at a time.
- Force curator, validation, and Git failures and confirm rows remain pending.
