# pi-toolbox

Pi Toolbox adds prompt tools, code analysis, and conversation Memory to the Pi coding agent.

## Install

1. Run this command:

   ```sh
   pi install /absolute/path/to/pi-toolbox
   ```

2. Restart Pi.

## Commands and keys

Use interactive Pi mode for task screens.
Use slash commands if your terminal cannot send the key combinations.

| Command | Key combination | Function |
| --- | --- | --- |
| `/toolbox` | `Ctrl+Shift+Enter` | Open the Toolbox screen. The key combination also closes an open screen. |
| `/tb-polish` | `Ctrl+Enter` | Open Prompt Polish. |
| `/tb-context` | `Ctrl+.` | Open Context Finder. |
| `/tb-complexity` | None | Analyze Python code complexity. |
| `/tb-js-complexity` | None | Analyze JavaScript and TypeScript code complexity. |
| `/tb-memory [on\|off\|toggle]` | None | Set the Memory state for all sessions. No argument changes the state to its opposite. |

The Toolbox screen shows the Memory state and the counts for pending work, processed facts, and errors.

## Prompt Polish

Prompt Polish improves a prompt.
You can edit the source prompt and the result.

1. Enter a prompt in the Pi editor.
2. Open Prompt Polish.

Prompt Polish starts automatically if the source prompt contains text.
The screen has these actions, in this order:

| Action | Key combination | Function |
| --- | --- | --- |
| Accept | `Ctrl+S` | Send the result to Pi. |
| Copy | `Ctrl+C` | Copy the result without closing the screen. |
| Polish | `Ctrl+Enter` | Generate a new result from the source prompt. |

If Accept cannot send the result, the result stays in the Pi editor.
Use `Esc` to cancel an active model request.

## Context Finder

Context Finder searches the project for files and symbols related to your prompt.
It uses `read`, `grep`, `find`, `ls`, and `bash`.
The model instructions permit only read operations, such as `rg` and `git grep`.
These instructions do not provide a filesystem sandbox.

1. Enter a prompt in the Pi editor.
2. Open Context Finder.

You can edit the prompt copy in this screen.
The search starts automatically if the prompt contains text.
Context Finder adds file and symbol references, then sends the complete prompt to Pi.
If submission fails, the complete prompt returns to the Pi editor.
Use `Esc` to cancel an active search.

## Code complexity [WIP]

The analyzers examine production source files, excluding tests, dependencies, and generated output.
They include tracked and untracked files.
They obey Git ignore rules.
Outside a Git repository, they search directories recursively.

Each report identifies one file, its main problem area, source line ranges, and up to four other problem areas.
Toolbox sends the report to Pi with a fixed request for code changes.
The analyzers do not change or execute project code.

The quality score ranks files for review.
It does not measure correctness or execution speed.

Use `Enter` or `Esc` to cancel analysis.
Failure or cancellation leaves the screen open with Retry and Close.

### Python

Python Complexity runs `scripts/python_complexity.py` through `uv`.
Make sure that `uv` is available in `PATH`.

The analyzer excludes these files and directories:

- `test` and `tests` directories.
- `test_*.py`, `*_test.py`, and `conftest.py` files.
- Virtual environments and dependencies.
- Python caches, lint caches, and coverage output.
- `build` and `dist` output.

The Python abstract syntax tree (AST) supplies these file ranking values, in order:

1. Quality score.
2. Count of hard-limit violations.
3. Function complexity.
4. Nesting depth.
5. Module logical lines.
6. File path.

The report includes module measurements and executable statements at module level.
Function measurements include:

- Cyclomatic complexity.
- Nesting depth.
- Logical lines.
- Parameters and local variables.
- Branches and bare `except` clauses.

### JavaScript and TypeScript

JS/TS Complexity runs `scripts/javascript_typescript_complexity.mjs` with the Toolbox Node executable and a fixed TypeScript parser version.

The analyzer accepts these file types:

```text
.js .jsx .ts .tsx .mjs .cjs .mts .cts
```

The parser checks syntax without loading project dependencies, `tsconfig.json`, source modules, or build scripts.

The analyzer excludes declaration files, tests, generated directories, dependency directories, minified files, and bundles.
You can exclude more paths through `.pi-toolbox.json`:

```json
{
  "complexity": {
    "javascriptTypeScript": {
      "excludePaths": ["generated", "public/vendor"]
    }
  }
}
```

