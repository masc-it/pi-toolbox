# pi-toolbox

Minimal, keyboard-first workflow tools for the Pi coding agent.

Pi Toolbox provides a shared keyboard-driven overlay with Prompt Polish, Context Finder, Python Complexity, and JS/TS Complexity.

## Install from a checkout

```sh
pi install /absolute/path/to/pi-toolbox
```

Restart Pi after installation.

## Entry points

- `Ctrl+Shift+Enter` or `/toolbox`: open the Toolbox landing screen.
- `Ctrl+Enter` or `/tb-polish`: open Prompt Polish directly.
- `Ctrl+.` or `/tb-context`: open Context Finder directly.
- `/tb-complexity`: analyze Python code complexity directly.
- `/tb-js-complexity`: analyze JavaScript and TypeScript code complexity directly.
- `/tb-memory [on|off|toggle]`: control Memory globally. Omitting the argument toggles it. The current state and pending, processed, and error counts appear at the bottom of the Toolbox panel.

Slash commands support terminals that do not emit distinct modified key sequences.

## Prompt Polish

Write a prompt in Pi's editor and open Prompt Polish. When the prompt is populated, polishing starts automatically. The full-screen workspace provides an editable source textarea above an editable polished-prompt textarea. Regenerate from the current source when needed, then accept the result into Pi's editor or copy it while continuing to edit. The only screen actions are vertically stacked in this order: Accept (`Ctrl+S`), Copy (`Ctrl+C`), and Polish (`Ctrl+Enter`). Accepting automatically submits the polished prompt to Pi; if submission fails, the prompt remains in the editor.

## Context Finder

Context Finder sends an editable copy of the current Pi prompt to `openai-codex/gpt-5.6-luna` at medium thinking and starts automatically when the prompt is populated. A read-only scouting agent uses project search tools such as read, grep, find, ls, `rg`, and `git grep`, then appends its bullet list of relevant files and symbols and automatically submits the enriched prompt to Pi.

## Python Complexity

Python Complexity runs the bundled `scripts/python_complexity.py` analyzer through `uv`, so `uv` must be available in `PATH`. It scans tracked and untracked production Python files, respects Git ignore rules, and falls back to a recursive walk outside Git repositories. It excludes `test` and `tests` directories; `test_*.py`, `*_test.py`, and `conftest.py`; virtual environments; Python and lint caches; dependencies; coverage output; and `build` and `dist` output.

The analyzer ranks files by its AST-based quality heuristic, hard-limit violations, function complexity, nesting, module logical lines, and path. It reports one file with module metrics, top-level executable statements, the biggest function offender, source spans, and up to four additional hotspots. Function metrics cover cyclomatic complexity, nesting, logical lines, parameters, local variables, branches, and bare `except` clauses. The heuristic ranks refactoring candidates; it does not measure correctness or runtime performance. Toolbox submits a fixed refactoring request with the report to the main Pi session.

## JS/TS Complexity

JS/TS Complexity runs the bundled `scripts/javascript_typescript_complexity.mjs` analyzer with Toolbox's Node executable and pinned TypeScript parser. It accepts `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, and `.cts` files. Parsing is syntax-only: the analyzer does not load the target project's dependencies, `tsconfig.json`, source modules, or build scripts.

Discovery includes tracked and untracked production files, respects Git ignore rules, and uses the same recursive fallback as the Python analyzer. It excludes declaration files, test files and directories, generated and dependency directories, minified files, and bundles. A repository can add exact-file or directory-prefix exclusions in `.pi-toolbox.json`:

```json
{
  "complexity": {
    "javascriptTypeScript": {
      "excludePaths": ["generated", "public/vendor"]
    }
  }
}
```

The analyzer measures module bodies, class static blocks, and callables. Its metrics cover cyclomatic complexity, control-flow nesting, logical lines, parameters, local bindings, module size, and top-level imperative statements. It reports the highest-ranked file, its primary executable scope, and up to four additional hotspots. The heuristic ranks refactoring candidates; it does not detect runtime performance problems such as blocking I/O, sequential independent awaits, N+1 requests, quadratic work, or unbounded concurrency.

The first version does not parse Vue or Svelte component files, Flow syntax, embedded templates, or syntax supplied only by a project compiler plugin. Analysis is limited to five minutes, 50,000 source files, 10 MiB per file, and 512 MiB across source files. Toolbox submits the report with a fixed request to preserve behavior and public types rather than optimize only for the score.

## Data

Prompt Polish model configuration is stored under the Pi agent directory at `pi-toolbox/config.json`. Workflow content is not persisted.

## Memory service

Memory groups each user interaction and its completed agent responses into one exchange. A local socket server stores conversation events in `pi-toolbox/memory.sqlite`. One extraction process converts settled exchanges into facts, and one curation process applies fact batches to `~/work-memory`.

A Pi session connects during `session_start`. The first client starts the detached service; later sessions connect to the same `memory.sock`. `session_shutdown` settles that session's open exchange and closes its client connection. The service handles `SIGTERM` by stopping both consumers and removing the socket. It otherwise remains available for later Pi sessions.

`/tb-memory off` stops both consumers. Clients remain connected so `/tb-memory on` works from any session. Capture requests received while disabled do not create exchanges or messages. Re-enabling Memory starts both consumers, which inspect SQLite before waiting for queue wakes.

Before the first client-server startup, close every Pi session running an older pi-toolbox version. Startup refuses to continue while `memory.sqlite.lock` exists. The schema migration creates `memory.sqlite.pre-client-server.bak`, preserves exchange and fact rows, settles orphaned open exchanges, and adds request receipts and open-session uniqueness.

The default service files are:

```text
~/.pi/agent/pi-toolbox/
├── memory.sqlite
├── memory.sqlite.pre-client-server.bak
├── memory.sock
├── memory.start.lock
└── memory-service.log
```

Inspect the durable queues with:

```sh
sqlite3 ~/.pi/agent/pi-toolbox/memory.sqlite \
  "SELECT COUNT(*) FROM memory_exchanges WHERE settled_at IS NOT NULL AND extracted_at IS NULL;"
sqlite3 ~/.pi/agent/pi-toolbox/memory.sqlite \
  "SELECT cwd, COUNT(*) FROM memory_queue WHERE processed_at IS NULL GROUP BY cwd ORDER BY MIN(id);"
```

Project knowledge is stored under `projects/<project>/`; reusable coding, documentation, personal, and team knowledge stays in global collections. Failed curation retries per working directory without blocking other projects. Successful changes use a validated `memory(<scope>): summary` or `memory: summary` Git commit message. If `~/work-memory` is missing, the service initializes its Git repository and collection indices.

## Development

```sh
npm install
npm run typecheck
```

## License

MIT
