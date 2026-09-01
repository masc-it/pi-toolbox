# Memory client-server redesign plan

Status: `todo`

## Goal

Run one local Memory service for all Pi sessions. The socket server persists conversation events and acknowledges clients. Dedicated consumers extract settled exchanges and curate queued facts without running queue logic inside Pi sessions.

## Confirmed decisions

- `memory_exchanges` remains the extraction queue.
- `memory_queue` remains the fact queue.
- Queue wakes use process IPC; SQLite remains the durable source of work.
- One extraction consumer and one curation consumer run behind the socket server.
- The curation consumer keeps the existing batching, retry, repository, validation, and Git behavior.
- The canonical `~/work-memory` checkout is edited directly. Git worktrees are not used.

## Process topology

```text
Pi session A ─┐
Pi session B ─┼── memory.sock ── Socket server
Pi session N ─┘                       │
                                      ├── wake ──> Extraction consumer
                                      │                 │
                                      │                 └── facts ready
                                      │                          │
                                      └──────────────────────────┴──> Curation consumer

SQLite
├── memory_exchanges: settled exchanges waiting for extraction
└── memory_queue: extracted facts waiting for curation
```

The server and consumers belong to one detached Memory service. Only the socket server accepts client connections. The consumers are managed child processes.

The socket is stored beside the database:

```text
~/.pi/agent/pi-toolbox/memory.sock
```

The enclosing directory remains mode `0700`.

## Queue flow

### Conversation producer

The socket server handles `captureUser`, `captureAgent`, and `settleExchange`. Message capture commits before the client request is acknowledged.

Settling an exchange makes it available to the extraction consumer:

```sql
settled_at IS NOT NULL
AND extracted_at IS NULL
```

After the settlement transaction commits, the server acknowledges the client and wakes the extraction consumer.

### Extraction consumer and fact producer

The extraction consumer selects the oldest settled exchange, loads its ordered messages, and runs the existing extractor in headless Pi.

Extraction completion uses one transaction:

```text
insert 0-N facts into memory_queue
set memory_exchanges.extracted_at
commit
```

After the transaction commits, the extraction consumer wakes the curation consumer. An empty fact list still sets `extracted_at`.

### Curation consumer

A fact remains available while:

```sql
processed_at IS NULL
```

The curation consumer uses the existing selection rules:

1. Find the `cwd` containing the oldest pending fact.
2. Select up to ten pending facts for that `cwd`.
3. Apply the serialized byte limit.
4. Run the curator.
5. Validate and commit its changes, or confirm a no-op.
6. Set `processed_at` on the selected facts.
7. Continue until no pending batch remains.

Rows are FIFO within one `cwd`. A later row for the selected `cwd` can be processed before an earlier row belonging to another `cwd`.

### Wake behavior

A wake tells an idle consumer to inspect SQLite. It does not contain queue payloads.

```text
settled exchange committed ──> wake extraction consumer
facts committed             ──> wake curation consumer
retry timer expires         ──> wake curation consumer
consumer starts             ──> drain its queue
```

A consumer drains until no eligible work remains. A wake received while draining requests another pass before it becomes idle.

## Example

Two Pi sessions settle exchanges while the consumers run independently:

```text
10:00:00.000  ContentAI client sends settleExchange(501)
10:00:00.003  server commits exchange 501
10:00:00.004  server acknowledges the client and wakes extraction

10:00:00.100  RL Box client sends settleExchange(502)
10:00:00.103  server commits exchange 502
10:00:00.104  server acknowledges the client and wakes extraction
```

The extraction queue is:

```text
exchange  cwd          settled_at  extracted_at
501       ContentAI    10:00:00    NULL
502       RL Box       10:00:00    NULL
```

The extraction consumer processes exchange 501 and commits two facts:

```text
ID    cwd          fact                                      processed_at
1001  ContentAI    ContentAI uses BINARY(36) offer IDs       NULL
1002  ContentAI    Deleted relationships preserve history   NULL
```

It then processes exchange 502:

```text
ID    cwd          fact                                      processed_at
1003  RL Box       The 2.6B model skips custom optimizations NULL
```

The curation consumer receives the first facts-ready wake and selects ContentAI because row 1001 is oldest:

```text
ContentAI batch [1001, 1002]
    -> curator
    -> validation
    -> Git commit or no-op
    -> processed_at for 1001 and 1002
```

