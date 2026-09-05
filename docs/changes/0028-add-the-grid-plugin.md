# 0028: Add the Grid Plugin

## Summary

Add a bundled grid plugin supplying a `grid` capability that prints aligned cells — a table with headers, or a flowed list — once and terminates. This is the half of the grid a plugin needs before it needs anything interactive.

**Spec:** [Grid](../specs/grid/)
**Status:** draft
**Depends On:** 0026

## Motivation

A plugin with rows to show has to solve the same list of problems every time, and the list is longer than it looks:

- Column widths measured in display columns rather than code units, or a row of wide characters breaks the alignment.
- A decision about what an absent value renders as, so a missing field cannot reach the terminal as the text `undefined`.
- Control characters removed from text the plugin did not author, so a newline cannot break the table apart and an escape sequence cannot clear the caller's screen.
- Whether to emit colour, which depends on four environment inputs with a precedence order between them.
- A canvas sized so that piped output and terminal output are the same bytes, rather than letting the renderer size itself from a stream it may not have.
- Renderer options set so a command that prints and exits does not behave like an application — no input handler, no alternate screen, no repaint sequences, no patched console.

None of that is about the plugin's subject. All of it is easy to get almost right, and "almost" here means output that is correct on the author's terminal and wrong through a pipe, in CI, or on someone else's locale.

`tx` already owns most of it. [Dialogs](../specs/dialogs/) measures and pads in display columns. [Change 0026](./0026-add-theme-variables.md) owns colour and appearance. What is missing is a way for a plugin that only wants to show rows to reach any of it.

