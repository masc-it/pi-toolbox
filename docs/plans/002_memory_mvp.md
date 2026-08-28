# Memory MVP

Status: done
Created: 2026-08-26

## Goal

Memory keeps a current knowledge base about the user and their work. It runs in the background during normal Pi conversations. The user does not need to call a tool or open a Toolbox screen.

The knowledge base lives at `~/work-memory`. It is a Git repository that follows Open Knowledge Format (OKF) v0.2. Memory initializes the repository, root index, and topic directories when the path does not exist.

Memory stores only durable facts extracted from complete conversation exchanges. An exchange contains the user messages and successful agent responses produced before Pi becomes fully settled.

## Knowledge base

The initial directories define the first topics:

- `coding`
- `docs-style`
- `personal-principles`
- `projects`
- `team`

Each knowledge concept is a Markdown file with YAML frontmatter. The extractor receives the current top-level directories as topics and may propose a new lowercase kebab-case topic when none applies.

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

A fact is one durable statement extracted from a settled conversation exchange. It must be understandable on its own and identify whether it is supported by the user, the agent, or both.

Examples:

- `The pi-toolbox project uses TypeScript.`
- `The user prefers simple technical English in documentation.`
- `The Memory knowledge base is stored at ~/work-memory.`

Instructions can contain facts about a project or workflow. Feedback can contain facts about user preferences. Agent explanations can contain durable architecture, behavior, constraints, workflows, terminology, and gotchas. The extractor uses the complete exchange to separate those facts from requests, advice, execution narration, and verification evidence.

`supported_by` records the evidence for each extracted fact:

- `user`: directly supported by user content.
- `agent`: directly supported by agent content.
- `both`: directly supported by both roles.

## SQLite storage

The database is stored under the Pi Toolbox data directory, outside the knowledge-base repository. It contains the original messages and the fact queue. SQLite foreign-key enforcement is enabled for every connection. The exchange schema is a clean break: a legacy unversioned Memory database is dropped and recreated on the first startup instead of being migrated.

### Conversation exchanges

A finalized user `message_end` opens an exchange. Additional user messages and successful terminal agent responses are appended from the same authoritative event stream in order. This includes steering and queued follow-ups. `agent_settled` closes the exchange after retries, compaction retries, steering, and queued follow-ups have finished.

```sql
CREATE TABLE memory_exchanges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pi_session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    started_at TEXT NOT NULL,
    settled_at TEXT,
    extracted_at TEXT
) STRICT;

CREATE TABLE memory_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange_id INTEGER NOT NULL
        REFERENCES memory_exchanges (id),
    position INTEGER NOT NULL,
    sent_by TEXT NOT NULL
        CHECK (sent_by IN ('user', 'agent')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (exchange_id, position)
) STRICT;
```

Settled exchanges with no `extracted_at` value are retried after a later wake or session start. Completing extraction and inserting its facts happen in one transaction. An empty extraction still sets `extracted_at`.

### Fact queue

The queue separates exchange extraction from knowledge-base updates. Extraction runs once per settled exchange while one curator updates the files at a time. Every fact references its complete source exchange.

```sql
CREATE TABLE memory_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange_id INTEGER NOT NULL
        REFERENCES memory_exchanges (id),
    pi_session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    supported_by TEXT NOT NULL
        CHECK (supported_by IN ('user', 'agent', 'both')),
    topic TEXT NOT NULL,
    fact TEXT NOT NULL,
    created_at TEXT NOT NULL,
    processed_at TEXT
) STRICT;
```

`cwd` is converted to a canonical absolute path before insertion. `topic` must be one of the configured knowledge-base topics. Timestamps use ISO 8601 UTC values.

Processed rows remain in the table with `processed_at` set. They can be inspected for operational debugging.

### Queue indices

The common queries find the oldest unextracted exchange, load pending facts for one working directory, and trace facts to their source exchange.

```sql
CREATE INDEX memory_queue_pending_fifo_idx
ON memory_queue (id)
WHERE processed_at IS NULL;

CREATE INDEX memory_queue_pending_cwd_idx
ON memory_queue (cwd, id)
WHERE processed_at IS NULL;

CREATE INDEX memory_queue_exchange_idx
ON memory_queue (exchange_id, id);
```

## Agents

Memory uses two isolated agent roles with `openai-codex/gpt-5.6-luna`.

### Extractor

Thinking effort: `none` (`off` in the current Pi API).

The extractor receives one settled exchange and returns a validated list of durable facts. It uses the user messages and successful agent responses together to distinguish explanations, implementations, advice, verification, preferences, and decisions.

For each fact it:

1. Checks that the statement is directly supported by the exchange.
2. Records whether the supporting content came from the user, agent, or both.
3. Assigns an existing topic or proposes a new one.
4. Writes one queue row linked to the complete exchange.

An exchange with no durable facts produces no queue rows. The exchange remains stored and is marked extracted.

1 settled exchange -> [0-N] facts.

#### Extractor prompt

