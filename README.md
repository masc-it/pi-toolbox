# pi-toolbox

Minimal, keyboard-first workflow tools for the Pi coding agent.

Pi Toolbox provides a shared keyboard-driven overlay with Prompt Polish, persistent Feature Specs, and an Implementation candidate browser. Agent orchestration unlocks after the Feature Spec persistence QA checkpoint.

## Install from a checkout

```sh
pi install /absolute/path/to/pi-toolbox
```

Restart Pi after installation.

## Entry points

- `Ctrl+Shift+Enter` or `/toolbox`: open the Toolbox landing screen.
- `Ctrl+Enter` or `/tb-polish`: open Prompt Polish directly.
- `/tb-spec`: open Feature Spec directly.
- `/tb-implement`: open Implementation directly.

Slash commands support terminals that do not emit distinct modified Enter sequences.

## Prompt Polish

Write a prompt in Pi's editor, open Prompt Polish, and select a model and thinking effort. Generate the polished prompt, then accept, edit, retry, or cancel it. The editor changes only after acceptance.

## Feature Spec

Feature Spec requires Pi to run inside a Git repository with an `origin` remote. It identifies the project from the canonical remote and stores drafts, interview answers, reviewed revisions, tasks, and user QA checkpoints in the global Toolbox database.

Create a draft from a feature description, answer one requirements question at a time, review or refine the generated specification, and approve it when its scope and tasks are correct. Approved features appear in Implementation as `todo`.

## Data

Pi Toolbox stores configuration and workflow state under the Pi agent directory:

- `pi-toolbox/config.json`
- `pi-toolbox/toolbox.sqlite`

The SQLite database remains outside project repositories and scopes every feature to its canonical Git identity.

## Development

```sh
npm install
npm run typecheck
```

Pi Toolbox uses user-operated QA checkpoints instead of an automated code-test suite. The release specification is in [`docs/spec_1.md`](docs/spec_1.md).

## License

MIT