It then selects RL Box:

```text
RL Box batch [1003]
    -> curator
    -> validation
    -> Git commit or no-op
    -> processed_at for 1003
```

The Pi clients only wait for their event transactions. They do not wait for either consumer.

## Ownership

| Resource | Owner |
|---|---|
| Pi event hooks and Toolbox UI | Memory client in each Pi session |
| Socket requests and client connections | Socket server |
| Open exchange lookup by Pi session ID | Socket server |
| Settled exchange consumption | Extraction consumer |
| Fact production | Extraction consumer |
| Fact batching, retry timers, and curation | Curation consumer |
| `~/work-memory` validation and Git commits | Curation consumer |
| Consumer startup and replacement | Socket server |

The server and both consumers open SQLite in WAL mode. Their transactions remain short; model and Git work occurs outside SQLite transactions.

## Client protocol

Messages use length-prefixed JSON. Integer database IDs cross the protocol as decimal strings.

```json
{
  "version": 1,
  "id": "2ec47f64-8cb2-4da8-9f45-5a250f04054d",
  "method": "captureUser",
  "params": {
    "sessionId": "01a05842-fdc8-7cfa-a7e8-c932aa8495cb",
    "cwd": "/Users/maurosciancalepore/projects/cia/ContentAI",
    "content": "...",
    "createdAt": "2026-09-01T10:45:17.491Z"
  }
}
```

The initial handshake sends the client package version, protocol version, Pi session ID, and working directory.

### Methods

| Method | Behavior |
|---|---|
| `connectSession` | Register or reconnect one Pi session. |
| `captureUser` | Open or extend that session's exchange with a finalized user message. |
| `captureAgent` | Append a successful terminal agent response to that session's open exchange. |
| `settleExchange` | Close that session's open exchange and wake extraction. |
| `closeSession` | Settle any open exchange and disconnect the session. |
| `getStatus` | Return enabled, pending, processed, and error counts. |
| `changeEnabled` | Apply `on`, `off`, or atomic `toggle` behavior. |

Mutating request IDs are stored with their result. Resending a request after an uncertain acknowledgement does not duplicate its mutation.

Requests from one session are handled in client order.

## Server lifecycle

A client first attempts to connect to `memory.sock`. If no server answers:

1. The client attempts to create `memory.start.lock` exclusively.
2. The winner verifies that no process is listening and starts the detached service.
3. The server binds `memory.sock`, initializes storage, and starts both consumers.
4. Other clients wait for the socket and connect to the same server.

Each consumer drains its queue when it starts. The server replaces a consumer after it exits.

The service remains alive while a client is connected, a consumer is active, or a curation retry timer is scheduled. It may exit after an idle period when both queues have no eligible work.

Disabling Memory stops capture and both consumers. Queue rows remain stored. Re-enabling starts the consumers and drains both queues.

## Conversation sessions

Open exchanges are persisted by Pi session ID. At most one open exchange exists for each session:

```sql
CREATE UNIQUE INDEX memory_exchanges_open_session_idx
ON memory_exchanges (pi_session_id)
WHERE settled_at IS NULL;
```

`captureUser`, `captureAgent`, and `settleExchange` resolve the open exchange by `pi_session_id`.

`agent_settled` remains the normal exchange boundary. `closeSession` settles an exchange during normal shutdown. If a client disappears without sending `closeSession`, the server settles its open exchange after a grace period unless the same Pi session reconnects.

## Consumer failures

An extraction failure leaves `extracted_at` unset. A replacement or later wake can select the exchange again.

A curation failure leaves `processed_at` unset. The curation consumer keeps the existing 5-second, 30-second, and 5-minute retries per `cwd`. A fourth consecutive failure blocks that `cwd` for the lifetime of the consumer while other working directories remain eligible.

If a consumer exits, the server starts a replacement. Pending work is selected from SQLite.

## Files

```text
src/memory/
├── protocol/
│   ├── messages.ts
│   └── framing.ts
├── client/
│   ├── connection.ts
│   └── capture.ts
├── server/
│   ├── entry.mjs
│   ├── runtime.ts
│   ├── lifecycle.ts
│   ├── supervisor.ts
│   ├── settings.ts
│   └── status.ts
├── extraction/
│   ├── entry.mjs
│   ├── consumer.ts
│   ├── sessions.ts
│   └── extractor.ts
└── curation/
    ├── entry.mjs
    ├── consumer.ts
    ├── queue.ts
    ├── curator.ts
    └── repository.ts
```