```text
You extract durable current knowledge from a complete conversation exchange between a user and a coding agent.

First identify the exchange purpose:
- Explanations may establish stable project knowledge.
- Implementations may establish a durable resulting state.
- Advice and design exploration remain proposals unless the user accepts them.
- Verification results are transient and are not stored.
- Explicit durable user preferences, decisions, conventions, and constraints are stored.

A request does not prove that the requested state exists. Ignore execution narration, task progress, commit hashes, generated artifact details, temporary local state, and facts that only say an action happened. Agent statements cannot establish user preferences or accepted decisions.

Emit one canonical fact when both roles repeat the same information. Preserve exact identifiers, qualifiers, scope, and negation. Set supportedBy to user, agent, or both. Assign one available topic, or propose a concise lowercase kebab-case topic when none applies. Return JSON only and use an empty facts list when there is no durable knowledge.

Available topics:
{{memory_topics}}

Output:
{"facts":[{"supportedBy":"agent","topic":"projects","fact":"OPM V2 requests bypass the VLM worker."}]}

Working directory: {{cwd}}
Conversation exchange: {{ordered_messages}}
```

### Curator

Thinking effort: `medium`.

The curator receives a batch from one `cwd`. It works from `~/work-memory`, reads the existing concepts, and applies each fact in queue order. It may create, update, link, move, or deprecate concepts as needed to keep the bundle clear and current.

The curator runs in an isolated Pi process with extension discovery disabled. This prevents its own prompt and agent turn from triggering Memory again.

The curator edits complete concept documents and the root index directly. The surrounding application validates and commits the changes.

#### Curator system prompt

```text
You curate the knowledge base in the current directory from an ordered batch of facts about one project.

For each fact:
- Add it when it is new.
- Ignore it when it is already current.
- Replace older knowledge when a newer fact contradicts it.
- Preserve unrelated current knowledge.
- Store it under its assigned topic in the clearest concept document.
- Use supportedBy as provenance. Facts supported only by the agent may describe project knowledge, but cannot establish or override user preferences or accepted decisions.

Available tools:
- Use find and ls to locate relevant concepts.
- Use read to inspect concepts and index.md.
- Use edit to update existing complete documents, including frontmatter when needed.
- Use write only to create new concept documents.

Keep frontmatter valid YAML and quote string values that contain whitespace. Update index.md when concepts change. Make no changes when the knowledge base is already current.
```

The initial user message contains only the JSON batch payload: `projectWorkingDirectory` and ordered `facts`.

## Event flow

Memory consumes finalized `message_end` events for user messages and successful terminal agent responses, preserving their order in one open exchange. It closes the exchange on `agent_settled`, the boundary where no automatic retry, compaction retry, or queued continuation remains.

```text
message_end
  -> open or extend exchange
  -> store finalized user or successful terminal agent message

agent_settled
  -> settle exchange
  -> extractor agent reads all ordered messages
  -> atomically insert validated facts and set extracted_at
  -> wake queue consumer

Queue consumer
  -> select one cwd batch
  -> curator agent updates ~/work-memory
  -> validate OKF files
  -> commit changed files with "updated" message
  -> set processed_at
```

The local message insert completes before the `message_end` hook returns. Extraction runs in the background after settlement without delaying the main coding agent. A session start retries settled, unextracted exchanges and wakes the curator consumer. Session shutdown settles any remaining open exchange from the messages available at that point.

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

Memory failures do not fail the user's main agent turn. Errors are stored in the SQLite `logs` table with `id`, `msg`, and `created_at`; contextual fields are serialized in `msg`. An extraction failure leaves the settled exchange without `extracted_at`, so a later session can retry it.

Boundary validation is strict:

- Extractor output must match the fact schema.
- Queue topics and senders must be valid.
- The knowledge-base path must remain under `~/work-memory`.
- Changed concept documents must satisfy OKF v0.2 minimum rules.
- Git must succeed before changed rows are completed.

## MVP features

- **Exchange capture:** Memory stores ordered user and successful agent messages, then extracts once after Pi is fully settled.
- **Inspectable inputs:** Original messages remain grouped under the exchange that supports each extracted fact.
- **Durable knowledge:** It stores directly supported explanations, resulting states, preferences, decisions, conventions, constraints, and gotchas while rejecting transient process evidence.
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

Connect the lightweight extractor to complete conversation exchanges without blocking the main agent.

Tasks:

- Status: done - Open and extend exchanges from finalized user `message_end` events.
- Status: done - Append successful terminal agent `message_end` events without extracting yet.
- Status: done - Settle exchanges on `agent_settled` and extract once from all ordered messages.
- Status: done - Define the exchange-aware extractor prompt, `supportedBy` provenance, and validated output shape.
- Status: done - Run the extractor with `gpt-5.6-luna` and no thinking.
- Status: done - Complete extraction and enqueue facts in one transaction.
- Status: done - Retry settled, unextracted exchanges after session start.
- Status: done - Wake the consumer after facts are queued.

QA checkpoint:

- Ask for an explanation and confirm stable agent-supported project facts are queued.
- Ask for design advice and confirm unaccepted proposals are not queued as current facts.
- Complete an implementation and confirm only the durable resulting state is queued.
- Confirm tests, metrics, commit hashes, and completion narration are rejected.
- Submit feedback containing an explicit preference and confirm it is user-supported.
- Exercise retries, aborts, steering, and queued follow-ups and inspect the ordered exchange.
- Force extraction failure and confirm the settled exchange remains retryable.

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
