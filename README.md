# pi-toolbox

Minimal, keyboard-first workflow tools for the Pi coding agent.

Pi Toolbox is implementing its first release in three user-QA stages. The current stage provides the shared overlay and Prompt Polish. Feature Spec and Implementation remain visible in the navigation and unlock after their development checkpoints.

## Install from a checkout

```sh
pi install /absolute/path/to/pi-toolbox
```

Restart Pi after installation.

## Prompt Polish

1. Write a prompt in Pi's editor.
2. Press `Ctrl+Enter`, or open the Toolbox with `Ctrl+Shift+Enter` and select **Prompt Polish**.
3. Keep or change the model and thinking effort.
4. Generate the polished prompt, then accept, edit, retry, or cancel it.

Slash-command fallbacks are available when a terminal does not distinguish modified Enter sequences:

- `/toolbox`
- `/tb-polish`
- `/tb-spec`
- `/tb-implement`

Workflow model defaults are stored in the Pi agent directory at `pi-toolbox/config.json`.

## Development

```sh
npm install
npm run typecheck
```

Pi Toolbox uses user-operated QA checkpoints instead of an automated code-test suite. The release specification is in [`docs/spec_1.md`](docs/spec_1.md).

## License

MIT
