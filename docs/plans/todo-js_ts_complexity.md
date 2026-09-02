# JavaScript and TypeScript code complexity plan

Status: `todo`

## Goal

Add a Toolbox workflow that finds the worst complexity offender in production JavaScript and TypeScript files. The analyzer returns one deterministic Markdown report. Toolbox submits that report to the main Pi session with a fixed refactoring request.

## Confirmed decisions

- The JavaScript and TypeScript analyzer is separate from the Python analyzer.
- One analyzer handles JavaScript, TypeScript, JSX, and TSX.
- The analyzer uses the Toolbox-owned TypeScript compiler API in syntax-only mode.
- Analysis runs in a child Node process so parsing does not block Pi's event loop.
- The target repository's dependencies, `tsconfig.json`, and build scripts are not loaded or executed.
- An optional repository-local Toolbox JSON file can add path exclusions; it is parsed as data and never executed.
- Module bodies, class static blocks, and callables are executable scopes.
- The workflow reports one file, one primary executable scope, and up to four additional hotspots.
- Complexity scores rank findings. They do not measure correctness or runtime performance.
- `/tb-complexity` remains the Python command. The new command is `/tb-js-complexity`.

## Analyzer boundary

The bundled analyzer lives at:

```text
scripts/javascript_typescript_complexity.mjs
```

Toolbox starts it with the current Node executable:

```sh
<process.execPath> \
  <installed-toolbox>/scripts/javascript_typescript_complexity.mjs \
  --repo-root <current-working-directory>
```

The analyzer resolves `--repo-root` to a canonical absolute directory before discovery. It reads repository files and Git metadata without changing project state.

`typescript` becomes a pinned runtime dependency of Toolbox. The analyzer does not resolve a parser from the target repository.

## Source discovery

Use Git when the root belongs to a Git work tree:

```sh
git -C <root> ls-files --cached --others --exclude-standard -z
```

This includes tracked and untracked files while respecting Git ignore rules. If Git discovery is unavailable, walk the root recursively without following directory symlinks.

Keep regular files with these suffixes:

- `.js`
- `.jsx`
- `.ts`
- `.tsx`
- `.mjs`
- `.cjs`
- `.mts`
- `.cts`

Exclude declaration files:

- `*.d.ts`
- `*.d.mts`
- `*.d.cts`

Apply one exclusion predicate to candidates returned by Git and by fallback discovery. Exclude tests when either rule matches:

- A directory component is `test`, `tests`, or `__tests__`.
- The basename before the source suffix ends with `.test` or `.spec`.

Exclude a path containing any of these directory components:

- `.git`
- `.cache`
- `.next`
- `.nuxt`
- `.svelte-kit`
- `.turbo`
- `.vite`
- `.venv`
- `.yarn`
- `build`
- `coverage`
- `dist`
- `node_modules`
- `out`
- `site-packages`
- `venv`

For every accepted source suffix, exclude a file when the basename before that suffix ends with `.min` or the full filename contains `.bundle.`. Source maps are outside the accepted suffix set.

Resolve each candidate before analysis. Reject a candidate that resolves outside the repository root. Normalize, deduplicate, and sort project-relative paths before parsing.

### Repository exclusions

If `<repo-root>/.pi-toolbox.json` exists, read this optional section:

```json
{
  "complexity": {
    "javascriptTypeScript": {
      "excludePaths": ["generated", "public/vendor"]
    }
  }
}
```

Read the file as strict UTF-8 and reject it if its resolved path escapes the repository root. Each entry is a project-relative file or directory path. It excludes an exact match and every descendant. Reject absolute paths, empty paths, `.` and `..` components, NUL bytes, non-string values, and configuration files above 64 KiB. Ignore unrelated top-level Toolbox settings. Invalid complexity settings are a boundary failure.

Apply repository exclusions after the built-in rules to Git and fallback candidates. Do not read configuration from a parent directory.

Fail when no production JavaScript or TypeScript file remains. A discovered file that cannot be read, decoded, or parsed is an analysis failure; it is not silently skipped.

## Parsing

Read source as strict UTF-8. Decode errors include the project-relative path.

Enforce these repository limits before parsing:

- At most 50,000 source files.
- At most 10 MiB for one source file.
- At most 512 MiB across all discovered source files.

A limit breach fails the run through exit `6`. Do not skip the affected files.

