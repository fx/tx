# 0029: Add Interactive Grid Row Actions

## Summary

Add the driveable half of the grid: present rows as a select, let the user pick one, offer the actions declared for it, and report both. The consumer then does whatever the action means — launching a command being the first thing anyone will want.

**Spec:** [Grid](../specs/grid/)
**Status:** draft
**Depends On:** 0027, 0028

## Motivation

A printed grid answers "what is there". The next question is always "do something with that one", and today a consumer answering it has to reimplement the whole of the answer: build a select, pad its rows itself, decide what filtering means across fields, and then work out whether the terminal is in a fit state to hand to a subprocess.

Only the last of those is genuinely hard, and it is the one most likely to be got wrong silently. A dialog holds the terminal in raw mode with an input handler forwarding keystrokes and a renderer mounted on stderr. Launch a subprocess before all of that is unwound and the symptom is not an error — it is a subprocess that does not receive the user's keystrokes, or a terminal left in raw mode after it exits. [Dialogs: Terminal Streams and Cleanup](../specs/dialogs/index.md#terminal-streams-and-cleanup) already guarantees the unwinding happens before the promise settles, but nothing states the consequence a consumer actually needs, and nothing tests it.

Everything else is already built by the time this change starts. [Change 0027](./0027-add-multi-cell-select-rows.md) gives options aligned cells and headers. [Change 0028](./0028-add-the-grid-plugin.md) gives the grid its measurement and its capability. [Sub-Dialog Columns](../specs/dialogs/index.md#sub-dialog-columns) already opens a second column from a chosen row, which is exactly the shape "pick a row, then pick what to do with it" has.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Development Conventions](../specs/architecture/index.md#development-conventions)). CI enforces these through `bun run check`:

- Production code MUST be TypeScript, and formatting and linting MUST use Biome.
- Tests MUST use Bun's test runner, and new observable behavior MUST have automated tests.
- Tests MUST maintain 100% statement, function, and line coverage across production source files.
- Committed tests MUST NOT contain focused or skipped cases without a documented reason.
- TypeScript MUST pass with no type errors.
- Tests MUST NOT write to or read from process-global streams; every stream is injected, as the dialogs tests already require.

The terminal-handover guarantee MUST be tested, not merely documented. A test MUST assert that once a selection has settled — completed, cancelled, and failed alike — raw mode is off, the input handler the dialog installed is gone, and nothing further is written. A guarantee a consumer is told to rely on and that no test pins is a guarantee that will quietly stop holding.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional requirements

[Grid: Interactive Grid](../specs/grid/index.md#interactive-grid), [Row Actions](../specs/grid/index.md#row-actions), and [Terminal Handover](../specs/grid/index.md#terminal-handover) own the behavior, together with their scenarios. Those are this change's acceptance criteria and are not restated here. What implementing them requires of this change:

- The grid builds a select request whose options carry the cells [Change 0027](./0027-add-multi-cell-select-rows.md) added, and hands it to the `dialogs` capability. It re-implements no part of movement, filtering, the viewport, the cursor bar, or cancellation.
- A row's actions become that row's declared sub-dialog, so acting on a row is the drilling [Sub-Dialog Columns](../specs/dialogs/index.md#sub-dialog-columns) already owns and not a second mechanism beside it.
- The grid reads the `dialogs` capability at command time, alongside the `theme` capability it already reads.
- The row-count and value-count mismatch is rejected before rendering, alongside the validations `select` itself performs, so no request that cannot produce a usable result ever touches the terminal.
- Nothing in this change spawns, runs, names, or interprets a process. The grid reports a row and an action; what an action means belongs to its consumer.

#### Scenario: The terminal is fit to hand over after a cancellation

- **GIVEN** a consumer opens an interactive grid and the user cancels it
- **WHEN** the consumer immediately starts a process that reads from the terminal
- **THEN** that process receives the user's keystrokes and the terminal is not in raw mode

### Documentation

- The plugin guide MUST show a consumer the whole shape: read the capability, select a row, and act on the result — including that the terminal is ready for a launched process the moment the selection settles. That last point is the one a consumer cannot discover from the types, and it is the reason a worked example is worth more here than a signature.

## Design

### Approach

`plugins/grid/select.ts` composes a select request from the grid request: each row's cells become an option's cells, the headers become the request's headers, and a row's declared actions become that row's `dialog`. The result maps back — the chosen value to the row the consumer supplied, and the chosen action to the action it declared.

The mapping back is the only genuinely new logic. [Sub-Dialog Columns](../specs/dialogs/index.md#sub-dialog-columns) resolves a nested select with the completing option's value, so a naive composition would return the action's value and lose the row's. Making the value carried through the actions column identify both is what keeps the consumer from having to reconstruct one from the other.

Terminal handover needs no new machinery, which is the point of the design. `runDialog` in the dialogs plugin already restores the terminal and unmounts before settling, on completion, cancellation, and failure alike. This change adds the assertion that it does, stated as something a consumer can rely on rather than as an implementation detail of the dialogs plugin.

### Decisions

- **Decision**: actions are a sub-dialog, not a second dialog opened after the first resolves.
  - **Why**: a second dialog would tear down the terminal, restore it, and take it again between the two choices — a visible flicker, and a window in which the reader's row selection has been made but nothing is on screen. [Terminal Streams and Cleanup](../specs/dialogs/index.md#terminal-streams-and-cleanup) already establishes that one `select` spanning several stages is one dialog for exactly this reason.
  - **Alternatives considered**: two sequential `select` calls; a bespoke action key bar under the grid, which would be a second key-binding vocabulary to learn.
- **Decision**: the grid reports the chosen action and never runs it.
  - **Why**: running it means owning process lifecycle — stdio, signals, exit codes, and what happens on failure — none of which the grid has any basis for deciding. It also means the grid would have to be told a command, and a capability that takes a command to run is a capability with a much larger blast radius than one that returns a value.
  - **Alternatives considered**: an action carrying a command the grid spawns; an action carrying a callback the grid invokes, which is the same lifecycle ownership wearing a different shape.
- **Decision**: the handover guarantee is stated in [Grid](../specs/grid/) as an observable consumers depend on, rather than left implicit in the dialogs implementation.
  - **Why**: it is the one thing about this feature a consumer must be able to rely on and cannot verify from a type signature. Stating it makes it testable and makes breaking it a failing test rather than a bug report about ssh behaving oddly.
  - **Alternatives considered**: leaving it as the dialogs implementation detail it is today.
- **Decision**: reject a row-count and value-count mismatch rather than tolerating it.
  - **Why**: the consumer's values are how it identifies a row. A mismatch means some row resolves to the wrong value or to nothing, and both are worse than a rejection before anything is drawn.
  - **Alternatives considered**: padding the shorter list; using the row index as the value when values run out.

### Non-Goals

- Running, spawning, or supervising a process. Emphatically out of scope, and out of scope in [Grid: Constraints](../specs/grid/index.md#constraints) too.
- Returning to the grid after the consumer has acted — the file-manager loop. It would require the grid to know when the consumer's action finished, which is the process lifecycle it deliberately does not own. [Grid: Open Questions](../specs/grid/index.md#open-questions) records it.
- Multi-row selection, in-place cell editing, and column reordering.
- Key bindings for actions beyond the ones [Sub-Dialog Columns](../specs/dialogs/index.md#sub-dialog-columns) already defines. No new key is introduced by this change.
- Any change to how a grid is printed.
- A public grid type export.

## Tasks

- [ ] Compose the interactive grid over the dialogs capability
  - [ ] `plugins/grid/select.ts` mapping a grid request onto a select request and its result back onto a row and an action
  - [ ] Read the `dialogs` capability at command time alongside the theme
  - [ ] Reject the row-count and value-count mismatch, and the absent-interactive-stream case, before rendering
  - [ ] Tests over injected streams for selecting a row, selecting a row and an action, backing out of the actions, cancelling, and each rejection
- [ ] Pin the terminal-handover guarantee
  - [ ] Tests asserting that after a completed, a cancelled, and a failed selection, raw mode is off, the installed input handler is gone, and nothing further is written
  - [ ] Test asserting standard output is untouched throughout an interactive selection
- [ ] Document the consumer shape
  - [ ] Add a worked example to `docs/manual/plugins.md`: read the capability, select a row, act on the result, and launch on the restored terminal
  - [ ] Add an interactive-grid scenario to `demo/`, covered by the demo tests [Change 0024](./0024-relocate-and-cover-the-demo.md) adds

## Open Questions

- [ ] Whether a selection should be able to report "chose a row, declined every action" distinctly from "cancelled" — backing out of the actions column currently returns to the rows, so the two are only distinguishable if a row can be taken without taking an action.
- [ ] Whether actions should be declarable once for the whole grid rather than per row, since most consumers will offer the same actions on every row — per row is more general and a whole-grid form is a convenience over it, so this is about whether the convenience is worth a second shape.
- [ ] Whether a consumer that wants to return to the grid after acting should be served by calling `select` again, which is what it can do today, or whether the repeated call loses something the loop would keep.

## References

- Spec: [Grid](../specs/grid/)
- Related changes: [0027-add-multi-cell-select-rows](./0027-add-multi-cell-select-rows.md), [0028-add-the-grid-plugin](./0028-add-the-grid-plugin.md), [0023-render-sub-dialogs-as-columns](./0023-render-sub-dialogs-as-columns.md)
