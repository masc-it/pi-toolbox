# Repository Code Complexity

Status: done
Created: 2026-08-27

## Goal

Add a Toolbox workflow that finds the worst Python complexity offender in the current repository.

The workflow scans the repository, excludes tests, analyses every remaining Python file, and selects one file. It then submits a fixed refactoring prompt with the report to the main Pi agent.

## User flow

1. The user opens Code Complexity from the Toolbox or runs `/tb-complexity`.
2. Toolbox runs the bundled analyzer with `uv`.
3. The analyzer discovers repository Python files and excludes tests.
4. The analyzer calculates file and function metrics.
5. The analyzer returns the highest-ranked offender as a Markdown bullet list.
6. Toolbox submits the report to the main Pi session.
7. The main agent reads the reported file and proposes how to reduce its complexity.

## Analyzer script

### Location

The bundled script lives at:

```text
scripts/python_complexity.py
```

It uses PEP 723 metadata and the Python standard library. It is always executed through `uv`.

### Command

```sh
uv run <installed-toolbox>/scripts/python_complexity.py \
  --repo-root <current-working-directory>
```

`--repo-root` is required. The script resolves it to a canonical absolute path before discovery.

The TypeScript workflow resolves the installed script from `import.meta.url`. The target repository does not contain or manage the analyzer.

## Repository discovery

Use Git when the root belongs to a Git repository:

```sh
git -C <root> ls-files --cached --others --exclude-standard
```

This includes tracked and untracked files while respecting Git ignore rules.

If Git discovery is unavailable, walk the root recursively.

Keep regular files with a `.py` suffix. Exclude a file when any rule below matches.

Test paths:

- A directory component is `test` or `tests`.
- The filename matches `test_*.py`.
- The filename matches `*_test.py`.
- The filename is `conftest.py`.

Skipped directories:

- `.git`
- `.mypy_cache`
- `.pytest_cache`
- `.ruff_cache`
- `.tox`
- `.venv`
- `venv`
- `__pycache__`
- `build`
- `dist`
- `htmlcov`
- `node_modules`
- `site-packages`

Normalize, deduplicate, and sort the discovered paths before analysis.

Fail when no production Python files are found. Do not analyse files outside the resolved root.

## Static analysis

Start from:

```text
/Users/maurosciancalepore/projects/cia/gensuite/scripts/repo_lint.py
```

Reuse its AST traversal, source spans, limits, penalties, and quality score.

### Function metrics

- Cyclomatic complexity.
- Maximum nesting depth.
- Logical line count.
- Parameter count, excluding `self` and `cls`.
- Local variable count.
- Branch count.
- Bare `except` count and locations.

### File metrics

- Quality heuristic from 0 to 100.
- Module logical line count.
- Function count.
- Top-level executable statement count and locations.
- Hard-limit violation count.
- Worst function quality heuristic.
- Highest function cyclomatic complexity.
- Deepest function nesting.
- Largest function logical line count.

The quality heuristic is a ranking aid. It is not a correctness measure.

### Analysis errors

A read, encoding, or syntax error prevents a complete repository ranking. Print the affected path and error to standard error, then exit with an analysis failure.

Do not silently exclude a discovered production file that cannot be analysed.

## Ranking

Sort files by these fields in order:

1. Lowest quality heuristic.
2. Highest hard-limit violation count.
3. Highest function cyclomatic complexity.
4. Deepest function nesting.
5. Largest module logical line count.
6. Project-relative path.

The first result is the only file rendered.

Sort function hotspots inside that file by:

1. Lowest function quality heuristic.
2. Highest cyclomatic complexity.
3. Deepest nesting.
4. Largest logical line count.
5. Qualified function name.

Render the worst function and up to four more functions that cross a soft limit.

## Report format

Write one Markdown bullet group to standard output:

```markdown
- `src/orders/importer.py`
  - Quality heuristic: 42/100
  - Module logical lines: 318
  - Functions: 14
  - Hard-limit violations: 3
  - Top-level executable statements: 2 at L20-L24, L301-L305
  - Biggest offender: `OrderImporter.import_orders` at L42-L118
    - Quality heuristic: 41/100
    - Cyclomatic complexity: 18
    - Maximum nesting depth: 5
    - Logical lines: 62
    - Parameters: 7
    - Local variables: 14
    - Branches: 15
    - Bare `except` clauses: 1 at L91-L94
  - Other hotspots:
    - `validate_order` at L130-L176: quality 58/100, complexity 12, nesting 4, logical lines 39, parameters 5, locals 10, branches 9
```