Select the TypeScript `ScriptKind` from the file suffix and parse with the latest supported syntax target. Parsing creates one `SourceFile` at a time and does not create a TypeScript `Program`.

Treat parser diagnostics as analysis errors. Do not run semantic diagnostics, module resolution, or type checking.

The first version does not parse `.vue`, `.svelte`, Flow, embedded templates, or syntax supplied only by a target project's compiler plugin.

## Executable scopes

Analyze these scopes:

- The source file's module body.
- Each class static block.
- Function declarations and expressions with bodies.
- Arrow functions.
- Object methods.
- Class methods and constructors.
- Getters and setters.

Skip overload signatures, interface methods, ambient declarations, and other bodyless signatures.

Analyze a nested scope independently. Its statements, branches, nesting, and local bindings do not contribute to the enclosing scope. Enclosing-scope traversal stops at callable bodies. For a class, it visits decorators and static field initializer expressions, skips instance member initializers and callable bodies, and emits each static block as its own scope.

Build a stable qualified name from enclosing namespaces, classes, functions, variables, and properties where the syntax supplies one. Use these reserved names and fallbacks:

```text
<module>
ClassName.<static@L52>
<callback@L84>
<anonymous@L112>
```

The callback label applies when a callable is passed as an argument. The source line makes equal anonymous names deterministic. Use identifier and safely encoded literal property names; represent a computed property as `<computed@Lx>` instead of copying its expression.

## Scope metrics

Each executable scope produces:

```ts
type ScopeKind = "module" | "static-block" | "callable";
type CallableSyntaxKind =
  | "function"
  | "arrow"
  | "method"
  | "constructor"
  | "getter"
  | "setter";
type CallableRole = "declaration" | "assigned" | "callback" | "immediate" | "anonymous";

interface ScopeMetrics {
  scopeKind: ScopeKind;
  syntaxKind: CallableSyntaxKind | null;
  role: CallableRole | null;
  name: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  cyclomaticComplexity: number;
  maxNestingDepth: number;
  logicalLineCount: number;
  parameterCount: number | null;
  localBindingCount: number | null;
  qualityScore: number;
}
```

`syntaxKind` and `role` are set only for callables. `parameterCount` is set only for callables. `localBindingCount` is set for callables and static blocks; module bindings do not affect scope quality.

### Cyclomatic complexity

Start each executable scope at `1`. Add one for each decision point:

- `if`.
- `for`, `for...in`, `for...of`, `while`, and `do...while`.
- Each non-default `switch` clause.
- `catch`.
- A conditional expression.
- Each `&&`, `||`, or `??` operator.
- Each `&&=`, `||=`, or `??=` operator.

Do not count `else`, `default`, `try`, `finally`, optional chaining, default parameters, or plain lexical blocks as decisions.

### Nesting depth

Increase depth while visiting bodies controlled by `if`, loops, `switch`, `try`, `catch`, and `finally`. Treat an `else if` chain as one level rather than nesting each chained condition. Do not carry depth into a nested executable scope.

### Logical lines

Count unique source lines on which direct executable statements in the scope begin. Count the declaration line of a nested callable, then stop before its body. Exclude empty statements and type-only declarations.

### Parameters and local bindings

Count each callable parameter once. A destructured parameter remains one parameter. Count rest parameters and TypeScript parameter properties. Exclude the TypeScript `this` pseudo-parameter.

For callables and static blocks, count names introduced by variable declarations, destructuring, loop bindings, catch bindings, local function declarations, and local class declarations. Exclude parameters and bindings inside nested scopes.

## File metrics

Each file records:

- Module logical line count.
- Executable scope count by kind.
- Top-level imperative statement spans.
- File quality score.
- Hard-limit violation count.
- Highest scope complexity.
- Deepest scope nesting.
- Largest non-module scope logical line count.

Module logical lines are unique starting lines of non-empty statements and declarations. Exclude interfaces, type aliases, bodyless signatures, type-only imports, and type-only exports.

The module scope measures top-level cyclomatic complexity and nesting. A top-level imperative statement is one of:

- `if`, `switch`, a loop, `try`, or `throw`.
- A standalone expression statement other than a string-literal directive.
- An export assignment whose expression contains a call, construction, `await`, tagged template, assignment, or update expression.
- A variable initializer containing one of those expressions.
- A class declaration or expression with decorators, a static block, or a static field initializer containing one of those expressions.

