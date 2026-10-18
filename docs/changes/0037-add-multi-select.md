# 0037: Add Multi-Select

## Summary

Let a select column declare `multiple`, so the reader ticks options with Space and takes every tick together, and give every select result a `selected` list — the ticked values, or the completing option's value alone when nothing is ticked — for the function form and the embedded component alike.

**Spec:** [Dialogs](../specs/dialogs/)
**Status:** complete
**Depends On:** 0027, 0036

## Motivation

A host that lets the reader pick several things — hosts to connect to, files to stage, sessions to close — has two options today: a loop of single selects, which loses the list after each pick, or a select of its own. Neither is acceptable for a capability whose point is that a plugin never re-implements a list. The column browser already has every piece multi-select needs except the tick: options with opaque values, a filter that keeps the reader's place, and columns that keep their state while the reader drills and backs out.

The proposal that prompted this named the new field `values`. That name is taken: `SelectResult.values` already holds the text fields collected along the path, so the ticked values arrive as `selected`.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions)). CI enforces these as merge gates:

- Tests MUST use Bun's test runner, and new observable behavior MUST have automated tests.
- Tests MUST maintain 100% statement, function, and line coverage across production source files; coverage exclusions MUST stay limited to generated or non-executable files and MUST be documented in configuration.
- Every first-party executable file committed MUST be reachable by the linter, the type checker, and the test suite; the demo is held to the same rules and MUST NOT be excluded from coverage.
- Committed tests MUST NOT contain focused or skipped cases without a documented reason.
- Biome formatting and lint, and TypeScript, MUST pass with no errors; `bun run check` MUST pass.
- Multi-select MUST be tested through the function form and through the embedded `Select` — a host component rendered through the injected `ink.render` on captured streams, as [Change 0036](./0036-add-embeddable-dialog-components.md) establishes.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Dialogs: Multi-Select](../specs/dialogs/index.md#multi-select) owns the `multiple` setting, the pre-tick and its validation, Space, the tick's lifetime, the `selected` list, the tick cell, and the scenarios that are this change's acceptance criteria. [Dialogs: Selection](../specs/dialogs/index.md#selection), [Dialogs: Filtering](../specs/dialogs/index.md#filtering), and [Dialogs: Presentation](../specs/dialogs/index.md#presentation) own the Space exception, the glyphs, and the `Space tick` hint. None of it is restated here. What implementing them requires of this change:

- The published contract is `plugins/dialogs/contract.ts`: `SelectRequest` gains `multiple?: boolean`, the option base gains `selected?: boolean`, and `SelectResult` gains `selected: readonly T[]`.
- `selected` is added to `SelectResult` unconditionally and is treated as a non-breaking addition: every consumer reads results and the provider is the only producer. A consumer's test double that constructs a `SelectResult` gains a required field to fill; the guide says so.
- The grid never declares `multiple` and ignores `selected` when it maps an answer back; [Grid](../specs/grid/index.md#interactive-grid) keeps multi-row selection out of scope.
- Every test double that constructs a `SelectResult` gains `selected`. Today these sit in `test/marketplace-selection.test.ts`, `test/demo.test.ts`, and `test/demo-scenarios.test.ts`; the list is illustrative and a search for constructed results is authoritative.

## Design

### Approach

1. **Validation.** A new request walk rejects `selected: true` on an option of a column not declaring `multiple`, at every reachable depth. It reads the request's own `multiple`, so its cycle guard is keyed on the request, as `requireAlignedCells` keys its guard for the same reason, rather than on the options list. It runs in the shared validation both forms call.
2. **Tick state.** Ticks are kept per column as a set of supplied option indices, keyed by the path of supplied indices from the root to the option that opened the column — the root's key is the empty path. A path key, unlike the sub-request object, keeps two options that share one sub-request object from sharing ticks, and lets a closed column's ticks be found again when the same option re-opens it. Pre-ticks seed a column's set the first time it opens. The state lives in a ref beside `levels` in `select.ts`, so a chunk carrying several keys is handled before any re-render, and is dropped with the component on cancel.
3. **Space.** In the select's input handler, before the filter edit: when the top select level is `multiple` and the input is exactly `" "` with neither `ctrl` nor `meta`, toggle the active visible option's supplied index and refresh. A pasted chunk is longer than one character and falls through to `editedText` unchanged.
4. **The tick cell.** `columns.ts` reserves the tick cell at the start of every row of a multiple column the way it reserves the sub-dialog marker at the end: decided per column before the width is split, drawn as `marker`, and as `cursor` on the active row. The header row is offset by the same two columns. The marker drop rule is unchanged; the tick cell is reserved first.
5. **The hint.** The select's hint assembly inserts `Space tick` after `↑↓ move` when the top select level is `multiple`.
6. **The result.** `resolveStack` and `submitField` in `select.ts` compute `selected` from the open select levels, left to right, each level's ticked supplied indices in ascending order, falling back to `[value]` only when no open level holds a tick.
7. **Demo.** `demo/scenarios.ts` gains a multi-select scenario so `bun run demo` shows ticking.

### Decisions

- **Decision**: `selected` lists the ticks of the open columns only, while a closed column's ticks are remembered for re-opening.
  - **Why**: what is taken is what the reader can reach on screen without backing out; nothing is submitted from a branch they have left. The spec records whether closed columns should contribute as an open question.
  - **Alternatives considered**: submitting every tick ever made in the dialog, which takes values from branches no longer on screen; discarding a column's ticks when it closes, which punishes an accidental left arrow.

- **Decision**: a ticked option's fields are not collected.
  - **Why**: fields are collected one option at a time, and `values` is keyed by field name with no option in the key; collecting several options' fields would collide. A caller that needs input per ticked option asks after the dialog.
  - **Alternatives considered**: collecting every ticked option's fields in sequence, rejected for the key collision and for turning one Enter into an unbounded form.

- **Decision**: `selected: false` on an option of a single-choice column is accepted.
  - **Why**: [Dialogs: Select Request](../specs/dialogs/index.md#select-request) rejects a declaration only where it contradicts what carries it; an option saying it starts unticked contradicts nothing, and a caller computing `selected` per option over a shared helper writes `false` in every column.
  - **Alternatives considered**: rejecting any declared `selected` outside a multiple column, which rejects a statement that is true.

- **Decision**: the glyphs are `■` and `□`.
  - **Why**: they read as checkboxes without a legend, the unticked box makes a multiple column recognizable before anything is ticked, and they are one column wide under the measure the dialogs already use for their box-drawing frame.
  - **Alternatives considered**: `✓` with a blank for unticked, which leaves a multiple column indistinguishable from a single one until something is ticked; a bracketed `[x]`, which costs three columns of every row.

- **Decision**: Space in a multiple column ticks and never filters; pasted text with spaces still filters.
  - **Why**: Space is the tick key in every file manager and checkbox list. Testing for input that is exactly one space keeps a pasted multi-term filter working; what a multiple column loses is only a multi-term filter typed key by key.
  - **Alternatives considered**: ticking only while the filter is empty, which gives Space two meanings depending on state the reader may not have noticed; a different tick key, which no reader would guess.

### Non-Goals

- Multi-row selection over a grid, which [Grid](../specs/grid/) keeps out of scope.
- A cap on ticks, select-all, range ticking, and a tick count drawn anywhere.
- Collecting the fields of ticked options.
- Any change under `src/`.

## Tasks

- [x] Add per-column multi-select to the dialogs
  - [x] `plugins/dialogs/contract.ts`: `multiple`, `selected` on options, and `selected` on `SelectResult`
  - [x] `plugins/dialogs/index.ts`: the pre-tick validation, shared by the function form and the component
  - [x] `plugins/dialogs/select.ts`: tick state keyed by path, Space handling, the hint phrase, and `selected` computed on every completion path — Enter on a plain option, a finished field collection, and a submitted text leaf
  - [x] `plugins/dialogs/columns.ts`: the tick cell and the header offset
  - [x] `plugins/grid/select.ts`: confirm the grid never sets `multiple` and ignores `selected`, with a test in `test/grid-select.test.ts`
  - [x] Every test double constructing a `SelectResult` gains `selected`, found by search
  - [x] `test/dialogs-multi-select.test.ts`: every scenario in [Dialogs: Multi-Select](../specs/dialogs/index.md#multi-select) through `select`, plus ticking and submission through an embedded `Select` in a host session, the hint line naming `Space tick` only in a multiple column, the tick cell under the cursor bar, and the default theme drawing it as `marker`
  - [x] Existing dialogs and demo tests updated only where they assert a whole result, to include `selected` — the demo prints each result as JSON, so its reported output gains the field
  - [x] `test/plugin-consumer.test.ts`: the consumer fixture builds a request with `multiple` and reads `selected`
  - [x] `demo/scenarios.ts` and `test/demo-scenarios.test.ts`: a multi-select scenario
  - [x] [`docs/manual/plugins.md`](../manual/plugins.md#use-the-bundled-dialogs-capability): document `multiple`, the pre-tick, Space, and `selected`, and that a test double constructing a `SelectResult` now fills `selected`
  - [x] [Dialogs](../specs/dialogs/) spec: mark [Multi-Select](../specs/dialogs/index.md#multi-select) implemented and add a changelog row; set this change `complete` in `docs/index.yml` and `docs/index.md`

## References

- Spec: [Dialogs: Multi-Select](../specs/dialogs/index.md#multi-select), [Dialogs: Selection](../specs/dialogs/index.md#selection), [Dialogs: Filtering](../specs/dialogs/index.md#filtering), [Dialogs: Presentation](../specs/dialogs/index.md#presentation)
- Related changes: [0027-add-multi-cell-select-rows](./0027-add-multi-cell-select-rows.md), [0036-add-embeddable-dialog-components](./0036-add-embeddable-dialog-components.md)
