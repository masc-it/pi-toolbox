# pi-toolbox

Minimal, keyboard-first workflow tools for the Pi coding agent.

Pi Toolbox provides a shared keyboard-driven overlay with Prompt Polish, Context Finder, and Code Complexity.

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

Slash commands support terminals that do not emit distinct modified key sequences.

## Prompt Polish

Write a prompt in Pi's editor and open Prompt Polish. When the prompt is populated, polishing starts automatically. The full-screen workspace provides an editable source textarea above an editable polished-prompt textarea. Regenerate from the current source when needed, then accept the result into Pi's editor or copy it while continuing to edit. The only screen actions are vertically stacked in this order: Accept (`Ctrl+S`), Copy (`Ctrl+C`), and Polish (`Ctrl+Enter`). Accepting automatically submits the polished prompt to Pi; if submission fails, the prompt remains in the editor.

## Context Finder

Context Finder sends an editable copy of the current Pi prompt to `openai-codex/gpt-5.6-luna` at medium thinking and starts automatically when the prompt is populated. A read-only scouting agent uses project search tools such as read, grep, find, ls, `rg`, and `git grep`, then appends its bullet list of relevant files and symbols and automatically submits the enriched prompt to Pi.

## Code Complexity

Code Complexity runs the bundled `scripts/python_complexity.py` analyzer through `uv`, so `uv` must be available in `PATH`. It scans tracked and untracked production Python files, respects Git ignore rules, and falls back to a recursive walk outside Git repositories. It excludes `test` and `tests` directories; `test_*.py`, `*_test.py`, and `conftest.py`; virtual environments; Python and lint caches; dependencies; coverage output; and `build` and `dist` output.

The analyzer ranks files by its AST-based quality heuristic, hard-limit violations, function complexity, nesting, module logical lines, and path. It reports one file with module metrics, top-level executable statements, the biggest function offender, source spans, and up to four additional hotspots. Function metrics cover cyclomatic complexity, nesting, logical lines, parameters, local variables, branches, and bare `except` clauses. The heuristic is a ranking aid rather than a correctness measure. Toolbox submits a fixed refactoring request with the report to the main Pi session.

## Data

Prompt Polish model configuration is stored under the Pi agent directory at `pi-toolbox/config.json`. Workflow content is not persisted.

Memory stores its queue and error log in `pi-toolbox/memory.sqlite`. Errors are written to the `logs` table and are not printed in the Pi UI.

## Development

```sh
npm install
npm run typecheck
```

## License

MIT