Each entry excludes an exact file path or a directory and its contents.

The analyzer measures module bodies, class static blocks, and executable functions.
Measurements include:

- Cyclomatic complexity.
- Control-flow nesting depth.
- Logical lines.
- Parameters and local bindings.
- Module size.
- Executable statements at module level.

The analyzer does not detect execution problems such as blocking I/O, repeated requests, or unrestricted concurrency.
It does not parse Vue or Svelte components, Flow syntax, embedded templates, or syntax from compiler plugins.

Analysis has these limits:

| Item | Limit |
| --- | --- |
| Analysis time | 5 minutes |
| Source files | 50,000 |
| Size of one source file | 10 MiB |
| Total size of source files | 512 MiB |

The request to Pi specifies these constraints:

- Preserve behavior and public types.
- Use the reported problem areas to select changes.
- Do not change code only to improve the score.

## Models and configuration

All model tasks use `openai-codex/gpt-6-luna` by default.
Thinking levels:

| Task | Thinking level |
| --- | --- |
| Prompt Polish | `low` |
| Context Finder | `medium` |
| Memory extraction | `off` |
| Memory curation | `medium` |

Prompt Polish reads its model profile from `pi-toolbox/config.json` under the Pi agent directory.
A profile in this file replaces the default profile.
To use the default, set `models.prompt_polish` to `null` or remove that field.
To keep a custom profile, change its model to `gpt-6-luna` as necessary.

Toolbox does not save task editor content or analysis reports.
Memory can save a prompt after Toolbox sends it to Pi.

## Memory [WIP]

Memory groups user messages and completed agent responses into an exchange.
The exchange closes when the Pi interaction finishes.
The service saves exchanges in `pi-toolbox/memory.sqlite` under the Pi agent directory.

Two background processes handle saved work:

1. Extraction converts completed exchanges into facts.
2. Curation uses batches of facts to update the knowledge repository at `~/work-memory`.

### Start and stop

A Pi session connects to Memory at `session_start`.
The first client starts the background service.
Other sessions use the same `memory.sock` socket.

At `session_shutdown`, Memory completes the open exchange and closes the client connection.
The service stays available for other sessions.
A `SIGTERM` signal stops both background processes and removes the socket.

### Enable or disable

Use `/tb-memory off` to disable Memory for all sessions.
This stops both background processes.
Clients stay connected.
Memory does not save new exchanges or messages while disabled.

Use `/tb-memory on` to enable Memory from any session.
Both processes check SQLite for pending work.

### Upgrade from the old Memory service

1. Close all Pi sessions that use the old pi-toolbox version.
2. Start a Pi session with the new version.

The service cannot start while `memory.sqlite.lock` exists.

The database upgrade makes these changes:

- Creates `memory.sqlite.pre-client-server.bak`.
- Keeps existing exchanges and facts.
- Completes open exchanges from old sessions.
- Adds request receipts to prevent duplicate changes from repeated request IDs.
- Limits each session to one open exchange.

### Files and pending work

Default files under `~/.pi/agent/pi-toolbox/`:

```text
memory.sqlite
memory.sqlite.pre-client-server.bak
memory.sock
memory.start.lock
memory-service.log
```

To count exchanges that need extraction, run this command:

```sh
sqlite3 ~/.pi/agent/pi-toolbox/memory.sqlite \
  "SELECT COUNT(*) FROM memory_exchanges WHERE settled_at IS NOT NULL AND extracted_at IS NULL;"
```

To count pending facts by working directory, run this command:

```sh
sqlite3 ~/.pi/agent/pi-toolbox/memory.sqlite \
  "SELECT cwd, COUNT(*) FROM memory_queue WHERE processed_at IS NULL GROUP BY cwd ORDER BY MIN(id);"
```

### Knowledge repository

Memory saves project knowledge under `projects/<project>/`.
It saves shared knowledge in global collections for coding, documentation, personal principles, and team practices.
If `~/work-memory` does not exist, Memory creates the Git repository and collection index files.

Curation saves valid changes with a Git commit.
Commit messages use `memory(<scope>): summary` or `memory: summary`.
Curation retries failures for each working directory separately.
Other projects can continue during a retry delay.

## Development

The project uses AI agents for quality assurance (QA) on real use cases.
The repository has no unit test suite.

1. Install dependencies:

   ```sh
   npm install
   ```

2. Check TypeScript types:

   ```sh
   npm run typecheck
   ```

## License

MIT
