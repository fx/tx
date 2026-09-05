# 0024: Relocate and Cover the Demo

## Summary

Move the repository-root `demo` script out of the root and into a checked, tested source directory, run it through a `bun run demo` package script, and document it in `README.md`. The demo is first-party executable source today that no gate inspects; this change makes it ordinary source.

**Spec:** [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** —

## Motivation

The root `demo` file escapes all four quality gates at once, and each for a different reason:

- **Lint.** Biome dispatches a file to a parser by extension. `demo` has no extension, so Biome classifies it as unknown and drops it before the include globs are consulted. `bun run lint` traverses the repository and silently skips it — there is no Biome 2.5 setting that assigns a language to an extensionless path.
- **Type check.** `tsconfig.json` includes `build.ts`, `plugins`, `src`, and `test`. `demo` is in none of them and is imported by nothing, so `tsc` never sees it.
- **Test.** No test imports it.
- **Coverage.** Bun reports only files loaded during a run, and `test/coverage.test.ts` walks `src/` and `plugins/` to force-load production modules. `demo` is in neither root, so it contributes nothing and costs nothing.

That last point is the sharpest: it is a 387-line first-party executable excluded from coverage in practice, while [Development Conventions](../specs/architecture/index.md#development-conventions) requires coverage exclusions to be limited to generated or non-executable files and documented in configuration. This exclusion is neither.

It is also undiscoverable. `README.md` never mentions it, `docs/index.md` never mentions it, and no workflow refers to it. The only references anywhere are two task lines in [Change 0023](./0023-render-sub-dialogs-as-columns.md), so the one artifact that shows what the dialogs plugin actually looks like is reachable only by someone who already knows the file is there.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Development Conventions](../specs/architecture/index.md#development-conventions)). CI enforces these through `bun run check`:

- Production code MUST be TypeScript, and formatting and linting MUST use Biome.
- Tests MUST use Bun's test runner, and new observable behavior MUST have automated tests.
- Tests MUST maintain 100% statement, function, and line coverage across production source files — which, after this change, includes the demo.
- Coverage exclusions MUST be limited to generated or non-executable files and MUST be documented in configuration; the demo MUST NOT be added to them.
- Committed tests MUST NOT contain focused or skipped cases without a documented reason.
- TypeScript MUST pass with no type errors.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional requirements

[Architecture: Development Conventions](../specs/architecture/index.md#development-conventions) owns the rules that no first-party executable file escapes the gates and that the demonstration is a documented, script-invoked, fully checked artifact. Those requirements and their scenarios are this change's acceptance criteria and are not restated here. What implementing them requires of this change:

- The demo moves out of the repository root to a directory the type checker and the coverage walker already reach, and gains a `.ts` extension so Biome parses it.
- The demo splits so that it can reach 100% coverage without a terminal: the scenario catalogue and every request it builds become pure values, and the part that renders and waits for a person stays as thin as it can be made.
- `package.json` gains a `demo` script; the demo's own header comment stops advertising `./demo` as an invocation, because the file stops being executable.
- `README.md` gains a section documenting the script, placed after `## Plugins` and before `## Releases`, and stating that the demo runs from a source checkout — it is not in the published `files` allowlist and imports `plugins/` and `src/` directly.
- `docs/manual/plugins.md` is left alone; the demo is a contributor-facing artifact, not part of the plugin authoring guide.
- The two task lines in [Change 0023](./0023-render-sub-dialogs-as-columns.md) that name "the repo-root `demo`" become stale on merge. They are in a completed change document and are historical record, so they are not rewritten.

#### Scenario: The relocated demo is linted

- **GIVEN** the demo has been moved and given a `.ts` extension
- **WHEN** `bun run lint` runs
- **THEN** Biome reports the demo among the files it checked, rather than skipping it as an unknown type

#### Scenario: The demo is counted for coverage

- **GIVEN** the demo lives under a path the coverage walker loads
- **WHEN** `bun test` runs
- **THEN** the demo appears in the coverage report and the run fails if any of its statements, functions, or lines are uncovered

### Repository hygiene

One unrelated defect is in the blast radius and is fixed here because it blocks the very command this change is verified with:

- `bun run lint` currently fails in any working tree that has a git worktree under `.claude/worktrees/`, because Biome finds the nested `biome.json` inside it and errors with "Found a nested root configuration". `.claude/worktrees/` is in `.gitignore`, but `biome.json` sets no `vcs.useIgnoreFile` and excludes only `dist`, `coverage`, and `node_modules`, so the scanner walks in. CI is unaffected because it checks out clean.
- `biome.json` MUST exclude the agent worktree directory so that the documented validation command runs in a developer's real tree.

#### Scenario: Lint runs with a worktree present

- **GIVEN** a git worktree exists under `.claude/worktrees/`
- **WHEN** `bun run lint` runs
- **THEN** it completes without a nested-root-configuration error

## Design

### Approach

`demo/index.ts` holds the runner: argument handling, the composed demo plugin, and the call into `main`. `demo/scenarios.ts` holds the catalogue — the scenario names, their descriptions, and the `SelectRequest`/`TextField` values each one presents — as pure data and pure builders.

The split is what makes 100% coverage reachable honestly. The catalogue is asserted directly: every scenario name resolves, every request it builds is well-formed, the option and field declarations satisfy the validations `select` performs. The runner is driven the way `test/dialogs-plugin.test.ts` already drives dialogs — injected streams and a scripted key sequence — so that dispatch, the unknown-scenario error, and the default all-scenarios path are exercised without a real terminal.

`demo/` sits beside `src/` and `plugins/`, is added to `tsconfig.json`'s `include`, and is added to `test/coverage.test.ts`'s production roots so an unimported module in it cannot hide.

### Decisions

- **Decision**: `demo/` as a sibling directory rather than `examples/` or `scripts/`.
  - **Why**: the file is already named `demo` and the header already advertises `bun demo`; keeping the name keeps the muscle memory and the `bun run demo` script reads naturally. `examples/` implies a set of independent samples, which this is not — it is one program with scenario arguments.
  - **Alternatives considered**: a single root `demo.ts` (still at the root, which the request rules out); `scripts/demo.ts` (`scripts/` does not exist and would exist for one file).
- **Decision**: split the catalogue from the runner rather than covering the whole file through the render path.
  - **Why**: the scenarios are the part with real content and they are pure values, so testing them is cheap and meaningful. Driving 387 lines of render loop to 100% through a fake terminal would be slow, brittle, and would test Ink more than it tests the demo.
  - **Alternatives considered**: one file with a coverage exclusion — rejected, because it is exactly the exclusion [Development Conventions](../specs/architecture/index.md#development-conventions) forbids and exactly the state this change exists to leave.
- **Decision**: the demo stays out of the published `files` allowlist.
  - **Why**: it imports `plugins/dialogs/index.ts` and `src/cli.ts` by relative path, neither of which is published. Shipping it would ship a file that cannot run. The README says so rather than implying otherwise.
  - **Alternatives considered**: publishing it — rejected; [Runtime and Distribution](../specs/architecture/index.md#runtime-and-distribution) requires a strict file allowlist.

### Non-Goals

- A `tx demo` command, a demo plugin namespace, or any runtime surface — the two prior change documents both list that as a non-goal and it stays one.
- Changing what any scenario demonstrates, adding a scenario, or restyling the demo's output.
- Running the demo in CI. It waits for a person; CI checks it as source and nothing more.
- Reworking `test/coverage.test.ts` beyond adding the new root.
- Rewriting the stale references in [Change 0023](./0023-render-sub-dialogs-as-columns.md).

## Tasks

- [x] Relocate and split the demo
  - [x] Move the root `demo` to `demo/index.ts` and extract the scenario catalogue into `demo/scenarios.ts`
  - [x] Update the header comment so it documents `bun run demo <scenario>` and no longer advertises `./demo`
  - [x] Delete the root `demo` file and its executable bit
  - [x] Add `demo` to `tsconfig.json`'s `include` and to `test/coverage.test.ts`'s production roots
  - [x] Add the `demo` script to `package.json`
  - [x] Exclude `.claude` from `biome.json` so `bun run lint` works with an agent worktree present
- [x] Cover the demo
  - [x] Add `test/demo-scenarios.test.ts` asserting every scenario name resolves and every built request is well-formed
  - [x] Add `test/demo.test.ts` driving the runner over injected streams: the default path, one named scenario, and the unknown-scenario error
  - [x] Confirm `bun run check` passes with the demo counted for coverage
- [x] Document the demo
  - [x] Add a `## Demo` section to `README.md` between `## Plugins` and `## Releases`, stating the script and that it needs a source checkout

## Open Questions

- [ ] Whether `test/coverage.test.ts` should walk the repository for first-party executable source rather than carrying a hand-maintained list of roots — the hand-maintained list is exactly what let the demo slip, and adding `demo` to it fixes this instance without fixing the class.

## References

- Spec: [Architecture](../specs/architecture/)
- Related changes: [0023-render-sub-dialogs-as-columns](./0023-render-sub-dialogs-as-columns.md)
