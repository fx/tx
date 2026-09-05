# 0025: Guarantee Cell Width by Construction

## Summary

`cell()` in `plugins/dialogs/columns.ts` can emit a cell wider than the column it was measured for. The overflow is currently absorbed by the frame's row-level truncation, so nothing visibly breaks, but the invariant every caller relies on holds by rescue rather than by construction. This change makes it hold by construction.

**Spec:** [Dialogs](../specs/dialogs/)
**Status:** complete
**Depends On:** —

## Motivation

`ColumnCell.text` documents itself as "already padded to the column's width, so the inverted bar spans the column and the column after it starts where it should". Every consumer of `columnCells` depends on that: `select.ts` concatenates one cell per column with a divider between each pair and hands the run to `Frame` as a single row, and the padding is the only thing keeping the columns after it aligned.

For an unmarked option the guarantee is real — `padToWidth` truncates and then pads, so the result is exactly the width asked for. For an option that opens a sub-dialog it is not. The marked branch builds `padToWidth(text, room)` plus a space plus the marker, with `room = Math.max(1, width - 2)`. At a column width of 1, `room` floors at 1 while the marker's own budget floors at 0, and the result is two columns wide with the marker gone entirely:

```
width=1  ->  "… "   (2 columns drawn, marker dropped, trailing space)
width=2  ->  "… "   (2 columns, correct)
width=3  ->  "… ▸"  (3 columns, correct)
```

A width of 1 is reachable: `fitColumnWidths` floors the last kept column at `Math.max(1, available - before)`, so a deep column stack in a narrow terminal produces exactly that. The row is then rescued by `truncateSegments` in `Frame`, which cuts the whole row to the panel's inner width and appends a single ellipsis — it has no notion of cell boundaries, so it happens to save the layout without knowing there was anything to save.

Two independent reviewers found this on [Change 0023](./0023-render-sub-dialogs-as-columns.md) without prompting from each other, which is the signal that matters: the code reads as though the invariant is established locally, and it is not. The existing width test asserts `displayWidth(cell.text) === width` for widths down to 1, but only over unmarked options, so the one path that breaks is the one path it does not cover.

The cost of leaving it is not a visible bug today. It is that [Change 0027](./0027-add-multi-cell-select-rows.md) multiplies the number of things inside a cell, and a cell whose width is guaranteed only by a downstream cut is a poor foundation to put fields inside.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Development Conventions](../specs/architecture/index.md#development-conventions)). CI enforces these through `bun run check`:

- Production code MUST be TypeScript, and formatting and linting MUST use Biome.
- Tests MUST use Bun's test runner, and new observable behavior MUST have automated tests.
- Tests MUST maintain 100% statement, function, and line coverage across production source files.
- Committed tests MUST NOT contain focused or skipped cases without a documented reason.
- TypeScript MUST pass with no type errors.

One rule inherited from [Change 0023](./0023-render-sub-dialogs-as-columns.md) binds this change directly: column geometry — widths, collapsing, stretching, and cells — MUST be tested as pure functions rather than only through rendered frames. A cell-width fix verified only by a rendered panel would be verified by the very rescue it exists to stop relying on.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional requirements

[Dialogs: Presentation](../specs/dialogs/index.md#presentation) owns the requirement that a cell occupies exactly the columns its field was measured at by construction, that a field too narrow for both text and marker drops the marker, and that the frame's row truncation remains a guard rather than the mechanism. Its scenario is this change's acceptance criterion and is not restated here. What implementing it requires of this change:

- `cell()` produces exactly `width` display columns for every `width` of 1 or more, marked and unmarked alike, with no reliance on any later cut.
- The marker is dropped, not squeezed, when the column cannot hold both it and at least one column of text. There is no width at which a cell is part marker and over budget.
- `Frame`'s `truncateSegments` is unchanged. It remains correct and remains the guard for a panel narrower than its whole content; it simply stops being the thing that makes an individual cell fit.
- No public behavior of `columnWidth`, `columnsWidth`, `droppedColumns`, `fitColumnWidths`, or `stretchLastColumn` changes. This is a fix inside `cell()` alone.

## Design

### Approach

The marked branch computes the marker's budget and the text's room from the same width, and the two floors disagree — `room` floors at 1 while the marker's budget floors at 0, so their sum can exceed `width`. Deciding first whether the column can afford a marker at all, and only then splitting the width, removes the disagreement rather than clamping after the fact.

The affordability threshold is the marker's reserved width plus one column of text. Below it the cell is built exactly as an unmarked cell is. At or above it the split is exact and the existing arithmetic already holds.

### Decisions

- **Decision**: drop the marker on a column too narrow for it, rather than dropping the text or truncating the composed string.
  - **Why**: at that width there is one column of content available and the label is what the reader is choosing between. A cell reading `▸` says only "this leads somewhere" about a row indistinguishable from every other row, which is less than nothing. Truncating the composed string would also work arithmetically but would leave the trailing space and the vanished marker that the current output already produces — correct width, incoherent content.
  - **Alternatives considered**: clamping with a final `truncateEnd` over the composed cell (fixes the width, keeps `"… "`); reserving the marker before the label (inverts the priority and makes narrow columns useless).
- **Decision**: extend the existing pure geometry test rather than adding a rendered-frame assertion.
  - **Why**: [Change 0023](./0023-render-sub-dialogs-as-columns.md) requires geometry to be tested as pure functions, and the existing `pads every cell to exactly the column's width` test is one option list away from covering this. The gap is that its helper builds only unmarked options.
  - **Alternatives considered**: a rendered narrow-terminal snapshot — rejected; it would pass today, because the rescue makes the rendered output correct.

### Non-Goals

- Any change to how columns are measured, dropped, fitted, or stretched.
- Any change to `Frame`, `truncateSegments`, `truncateEnd`, or `padToWidth`.
- Improving what a one- or two-column cell looks like beyond making it the right width. `"…"` in a single column is not informative, but a terminal that narrow is already outside what [Dialogs: Presentation](../specs/dialogs/index.md#presentation) lays out for.
- Per-column overflow reporting, caller-sized columns, or anything else on [Change 0023](./0023-render-sub-dialogs-as-columns.md)'s non-goals list.

## Tasks

- [x] Make the cell width hold by construction
  - [x] Decide marker affordability before splitting the width in `cell()`, and drop the marker below the threshold
  - [x] Extend `test/dialogs-columns.test.ts` so the exact-width invariant is asserted over marked options as well as unmarked ones, across widths from 1 upward
  - [x] Assert the marker is absent below the affordability threshold and present at and above it
  - [x] Confirm the existing rendered-frame tests are unchanged, which is the evidence that no visible output moved

## Open Questions

- [ ] Whether the same by-construction rule should be asserted for the `no match` row, which goes through `cell()` with `marked` false and is therefore already safe — asserting it would document the intent rather than catch a defect.

## References

- Spec: [Dialogs](../specs/dialogs/)
- Related changes: [0023-render-sub-dialogs-as-columns](./0023-render-sub-dialogs-as-columns.md), [0027-add-multi-cell-select-rows](./0027-add-multi-cell-select-rows.md)
