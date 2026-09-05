# 0027: Add Multi-Cell Select Rows

## Summary

Let a select option declare aligned cells instead of a single label, and let a column declare headers over them. This is what turns a select into a driveable table, and it is the mechanism [Change 0029](./0029-add-interactive-grid-row-actions.md) builds the interactive grid on.

**Spec:** [Dialogs](../specs/dialogs/)
**Status:** draft
**Depends On:** 0025, 0026

## Motivation

`SelectOption.label` is a single string. It is the only thing measured, the only thing matched, and the only thing drawn. A caller with rows of several fields therefore has exactly one option: pad the fields into one string itself and hand over the result.

That fails in three ways at once, and all three are invisible until someone hits them. The caller's padding is computed in code units, so a row containing a wide or astral character drifts out of alignment. The filter then matches against the padded string, so a term can match by spanning the gap between two fields — `alphab` finding a row whose fields are `alpha` and `beta`. And truncation cuts the composed string as one run, so a narrow terminal silently loses the last field of every row rather than narrowing anything.

Every one of those is a thing `tx` already knows how to do correctly and the caller does not. `displayWidth` measures in terminal columns. `visibleOptionIndices` can match per field if it is given fields. `columnWidth` and `cell` already pad and truncate against the right measure. The gap is only that the option model has nowhere to put more than one string.

Headers follow directly. A column of aligned fields whose meanings are not stated is a column the reader has to infer, and there is nowhere to state them today: the frame's title names the trail of columns, not the fields within one.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Development Conventions](../specs/architecture/index.md#development-conventions)). CI enforces these through `bun run check`:

- Production code MUST be TypeScript, and formatting and linting MUST use Biome.
- Tests MUST use Bun's test runner, and new observable behavior MUST have automated tests.
- Tests MUST maintain 100% statement, function, and line coverage across production source files.
- Committed tests MUST NOT contain focused or skipped cases without a documented reason.
- TypeScript MUST pass with no type errors.

Two inherited rules bind this change directly. Column geometry — widths, collapsing, stretching, and cells — MUST be tested as pure functions rather than only through rendered frames, which now extends to field widths within a cell. And the request validations MUST be tested as rejections that happen before anything is rendered and before terminal state changes, as every other `select` validation already is.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional requirements

[Dialogs](../specs/dialogs/) owns the option model, the validations, the per-field matching rule, the alignment and truncation rules, and the header row's behavior, in [Select Request](../specs/dialogs/index.md#select-request), [Filtering](../specs/dialogs/index.md#filtering), and [Presentation](../specs/dialogs/index.md#presentation). Their scenarios are this change's acceptance criteria and are not restated here. What implementing them requires of this change:

- `label` becomes optional and `cells` is added beside it, with exactly one of the two required, and one column may not mix the two shapes. Every existing caller declares `label` on every option, so no existing call site changes and no existing column becomes mixed.
- The `MatchableOption` type in `filter.ts` reads only `label` and `fields` today. It gains `cells`, and matching becomes per cell.
- Column measurement in `select.ts` currently reduces a column to one scalar `widestLabel`. For a column of cell options it becomes a vector — one width per field — measured over the whole visible list, exactly as the scalar is today, so scrolling still does not resize a column under the cursor bar.
- The header row is not an option. It is a row of the band that the viewport must account for, that `visibleOptionIndices` never sees, and that the active index can never address.
- The two-space gap between fields is fixed by [Dialogs: Presentation](../specs/dialogs/index.md#presentation)'s glyph and wording contract, alongside the divider and the marker, so tests and later changes have one source for it.

### Compatibility

- A request declaring only labels MUST render byte-identically to what it renders today. This change adds a shape; it does not alter the existing one.
- The existing dialogs rendering tests MUST pass unmodified, for the same reason [Change 0026](./0026-add-theme-variables.md) requires it: they are the evidence that the addition did not move the existing path.

## Design

### Approach

The natural place for field geometry is `columns.ts`, which already owns everything about how wide a thing is and how it is padded — and which, after [Change 0025](./0025-guarantee-cell-width-by-construction.md), guarantees a cell's width by construction rather than by rescue. That ordering is the whole reason this change depends on 0025: putting fields inside a cell whose own width holds only because something downstream cuts it would build the fields on the rescue.

`columnWidth` gains a sibling that takes a vector of field widths and returns the column width including the gaps, and `cell` gains a sibling that lays a row of cells into that column. The existing scalar functions stay exactly as they are and keep serving label options, so the label path is not touched by the cell path.

The header row is drawn as the first row of its column's band, resolved through [Theming](../specs/theming/)'s `chrome` variable so it reads as a label for the list rather than as a member of it, and it costs the viewport one of the rows it had. That cost is the knock-on: `optionRowCount` computes affordable rows from the terminal height and the chrome height, and a header is chrome that only some columns have.

The `chrome` variable is also the second dependency. [Change 0026](./0026-add-theme-variables.md) is what introduces it and moves the dialogs plugin behind the theme, so a header drawn before it landed would have to name an appearance directly and then be rewritten in the change that forbids exactly that. It is the order [Dialogs: Overview](../specs/dialogs/index.md#overview) already states — 0025, then 0026, then this change.

### Decisions

- **Decision**: `label` and `cells` as alternatives on the option, rather than `label: string | readonly string[]`.
  - **Why**: two named fields make the validation statable and the type narrowing obvious at every use site. A union type would put the discrimination at every read of `label`, including the ones in `filter.ts` and `select.ts` that have nothing to do with cells.
  - **Alternatives considered**: the union; a separate `SelectRequest` variant for tabular columns, which would double the request type for one added field.
- **Decision**: a column may not mix label options with cell options; a mixed column is rejected.
  - **Why**: the two shapes are measured differently — a label against one scalar width, a row of cells against a vector of field widths — and a column holding both would have to decide what a lone label means among fields that mean something else. Treating it as a one-cell row puts it in the first field and leaves the rest blank, which reads as a row that lost its data rather than as a label. Rejecting states the constraint where the caller can see it, and it costs nothing today because every existing column is uniformly labels.
  - **Alternatives considered**: promoting a label to a one-cell row (the misreading above); measuring mixed columns as labels and ignoring the cells (silently drops what the caller declared).
- **Decision**: a term matches within one cell, never across the join.
  - **Why**: matching against the padded or joined row is what makes `alphab` find a row of `alpha` and `beta` — a match the reader cannot see and cannot predict. Matching per cell is the rule a reader would guess.
  - **Alternatives considered**: joining with a separator no term can contain (works, but makes the rule an artifact of the separator); matching the joined string (the current caller-side failure, reproduced inside `tx`).
- **Decision**: headers are per column and validated against that column's cells.
  - **Why**: [Sub-Dialog Columns](../specs/dialogs/index.md#sub-dialog-columns) makes each column its own request, and a nested column already decides its own filter mode independently. Headers follow the same grain. A root-only header would be wrong for exactly the case a column browser exists for.
  - **Alternatives considered**: root-only headers, like `expand`.
- **Decision**: the header does not scroll and is not repeated.
  - **Why**: [Presentation](../specs/dialogs/index.md#presentation)'s standing principle is that nothing costs an option row by appearing and disappearing. A header that scrolled away would take a row with it on the way out and give one back on the way in.
  - **Alternatives considered**: a header pinned only while scrolled — the same churn, conditionally.
- **Decision**: field widths are measured over the whole visible list, not the window.
  - **Why**: it is the rule the existing scalar measurement already follows, and for the same reason — measuring the window resizes the column under the reader as they scroll.
  - **Alternatives considered**: none; measuring the window would contradict a rule already in the spec.

### Non-Goals

- Per-field alignment, caller-specified field widths, minimum or maximum widths, and horizontal scrolling — all recorded as out of scope in [Dialogs: Constraints](../specs/dialogs/index.md#constraints).
- Sorting, grouping, or reordering by a field. Supplied order is preserved, as it already is.
- A clickable, activatable, or sortable header.
- Match highlighting within a cell, which stays out of scope exactly as it is for a label.
- Multi-line cells, spanning cells, and per-row heights. A row is one line.
- Eliding or dropping a whole field on a narrow terminal — [Dialogs: Open Questions](../specs/dialogs/index.md#open-questions) records this as undecided and truncation is the answer until a real consumer says otherwise.
- Anything about the grid. This change adds the mechanism; [Change 0028](./0028-add-the-grid-plugin.md) and [Change 0029](./0029-add-interactive-grid-row-actions.md) use it.

## Tasks

- [ ] Add cells to the option model
  - [ ] Make `label` optional and add `cells` in `plugins/dialogs/types.ts`, with `headers` on the request
  - [ ] Validate label-or-cells, one shape per column, uniform cell counts within a column, and header count and placement, before rendering — alongside the existing option and field validations, at every reachable sub-dialog depth
  - [ ] Tests asserting each rejection happens before any terminal state changes
- [ ] Measure and draw aligned fields
  - [ ] Add vector field-width measurement and cell layout to `plugins/dialogs/columns.ts`, leaving the scalar label path untouched
  - [ ] Fix the inter-field gap at two spaces and add it to the glyph and wording contract
  - [ ] Pure-function tests in `test/dialogs-columns.test.ts` for field widths, gaps, per-field truncation, and the exact-column-width invariant over cell options
- [ ] Match per cell
  - [ ] Extend `MatchableOption` and `visibleOptionIndices` in `plugins/dialogs/filter.ts` to match each term within one cell
  - [ ] Tests for a term that would match only across a field boundary, and for a term matching in a trailing field
- [ ] Draw the header row
  - [ ] Render a declared header as the first row of its column's band, through the `chrome` variable, never selectable and never filtered
  - [ ] Account for the header in `optionRowCount` so a column with one shows one fewer option row
  - [ ] Tests for a scrolled list keeping its header, a filtered list keeping its header, and the viewport arithmetic
- [ ] Show it in the demo
  - [ ] Add a scenario to `demo/` presenting a column of cell options with headers, covered by the demo tests [Change 0024](./0024-relocate-and-cover-the-demo.md) adds

## Open Questions

- [ ] Whether a header should be allowed on a column of label options, rendering as a single-field header, rather than rejected — rejecting is stricter and easier to relax later, which is why the spec rejects it.
- [ ] Whether the marker that says an option opens a sub-dialog should sit on the right edge of the whole column, as it does today, or on the right edge of the last field — they differ once the column is stretched to fill the panel.

## References

- Spec: [Dialogs](../specs/dialogs/)
- Related changes: [0025-guarantee-cell-width-by-construction](./0025-guarantee-cell-width-by-construction.md), [0029-add-interactive-grid-row-actions](./0029-add-interactive-grid-row-actions.md), [0023-render-sub-dialogs-as-columns](./0023-render-sub-dialogs-as-columns.md)