The name is `grid` rather than `table` deliberately: the capability is about cells laid out in two dimensions, and a table is one arrangement of them. A flowed list — short items filling as many columns as the terminal affords — is the same measurement with a different placement, and splitting them into two capabilities would duplicate the geometry and then drift it.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Development Conventions](../specs/architecture/index.md#development-conventions)). CI enforces these through `bun run check`:

- Production code MUST be TypeScript, and formatting and linting MUST use Biome.
- Tests MUST use Bun's test runner, and new observable behavior MUST have automated tests.
- Tests MUST maintain 100% statement, function, and line coverage across production source files.
- Committed tests MUST NOT contain focused or skipped cases without a documented reason.
- TypeScript MUST pass with no type errors.
- `test/plugin-boundary.test.ts` MUST keep passing; the grid is a bundled plugin and its module graph MUST stay out of `src/`.

Grid geometry — column widths, gaps, padding, alignment, flow placement, and the empty and summary lines — MUST be tested as pure functions rather than only through rendered output, following the rule [Change 0023](./0023-render-sub-dialogs-as-columns.md) established for column geometry. Tests MUST NOT write to or read from process-global streams; every stream is injected.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional requirements

[Grid](../specs/grid/) owns the capability shape, the cell model, both layouts, and the printing contract, together with all of their scenarios. Those are this change's acceptance criteria and are not restated here. What implementing them requires of this change:

- A new bundled plugin under `plugins/grid/`, composed in `cli.ts` after the theme plugin it consumes.
- The grid consumes the `theme` capability and supplies the `grid` capability. It claims no namespace and adds no command.
- The grid does not import React or Ink. Both arrive through the host's injected dependencies, as [Generic Context and Dependencies](../specs/plugin-system/index.md#generic-context-and-dependencies) requires — a directly imported reconciler would be a second copy in the same process, rendering against different internal state than the host's.
- The stream printed output goes to arrives on the request rather than being reached for, which is what [Grid: Printing](../specs/grid/index.md#printing) requires and what keeps the plugin off the process's own streams. Printing is verified against an injected stream double, so the "identical bytes through a pipe" guarantee is asserted rather than assumed.
- The interactive half of [Grid](../specs/grid/) — [Interactive Grid](../specs/grid/index.md#interactive-grid), [Row Actions](../specs/grid/index.md#row-actions), and [Terminal Handover](../specs/grid/index.md#terminal-handover) — is **not** implemented by this change. [Change 0029](./0029-add-interactive-grid-row-actions.md) implements it.

## Design

### Approach

`plugins/grid/geometry.ts` holds every layout decision as pure functions over values: column widths from cells and headers, the gap, padding and alignment, flow placement, and where the empty and summary lines go. It imports nothing but the display-width measure.

`plugins/grid/cells.ts` holds normalization: control-character removal, the placeholder for an empty cell, and filling a short row out to the column count. The removal is applied to every consumer-supplied string the grid renders — headers, the empty message, the summary, a selecting request's message and an action's label as well as a cell's text — and to everything handed to [Dialogs](../specs/dialogs/) on the selecting path, as [Grid: Cell Values](../specs/grid/index.md#cell-values) requires, because a guarantee about what reaches the terminal that held for only some strings would not be a guarantee.

`plugins/grid/render.ts` turns a laid-out grid into elements through the injected React and Ink, resolving every appearance through the theme. It takes the output stream as an argument rather than reaching for one, because a renderer that writes to a stream cannot return a string.

Two widths are in play and they must not be confused. The *layout* width is what a width-dependent layout decides against — only the [flow](../specs/grid/index.md#flow-layout) has one — and it comes from the stream on the request, or eighty columns when that stream reports none, which is what makes a flow through a pipe determinate. The *canvas* width is what the renderer is given, and it is the measured grid's own width rather than the terminal's, so the renderer never pads a line out to the terminal and the emitted bytes do not depend on how wide the terminal happens to be. The renderer is put in a one-shot, non-interactive mode: no input handler, no alternate screen, no console patching, and no repaint sequences.

### Decisions

- **Decision**: `grid`, not `table`.
  - **Why**: the capability is cells in two dimensions; a table is one arrangement. Naming it `table` would make the flowed layout an odd fit inside its own capability and would invite a second capability for it later.
  - **Alternatives considered**: `table` with a separate `columns` or `list` capability for flow — two capabilities sharing all of their geometry.
- **Decision**: the grid takes strings and formats nothing.
  - **Why**: a duration, a timestamp, a byte count, and a relative time are policy — how precise, in whose timezone, rounded which way. A grid that decided them would make a product decision for every consumer, and would need a date library on the startup path of every unrelated command to do it.
  - **Alternatives considered**: built-in formatters; an injected formatter interface (the same coupling with an extra indirection).
- **Decision**: control characters are removed from every rendered string, not escaped or rejected.
  - **Why**: the text is not the consumer's own — it comes from a file, a process, or a network response. Rejecting would turn one bad row into a failed command; escaping would render noise. The printing contract promises no repaint sequences reach the stream, and that has to hold for the payload as received.
  - **Alternatives considered**: rejecting the request; escaping visibly; trusting the consumer.
- **Decision**: the canvas is the measured grid's width, not the terminal's, and the one width-dependent layout falls back to eighty columns.
  - **Why**: a renderer handed the terminal's width pads every line out to it, so the same grid emits different bytes on a wide terminal and through a pipe. Sizing the canvas from the measurement removes the dependency entirely for a table, which needs no width at all. A flow genuinely does need one, so it reads the stream's — and a fixed eighty when the stream reports none, because "undefined columns" has to resolve to some number and a stated one is reproducible where a renderer's private default is not.
  - **Alternatives considered**: the terminal's width for the canvas (breaks the guarantee); letting the renderer decide (probes the terminal, and its fallback is undocumented).
- **Decision**: print and select live in one capability even though only print is implemented here.
  - **Why**: they share every measurement decision. Two capabilities would duplicate the geometry and drift the moment one gained a rule the other did not.
  - **Alternatives considered**: shipping print as its own capability and adding select as a second — a rename or a merge later.

### Non-Goals

- Anything interactive. Row selection, row actions, and terminal handover are [Change 0029](./0029-add-interactive-grid-row-actions.md).
- Sorting, grouping, filtering, or paginating the supplied rows.
- Machine-readable output. A consumer offering JSON writes it itself and never routes it through the grid.
- Borders, rules, box drawing, zebra striping, or per-cell backgrounds.
- Column spanning, row spanning, nested grids, wrapped cells, or multi-line rows.
- Caller-specified column widths, weights, or horizontal scrolling.
- Any value formatting whatsoever.
- A public grid type export. The contract stays a local structural type between bundled plugins.

## Tasks

- [ ] Add the grid plugin's geometry and cells
  - [ ] `plugins/grid/cells.ts` — control-character removal over every rendered string, the `—` placeholder for an empty cell only, the column count, and short-row filling
  - [ ] `plugins/grid/geometry.ts` — column widths over cells and headers, gap, padding, start and end alignment, and the no-trailing-whitespace rule
  - [ ] Pure-function tests for widths over wide and astral characters, alignment, the empty and summary lines, trailing whitespace, the column count over ragged rows and a longer header row, and control-character removal in every rendered string
- [ ] Add the flow layout
  - [ ] Flow placement in `geometry.ts`: rows flattened to items in row then cell order, equal columns, down-then-across order, one column when nothing more fits, headers and per-cell alignment ignored, the empty and summary lines as in a table
  - [ ] Pure-function tests for placement, ordering, a multi-cell row contributing several items, the one-column floor, and trailing whitespace
- [ ] Render and print
  - [ ] `plugins/grid/render.ts` building elements through injected React and Ink, resolving appearances through the theme
  - [ ] One-shot non-interactive render that terminates, with the canvas sized from the measured grid and the flow's layout width taken from the request's stream, eighty when it reports none
  - [ ] `plugins/grid/index.ts` registering the `grid` capability and claiming no namespace; compose it in `cli.ts` after the theme plugin
  - [ ] Tests against an injected stream double asserting identical bytes with and without a TTY at one width, the eighty-column fallback for a stream reporting none, no repaint or screen-clearing sequences, and no hue when colour is disabled
- [ ] Show it in the demo
  - [ ] Add a printed-grid scenario to `demo/`, covered by the demo tests [Change 0024](./0024-relocate-and-cover-the-demo.md) adds

## Open Questions

- [ ] Whether the flow layout should ship in this change at all, given no bundled consumer produces one — it is specified because the capability is named for cells rather than tables, but it could be split into its own change and land when something needs it.
- [ ] What a printed table should do when the terminal is narrower than its natural width, beyond not re-flowing — [Grid: Open Questions](../specs/grid/index.md#open-questions) leaves it undecided and the answer likely depends on a real consumer's columns.
- [ ] Whether the summary line belongs to the grid at all, or whether a consumer should simply print its own line after the grid — it is here because a summary under a table is near-universal and its blank-line spacing is a layout decision.

## References

- Spec: [Grid](../specs/grid/)
- Related changes: [0026-add-theme-variables](./0026-add-theme-variables.md), [0029-add-interactive-grid-row-actions](./0029-add-interactive-grid-row-actions.md)