Rules:

- The first bullet is the project-relative file path.
- File metrics follow directly below it.
- The biggest function offender has expanded metrics.
- Other hotspots use one compact bullet each.
- Omit top-level statements, bare exceptions, or other hotspots when none exist.
- Use `None found` only when the selected file defines no functions.
- Use stable metric names and ordering.
- End with one newline.

The report contains no source code, heading, preamble, summary, or recommendation.

## Script exit behavior

- Exit `0`: discovery and analysis completed and a report was written.
- Exit `2`: invalid arguments or repository boundary failure.
- Exit `3`: discovery found no production Python files.
- Exit `4`: a discovered file could not be analysed.
- Exit `5`: an analyzer invariant failed.

Complexity values never cause a non-zero exit.

## TypeScript workflow

Add:

```text
src/workflows/complexity.ts
```

The workflow exposes:

```ts
interface ComplexityResult {
  report: string;
}

analyzeRepository(
  cwd: string,
  signal: AbortSignal,
): Promise<ComplexityResult>
```

The workflow performs these operations:

1. Resolve the bundled script path.
2. Spawn `uv` with `shell: false`.
3. Pass `ctx.cwd` through `--repo-root`.
4. Collect standard output and standard error.
5. Stop the process when the signal is aborted.
6. Reject non-zero exit codes with a clear message.
7. Reject empty output.
8. Reject output above 50 KB.
9. Return the report.

There is no fallback to `python` or `python3`. Missing `uv` is an explicit setup error.

Cancellation first sends `SIGTERM`. Send `SIGKILL` after five seconds if the child remains active.

## Main-session prompt

After a successful analysis, Toolbox automatically submits:

```text
Propose how to reduce the code complexity in the highest-offending Python file shown below. Focus on the biggest offenders and follow our coding principles.

<analysis output>
```

Replace `<analysis output>` with the report exactly as written by the script.

The main agent can use the file path and source spans to inspect the code. Toolbox does not add the user's editor text or any other context.

If submission fails, place the complete generated prompt in Pi's editor and show an error notification.

## Toolbox UI

Add `"complexity"` to `ToolboxView`.

Add a landing item:

- Label: `Code Complexity`.
- Description: `Find the worst Python complexity offender and propose focused improvements.`

Add the direct command:

```text
/tb-complexity
```

Do not add a global keyboard shortcut.

Opening the screen starts analysis immediately. The screen has three states:

- Running: show `Analysing repository Python files with uv…` and a Cancel action.
- Failed: show the error with Retry and Close actions.
- Completed: close the overlay and submit the generated prompt.

Escape cancels a running process. Closing or replacing the screen also cancels it.

The screen does not contain an editor or consume the current editor value.

## Failure handling

Show clear errors for:

- Missing bundled analyzer.
- Missing `uv` executable.
- No production Python files.
- Git and fallback discovery failure.
- File read, encoding, or syntax failure.
- Analyzer invariant failure.
- Output above 50 KB.
- User cancellation.
- Main prompt submission failure.

Keep analyzer standard error bounded. Include the exit code and useful standard error in the UI error.

## Files

New files:

- `scripts/python_complexity.py`
- `src/workflows/complexity.ts`
- `src/ui/complexity.ts`

Changed files:

- `.gitignore`
- `src/domain.ts`
- `src/ui/landing.ts`
- `src/ui/screens.ts`
- `src/pi/commands.ts`
- `package.json`
- `README.md`

Context Finder and its subagent workflow are unchanged.

## Production QA repository

Use this production Python repository as the final analyzer stress test:

```text
/Users/maurosciancalepore/projects/cia/ContentAI
```

Treat the repository as read-only. The analyzer may inspect files and Git metadata but must not change project state.

Run:

```sh
uv run scripts/python_complexity.py \
  --repo-root /Users/maurosciancalepore/projects/cia/ContentAI
```

QA checks:

- Record the discovered production-file count and analysis duration.
- Confirm test files, ignored files, environments, caches, and build output are absent from the candidate set.
- Confirm the command returns one deterministic file group.
- Run it more than once and compare the report bytes.
- Open the selected file and verify its reported source spans and raw metrics.
- Confirm the selected functions are credible complexity hotspots.
- Run the installed Toolbox workflow from the repository and verify the generated main-session prompt.
- Confirm `git status --short` is unchanged after every run.