Unwrap export declarations and classify the contained declaration or expression. Imports, string-literal directives, callable declarations, undecorated classes without imperative static initialization, and simple constant initializers are excluded. Stop expression inspection at nested callable bodies and instance member initializers. Analyze static blocks separately.

## Limits and scoring

Use the Python analyzer's initial limits:

| Metric | Soft limit | Hard limit |
|---|---:|---:|
| Cyclomatic complexity | 4 | 10 |
| Maximum nesting depth | 2 | 4 |
| Non-module scope logical lines | 20 | 40 |
| Callable parameters | 4 | 6 |
| Callable or static-block local bindings | 8 | — |
| Module logical lines | 250 | — |

Calculate scope quality from `100` with these penalties:

```text
4.0 × complexity above the soft limit
5.0 × nesting above the soft limit
1.5 × logical lines above the soft limit for callable and static-block scopes
3.0 × parameters above the soft limit for callable scopes
1.0 × local bindings above the soft limit for callable and static-block scopes
```

Round to the nearest integer and clamp to `0..100`. Module scope quality uses complexity and nesting only; module size and top-level statements are file penalties.

Calculate the file's base score from 70% of the worst scope score and 30% of the scope average. Subtract `0.1` for each module logical line above `250`. Subtract `0.25` for each top-level imperative statement, capped at 20 statements and a 5-point penalty. The cap prevents declarative builder calls, such as schema definitions, from dominating control-flow complexity. Round and clamp to `0..100`.

Count every applicable scope metric that exceeds a hard limit as one hard-limit violation.

These values are provisional. Before release, compare the rankings against a labeled corpus containing Node services, browser code, React components, utility libraries, and a monorepo. Record threshold or weight changes with the corpus results. Scores are not comparable across languages.

## Ranking

Sort files by these fields in order:

1. Lowest file quality score.
2. Highest hard-limit violation count.
3. Highest scope cyclomatic complexity.
4. Deepest scope nesting.
5. Largest module logical line count.
6. Project-relative path.

The first file is the only file rendered.

Sort its executable scopes by:

1. Lowest scope quality score.
2. Highest cyclomatic complexity.
3. Deepest nesting.
4. Largest logical line count.
5. Qualified name.
6. Starting line.

Render the first scope in full. Render up to four more scopes that exceed at least one applicable soft limit.

## Report contract

Write one Markdown bullet group to standard output:

```markdown
- `src/orders/importer.ts`
  - Quality heuristic: 42/100
  - Module logical lines: 318
  - Executable scopes: 19 (1 module, 1 static block, 17 callables)
  - Hard-limit violations: 3
  - Top-level imperative statements: 2 at L20-L24, L301-L305
  - Biggest offender: `OrderImporter.importOrders` at L42-L118
    - Scope: callable
    - Kind: method
    - Role: declaration
    - Quality heuristic: 41/100
    - Cyclomatic complexity: 18
    - Maximum nesting depth: 5
    - Logical lines: 62
    - Parameters: 7
    - Local bindings: 14
  - Other hotspots:
    - `validateOrder` at L130-L176: scope callable, kind function, role declaration, quality 58/100, complexity 12, nesting 4, logical lines 39, parameters 5, locals 10
```

Rules:

- The first bullet is the project-relative file path.
- File metrics use the displayed names and order.
- The biggest executable scope includes expanded metrics.
- Other hotspots use one compact bullet each.
- Omit top-level imperative statements and other hotspots when none exist.
- Show at most ten top-level imperative spans, followed by the number omitted.
- Omit kind, role, parameters, and local bindings when they do not apply to the scope kind.
- Render every path and inferred name with a Markdown code-span fence longer than any backtick run in the value. Add code-span padding when Markdown requires it.
- Replace newlines, carriage returns, tabs, NUL bytes, and other control characters in rendered paths and names with visible escape sequences.
- Never copy comments or computed property expressions into a rendered name.
- Write no heading, preamble, source code, recommendation, or repository summary.
- End with one newline.

## Script exit behavior

- Exit `0`: discovery and analysis completed and a report was written.
- Exit `2`: invalid arguments, discovery failure, or repository boundary failure.
- Exit `3`: no production JavaScript or TypeScript files were found.
- Exit `4`: a discovered source file could not be read, decoded, or parsed.
- Exit `5`: an analyzer invariant failed.
- Exit `6`: a file-count, per-file byte, or total-byte limit was exceeded.