## Phase 1: Socket server and consumer supervision

- [done] Define the versioned handshake, request, response, and wake protocols.
- [done] Add length-prefixed JSON framing with payload-size limits and boundary validation.
- [done] Add startup-lock arbitration, socket readiness timeout, and detached service launch.
- [done] Implement concurrent client connections with ordered requests per session.
- [done] Start one extraction consumer and one curation consumer.
- [done] Forward committed queue wakes to the applicable consumer.
- [done] Replace a consumer after it exits.
- [done] Serve Memory settings and status through the socket.

QA checkpoint:

- [done] Connect concurrent clients from different Pi sessions to the same socket server.
- [done] Terminate each consumer and confirm the server starts a replacement.
- [done] Reject malformed frames, oversized payloads, unknown methods, and incompatible protocol versions.
- [done] Confirm `toggle` is applied once when its acknowledgement is lost and the request is resent.

## Phase 2: Conversation producer and extraction consumer

- [done] Route finalized user and successful terminal agent messages through the client.
- [done] Resolve open exchanges by Pi session ID.
- [done] Add durable request receipts for mutating protocol methods.
- [done] Settle exchanges through `agent_settled`, `closeSession`, and disconnected-session expiry.
- [done] Acknowledge settlement after its SQLite transaction without waiting for extraction.
- [done] Drain settled, unextracted exchanges in the extraction consumer.
- [done] Run the existing extractor through headless Pi with optional context and Memory disabled.
- [done] Insert facts and set `extracted_at` in one transaction.
- [done] Wake the curation consumer after fact production commits.

QA checkpoint:

- [done] Capture interleaved conversations from several Pi sessions and inspect separate ordered exchanges.
- [done] Resend acknowledged capture requests and confirm no messages are duplicated.
- [done] Confirm the settlement acknowledgement arrives before extraction completes.
- [done] Close a client during extraction and confirm the consumer completes the settled exchange.
- [done] Terminate extraction before completion and confirm the replacement selects the exchange again.
- [done] Return an empty fact list and confirm the exchange is marked extracted without queue rows.

## Phase 3: Fact producer and curation consumer

- [done] Wake one curation consumer after the extraction transaction commits.
- [done] Drain pending `memory_queue` rows until no batch remains.
- [done] Preserve FIFO `cwd` selection, row ordering, fact-count limits, and byte limits.
- [done] Reuse the existing curator, repository validation, commit, no-op, rollback, and retry flow.
- [done] Continue accepting and persisting client events while curation runs.
- [done] Remove per-session consumers and the cross-process repository lock.

QA checkpoint:

- [done] Produce facts from multiple sessions during one curator run and confirm they remain queued for later batches.
- [done] Open multiple clients with facts for the same `cwd` and confirm one consumer processes each batch.
- [done] Fail one `cwd` and confirm another working directory continues while it waits.
- [done] Lose a facts-ready wake, restart the curation consumer, and confirm startup draining processes the rows.
- [done] Confirm queue rows are completed only after a Git commit or confirmed no-op.
- [done] Confirm capture and status requests complete while the curator runs.

## Phase 4: Cutover and removal of session workers

- [todo] Add the schema migration for open-session uniqueness and request receipts without replacing existing exchange or fact rows.
- [todo] Back up `memory.sqlite` before migration.
- [todo] Require no old Memory lock before cutover.
- [todo] Replace `registerMemory` worker construction with one socket client per Pi session.
- [todo] Remove the per-session Memory workers, settings workers, and repository lock.
- [todo] Document service startup, shutdown, disabled behavior, and queue inspection.
- [todo] Require Pi sessions running the old extension to close during cutover.

QA checkpoint:

- [todo] Migrate a copy of the current database and preserve pending and processed counts.
- [todo] Start Pi sessions from different working directories and confirm they use the same service.
- [todo] Disable Memory from one session and confirm all clients stop capture and both consumers stop.
- [todo] Re-enable it from another session and confirm both queues drain.
- [todo] Run the TypeScript typecheck and the protocol, producer, extraction-consumer, and curation-consumer test suites.