## Delivery plan

### Phase 1: Repository analyzer

Status: done

Create a standalone vertical path from repository discovery to the top-offender report.

Tasks:

- Status: done - Copy and simplify the AST analysis from the reference script.
- Status: done - Add Git discovery and recursive fallback.
- Status: done - Add test and generated-directory exclusions.
- Status: done - Calculate file and function metrics.
- Status: done - Rank files and function hotspots.
- Status: done - Render only the top file as a Markdown bullet group.
- Status: done - Add PEP 723 metadata and documented exit codes.

QA checkpoint:

- Run against a repository with production files and tests.
- Confirm tracked and untracked production files are analysed.
- Confirm ignored files and every test pattern are excluded.
- Confirm the expected file ranks first in a controlled fixture repository.
- Confirm ties produce stable path ordering.
- Confirm only one file group is printed.
- Exercise an empty repository and a repository with only tests.
- Exercise syntax, encoding, and read failures.
- Run twice and compare the output bytes.

### Phase 2: UV workflow

Status: done

Connect the analyzer to a cancellable TypeScript boundary.

Tasks:

- Status: done - Resolve the installed analyzer path.
- Status: done - Spawn `uv` without a shell.
- Status: done - Bound standard output and standard error.
- Status: done - Map exit codes to user-facing errors.
- Status: done - Add graceful and forced cancellation.
- Status: done - Build the fixed main-session prompt.

QA checkpoint:

- Run the workflow from a repository root and a path containing spaces.
- Confirm the returned report is unchanged.
- Remove `uv` from `PATH` and confirm the setup error.
- Cancel while analysis is running and confirm the child exits.
- Force every script exit code and verify its message.
- Confirm oversized and empty output are rejected.

### Phase 3: Toolbox integration

Status: done

Expose the working analyzer through the Toolbox and submit its result.

Tasks:

- Status: done - Add the complexity view and screen factory.
- Status: done - Add the landing item and `/tb-complexity` command.
- Status: done - Add running, failed, retry, cancel, and close behavior.
- Status: done - Auto-submit the fixed prompt after success.
- Status: done - Restore the generated prompt when submission fails.
- Status: done - Preserve existing editor content during analysis.

QA checkpoint:

- Open through the landing item and direct command.
- Confirm analysis starts without a user query.
- Confirm existing editor text is unchanged while analysis runs.
- Cancel, retry, and close from each valid state.
- Confirm success closes the overlay and submits one user message.
- Confirm the message contains only the fixed instruction and report.
- Confirm the main agent can read the reported path and discuss the largest offenders.

### Phase 4: Packaging and documentation

Status: done

Ship the analyzer with the installed Toolbox package.

Tasks:

- Status: done - Add `scripts` to the package file list.
- Status: done - Document the workflow, exclusions, metrics, ranking, and `uv` requirement.
- Status: done - Complete package-level checks.

QA checkpoint:

- Run `npm run typecheck`.
- Run `git diff --check`.
- Install the package from a clean checkout.
- Confirm the installed package contains `scripts/python_complexity.py`.
- Analyse a separate Python repository through the installed package.
- Confirm cancellation leaves no child process or temporary file.

## QA results

Status: done

- Controlled Git and fallback fixtures covered tracked, untracked, ignored, test, generated-directory, empty, tie, syntax, encoding, read, and repository-boundary behavior. Repeated reports were byte-identical.
- The TypeScript boundary preserved reports from paths containing spaces, mapped analyzer exit codes, rejected missing `uv`, empty output, and output above 50 KB, and passed graceful and forced cancellation checks without a remaining child process.
- Screen-level checks covered automatic start, cancellation, retry, disposal, completion, editor preservation, one-message submission, and prompt restoration after a forced submission failure.
- The production ContentAI run discovered 325 production Python files. It completed in 0.33 and 0.35 seconds. Two reports were byte-identical and Git status was unchanged.
- The production offender was `Modules/OfferRuleClassifier/it_cls/it_birra_classifier.py`. Its reported function spans and metrics matched the source and identified credible branching hotspots.
- `npm run typecheck`, Python compilation, `git diff --check`, package installation, packaged-analyzer inspection, and analysis through the installed workflow passed.