Metric values never cause a non-zero exit. Error details go to standard error and include a safely escaped project-relative path when one source file caused the failure.

## Toolbox workflow

Add:

```text
src/workflows/javascript-typescript-complexity.ts
```

Expose:

```ts
analyzeJavaScriptTypeScriptRepository(
  cwd: string,
  signal: AbortSignal,
): Promise<ComplexityResult>

buildJavaScriptTypeScriptComplexityPrompt(report: string): string
```

Extract shared analyzer process handling from `src/workflows/complexity.ts` into:

```text
src/workflows/complexity-runner.ts
```

The shared runner owns:

- The `ComplexityResult` interface.
- The cancellation error.
- Bundled-file validation.
- Child-process cancellation.
- Standard output and standard error limits.
- Empty-output rejection.
- Exit-code formatting supplied by each language workflow.

The Python workflow continues to invoke `uv`. The JavaScript and TypeScript workflow invokes `process.execPath`. Both use `shell: false`, the existing process runner, a 50 KB standard-output limit, bounded standard error, `SIGTERM` cancellation, and the existing five-second `SIGKILL` fallback. The JavaScript and TypeScript run has a five-minute wall-clock limit and terminates through the same signal sequence.

The JavaScript and TypeScript prompt is:

```text
Propose how to reduce the code complexity in the highest-offending JavaScript or TypeScript file shown below. Focus on the reported hotspots, preserve behavior and public types, and do not optimize solely for the heuristic.

<analysis output>
```

Replace `<analysis output>` with the analyzer report exactly as written.

## Toolbox UI

Add `"js-ts-complexity"` to `ToolboxView`.

The landing screen contains separate entries:

- `Python Complexity`: `Find the worst Python complexity offender and propose focused improvements.`
- `JS/TS Complexity`: `Find the worst JavaScript or TypeScript complexity offender and propose focused improvements.`

Keep the existing `"complexity"` view and `/tb-complexity` command for Python. Register:

```text
/tb-js-complexity
```

Parameterize `ComplexityScreen` with its running label while preserving its running, failed, and completed states. The new running label is:

```text
Analysing repository JavaScript and TypeScript files…
```

Opening the view starts analysis. Escape and Cancel abort the child process. A failure exposes Retry and Close. Success closes the overlay and submits the generated prompt.

Analysis does not read, clear, or replace the existing editor value. If submission fails and the editor is empty, place the complete generated prompt in it. If the editor contains text, preserve that text, copy the generated prompt to the clipboard, and report both the submission failure and clipboard result.

## Failure handling

Show a direct error for:

- A missing bundled analyzer.
- No production JavaScript or TypeScript files.
- Git and fallback discovery failure.
- A path that escapes the repository root.
- Source read, UTF-8 decode, or parse failure.
- Analyzer invariant failure.
- Empty output or output above 50 KB.
- File-count, source-byte, or five-minute time limit breach.
- User cancellation.
- Main prompt submission failure or prompt-recovery copy failure.

The target repository is untrusted input. Use argument arrays, never a shell command, and never import target source or configuration.

## Performance constraints

The analyzer checks file counts and byte totals before parsing. It parses each file once and releases its source and AST after extracting metrics. It retains compact file metrics for deterministic repository ranking. It does not build a dependency graph or type-check the project.

Start with sequential parsing. Add worker processes only if profiling shows a useful wall-clock reduction within the same byte and time limits.

Runtime performance smells such as quadratic loops, blocking APIs, N+1 I/O, sequential independent awaits, and unbounded concurrency are outside this workflow. They require a separate analysis contract and do not affect the complexity score.

## Ownership

| Concern | Owner |
|---|---|
| Discovery, parsing, metrics, ranking, and report rendering | `scripts/javascript_typescript_complexity.mjs` |
| Process invocation, cancellation, and output bounds | Complexity workflow and shared runner |
| Running, retry, cancel, and close behavior | `ComplexityScreen` |
| Prompt submission, editor preservation, and clipboard recovery | Screen factory integration |
| Parser version | Toolbox package |

## Files

New files:

```text
scripts/javascript_typescript_complexity.mjs
src/workflows/complexity-runner.ts
src/workflows/javascript-typescript-complexity.ts
tests/complexity/javascript-typescript-analyzer.test.mjs
tests/complexity/javascript-typescript-workflow.test.ts
tests/complexity/complexity-screen.test.ts
```

Changed files:

```text
package.json
README.md
src/domain.ts
src/pi/commands.ts
src/ui/complexity.ts
src/ui/landing.ts
src/ui/screens.ts
src/workflows/complexity.ts
```

## Phase 1: Discovery and parser boundary

- [done] Add the standalone Node analyzer and required argument validation.
- [done] Add Git discovery and recursive fallback with repository-boundary checks.
- [done] Apply one built-in exclusion predicate to Git and fallback candidates.
- [done] Add supported suffixes, test exclusions, declaration exclusions, and generated-path exclusions.
- [done] Read and validate optional repository exclusions from `.pi-toolbox.json`.
- [done] Enforce file-count, per-file byte, and total-byte limits before parsing.
- [done] Add strict UTF-8 decoding and suffix-based TypeScript `ScriptKind` selection.
- [done] Report parser diagnostics through exit `4` without semantic analysis.
- [done] Move a pinned TypeScript version into runtime dependencies.

QA checkpoint:

- [done] Discover tracked and untracked source while excluding Git-ignored files.
- [done] Exclude tracked generated paths during Git discovery and the same paths during fallback discovery.
- [done] Exercise all eight accepted suffixes and all declaration-file exclusions.
- [done] Exercise test names, test directories, generated directories, and minified and bundled variants of every accepted suffix.
- [done] Apply exact-file and directory-prefix exclusions from a valid `.pi-toolbox.json`.
- [done] Reject oversized, malformed, non-UTF-8, and boundary-escaping repository configuration.
- [done] Run fallback discovery outside a Git work tree.
- [done] Reject a missing root, a file root, and a source symlink that resolves outside the root.
- [done] Exercise each repository resource limit and confirm exit `6` names the breached limit.
- [done] Report malformed source syntax and invalid UTF-8 with the safely escaped project-relative path.
- [done] Confirm no target package, build configuration, or source module is executed.

## Phase 2: Metrics, scoring, and report

- [done] Analyze the module body, class static blocks, and every callable kind with a body.
- [done] Infer stable names, callable syntax kinds, and callable roles without copying computed expressions.
- [done] Isolate nested executable-scope metrics from their enclosing scope.
- [done] Calculate cyclomatic complexity and control-flow nesting from one decision definition.
- [done] Calculate logical lines, applicable parameters, and applicable local bindings.
- [done] Calculate module metrics and top-level imperative statement spans after unwrapping exports.
- [done] Apply scope and file scoring, hard-limit counting, and deterministic ranking.
- [done] Render one file, one expanded executable scope, and up to four additional hotspots.
- [done] Encode repository-derived paths and names safely for Markdown and standard error.
- [done] Validate metric ranges and source spans before writing the report.
- [done] Calibrate thresholds and weights against the labeled JavaScript and TypeScript corpus before release.

QA checkpoint:

- [done] Assert exact metrics for conditionals, loops, switch clauses, catches, ternaries, logical operators, and logical assignments.
- [done] Confirm cyclomatic complexity adds each decision once.
- [done] Confirm optional chaining, `else`, `default`, `try`, and `finally` do not add cyclomatic decisions.
- [done] Confirm `else if` nesting and nested-scope isolation.
- [done] Cover module-level control flow, class decorators, static field initializers, and static blocks with and without callables in the same file.
- [done] Cover destructured parameters, the TypeScript `this` parameter, parameter properties, catch bindings, and local declarations.
- [done] Cover functions, arrows, object methods, class members, accessors, constructors, assigned functions, callbacks, immediate invocations, JSX, and TSX.
- [done] Confirm type-only declarations and bodyless signatures do not create executable scopes.
- [done] Verify export assignments, exported declarations, decorators, static initializers, and top-level imperative spans against fixture source.
- [done] Confirm imports, string-literal directives, simple constants, and instance initializers do not create top-level imperative findings.
- [done] Render paths and names containing backticks, whitespace, control characters, Unicode, and computed properties without breaking the Markdown structure.
- [done] Confirm controlled file and scope ties produce byte-identical reports.
- [done] Review selected hotspots from each corpus category, record false positives, and justify the final thresholds and weights.

Calibration record:

| Category | Repository and scope | Files | Selected hotspot | Review |
|---|---|---:|---|---|
| Node service | `/Users/maurosciancalepore/projects/content/sls-api-content-mcp` | 17 | `src/tools/handlers.ts`, quality 79 | `searchOffers` concentrates conditional request construction; its reported L98-L120 span matches the source. |
| Browser code | `/Users/maurosciancalepore/projects/sf-infra-tools` | 7 | `webapp/src/lib/models/ec2node.svelte.ts`, quality 100 | The model has no branch hotspot and remains below every soft limit. |
| React application | `/Users/maurosciancalepore/projects/content/fadmin`, excluding `app/assets/javascript` and `public` | 37 | `app/frontend/v2/App.tsx`, quality 29 | The 392-line `App` component has complexity 44 and 42 local bindings; L124-L515 matches the component body. |
| Utility library | Packaged `jiti` 2.7.0 copied to an isolated directory | 7 | `lib/jiti-native.mjs`, quality 72 | `createJiti.jiti.import` has nested resolution and retry branches; its complexity 11 and L45-L78 span match the source. |
| Multi-package service repository | `/Users/maurosciancalepore/projects/content/sls-api-content` | 21 | `db-sync/src/functions/old-cluster-cleanup/handler.js`, quality 87 | The handler contains nested deletion guards over L5-L39 and is the credible local hotspot. |

The first Node-service run selected a schema module because 31 declarative builder calls each incurred a two-point top-level penalty. Calibration reduced that penalty to 0.25 points, capped it at five points, and capped rendered top-level spans at ten. The control-flow, nesting, size, parameter, and local-binding limits remain unchanged.

The unconfigured React repository selected tracked third-party assets. Calibration used the documented repository exclusions because `app/assets/javascript` can also contain owned source and is unsafe as a global exclusion. All calibrated reports were byte-identical across two runs.

## Phase 3: Process workflow and screen reuse

- [todo] Extract shared complexity result, cancellation, file validation, and output handling.
- [todo] Preserve the Python workflow's `uv` invocation and user-facing failures.
- [todo] Add the JavaScript and TypeScript workflow using `process.execPath` and `shell: false`.
- [todo] Map analyzer exit codes to language-specific errors.
- [todo] Enforce the five-minute JavaScript and TypeScript analysis timeout through the existing termination sequence.
- [todo] Add the fixed JavaScript and TypeScript refactoring prompt.
- [todo] Parameterize the complexity screen's running text without duplicating its state machine.

QA checkpoint:

- [todo] Run both workflows from repository paths containing spaces and Unicode.
- [todo] Confirm each workflow returns analyzer output unchanged.
- [todo] Cancel each workflow and confirm no child process remains.
- [todo] Force each analyzer exit code and verify its displayed reason.
- [todo] Exceed the wall-clock limit and confirm timeout termination leaves no child process.
- [todo] Reject empty output and standard output above 50 KB.
- [todo] Truncate excessive standard error without hiding the exit code.
- [todo] Re-run the Python analyzer workflow and compare its report and failure behavior before and after the refactor.

## Phase 4: Toolbox integration and packaging

- [todo] Add the `js-ts-complexity` view, landing item, and `/tb-js-complexity` command.
- [todo] Rename the existing landing label to `Python Complexity` without changing `/tb-complexity`.
- [todo] Connect successful analysis to prompt submission.
- [todo] Recover a failed-submission prompt without replacing non-empty editor content.
- [todo] Add analyzer, workflow, and screen regression tests to the package test commands.
- [todo] Document supported sources, exclusions, metrics, parser ownership, and limitations.
- [todo] Include the Node analyzer and TypeScript runtime dependency in the installed package.

QA checkpoint:

- [todo] Open both complexity workflows from the landing screen and direct commands.
- [todo] Cancel, retry, and close the JavaScript and TypeScript screen from each valid state.
- [todo] Confirm successful analysis closes the overlay and submits one user message.
- [todo] Confirm existing editor content is unchanged during analysis.
- [todo] Force submission failure with an empty editor and confirm the complete prompt is restored there.
- [todo] Force submission failure with a non-empty editor and confirm its text is preserved while the generated prompt is copied.
- [todo] Force clipboard recovery failure and confirm the user receives a distinct error.
- [todo] Run `npm run typecheck`, the complexity test suite, and `git diff --check`.
- [todo] Install Toolbox from a clean checkout and confirm both bundled analyzers are present.
- [todo] Run the installed workflow against this repository and the repositories used for score calibration.
- [todo] Run each production analysis twice and compare report bytes.
- [todo] Inspect the selected source spans and raw metrics, record file count, duration, and peak memory, and confirm repository Git status is unchanged.
