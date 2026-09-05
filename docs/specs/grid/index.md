# Grid

## Overview

The grid capability lays text out in aligned cells and either prints it once or lets the user drive it. It is supplied by a bundled plugin as an internal capability, and it exists so that a plugin with rows to show does not have to own column measurement, display-width arithmetic, colour resolution, terminal-canvas sizing, or a renderer lifecycle — the parts every such plugin gets subtly wrong and none of them should have to solve twice.

A grid is not only a table. A table — a header row over columns of equal meaning — is one layout; a flow, where a list of short items fills as many columns as the terminal affords, is another. Both are the same cells measured the same way, so both belong to one capability.

## Background

Every plugin that has rows to show reaches the same wall. It measures column widths, discovers that string length is not display width, decides what an absent value renders as, decides whether to emit colour, discovers that colour depends on four environment variables with a precedence order, sizes a canvas so that piped output matches a terminal's, and then discovers that the renderer must be told not to behave like an application if the command is to print and exit. None of that is about the plugin's own subject, and all of it is easy to get almost right.

`tx` already owns the hard half. [Dialogs](../dialogs/) measures in display columns, truncates and pads against that measure, and holds a terminal correctly through a render. [Theming](../theming/) owns whether colour is emitted and what a role looks like. The grid is what makes that machinery reachable by a plugin that only wants to show rows.

The interactive grid then costs almost nothing extra: a driveable grid is a select over rows, and [Dialogs](../dialogs/) already owns selecting, filtering, scrolling, and opening a sub-dialog. The grid supplies the cells; dialogs supplies the driving.

## Requirements

### Grid Capability

- The grid capability MUST be supplied by a bundled plugin registered under the opaque registry key `grid`, and its provider MUST NOT claim a command namespace.
- The capability MUST expose printing a grid and selecting a row of one, and MUST NOT expose a renderer, a component, or a layout primitive.
- A consumer MUST read the capability while its command runs rather than during its own initialization.
- The contract MUST remain a local structural type shared by bundled plugins; nothing about grids MUST enter `src/` or the public `@fx/tx/plugin` contract.
- The grid MUST resolve every appearance through [Theming](../theming/) and MUST NOT decide a hue, a dim, or an inversion itself.

The initial shape is conceptual:

```ts
// ThemeVariable is [Theming]'s; nothing about it is redefined here.

type Cell = {
  readonly text: string
  readonly variable?: ThemeVariable
  readonly align?: "start" | "end"
}

type Row = readonly (Cell | string)[]

// The stream printed output is written to. Only its width and its TTY-ness
// are read; the grid never reaches for the process's own streams.
type OutputStream = {
  write(chunk: string): unknown
  readonly columns?: number
  readonly isTTY?: boolean
}

type GridRequest = {
  readonly stream: OutputStream
  readonly layout?: "table" | "flow"
  readonly headers?: readonly string[]
  readonly rows: readonly Row[]
  readonly empty?: string
  readonly summary?: string
}

// Actions are declared per row, so two rows may offer different ones.
type GridAction<A> = {
  readonly label: string
  readonly value: A
}

type GridSelectRow<T, A> = {
  readonly cells: Row
  readonly value: T
  readonly actions?: readonly GridAction<A>[]
}

type GridSelectRequest<T, A> = {
  readonly message: string
  readonly headers?: readonly string[]
  readonly rows: readonly GridSelectRow<T, A>[]
}

type GridSelection<T, A> = {
  readonly value: T
  readonly action?: A
}

type Grid = {
  print(request: GridRequest): void
  select<T, A>(
    request: GridSelectRequest<T, A>,
  ): Promise<GridSelection<T, A> | undefined>
}
```

A selecting request carries no stream: a dialog reads and draws through the streams [Dialogs](../dialogs/) was injected with, and [Terminal Handover](#terminal-handover) depends on it being those streams and no others.

#### Scenario: Capability used by a command

- **GIVEN** a bundled grid provider has initialized successfully
- **WHEN** a consumer reads the `grid` key while its command runs
- **THEN** it receives exactly one grid and can print rows without naming an appearance

### Cell Values

A cell's text arrives from the consumer, and a consumer's text arrives from somewhere it does not control. The grid MUST therefore treat it as data.

- A cell supplied as a bare string MUST mean exactly the cell that string would make with no variable and no alignment, so the shorthand and the full form differ in notation alone. A row MAY mix the two forms freely.
- Every string the grid renders MUST have its control characters removed before it is measured or drawn, so text carrying a newline, a carriage return, or an escape sequence can neither break the layout apart nor reach the terminal as a command. This binds every consumer-supplied string without exception — a cell's text, a header, the empty message, the summary, a selecting request's message, and an action's label — because the guarantee [Printing](#printing) makes about what reaches the terminal cannot hold for only some of them.
- The removal MUST also be applied to every string the grid hands to [Dialogs](../dialogs/) when [selecting](#interactive-grid). The grid is where text the consumer did not author enters `tx`, so it is where the text is made safe; a dialog's own callers own what they pass it, and this specification adds nothing to that contract.
- Text MUST be measured in terminal display columns rather than code units, so a row of wide or astral characters occupies the columns it will actually take.
- A cell whose text is empty after that removal MUST render a placeholder rather than an empty column, and the placeholder MUST be `—`. The placeholder MUST NOT be substituted for an empty header, empty message, empty summary, or empty action label, which are the consumer's to leave blank.
- A string MUST NOT be trimmed, wrapped, re-cased, re-ordered, or otherwise rewritten beyond removing control characters.
- A grid's column count MUST be the largest number of cells any one of its rows supplies, or the number of headers where more headers are supplied than that. A row supplying fewer cells than that count MUST have its missing trailing cells rendered as the placeholder rather than having its row shortened.

#### Scenario: A cell carrying an escape sequence

- **GIVEN** a screen-clearing escape sequence in a cell's text, in a header, in the empty message, in the summary, and in an action's label
- **WHEN** the grid renders, printing and selecting alike
- **THEN** no sequence reaches the terminal, every row and line keeps its shape, and the remaining text is drawn

#### Scenario: A cell of wide characters

- **GIVEN** a cell holds characters each occupying two terminal columns
- **WHEN** the grid measures its column
- **THEN** the column is wide enough for the columns the text occupies on screen, not for its code-unit count

### Table Layout

- A table MUST align every cell of a column to one width, and that width MUST be the widest cell in the column, header included.
- Columns MUST be separated by a fixed gap, and the final column MUST NOT be padded, so no line carries trailing whitespace.
- A cell MUST be padded to its column's width at its end by default, and a cell asking to be aligned at its end MUST be padded at its start instead, so a column of counts lines up on its digits.
- A header row, when supplied, MUST be drawn once above the rows and MUST be emphasized relative to them.
- A grid asked to draw no rows MUST print its supplied empty message, and MUST NOT print a header row over nothing.
- A summary, when supplied, MUST be drawn once beneath the rows, separated from them by a blank line, and MUST be de-emphasized relative to them.
- A grid with no rows and a summary MUST print the empty message, then that same blank line, then the summary. The empty message stands where the rows would have been and is separated from the summary exactly as rows would have been, so the spacing beneath a grid does not change with whether it happened to have anything in it. A grid with no rows and no summary MUST print the empty message alone, with no trailing blank line.
- When the terminal is narrower than the table's natural width, the table MUST NOT re-wrap or re-flow a column in a way that changes which row a cell belongs to.

#### Scenario: Aligned columns

- **GIVEN** rows whose first cells are `alpha`, `b`, and `charlie-delta`
- **WHEN** the table renders
- **THEN** every second cell begins at the same terminal column

#### Scenario: Empty grid

- **GIVEN** a grid with a header row and no rows, and the empty message `Nothing to show.`
- **WHEN** it renders
- **THEN** `Nothing to show.` is printed and no header row appears

#### Scenario: Empty grid with a summary

- **GIVEN** a grid with no rows, the empty message `Nothing to show.`, and a summary
- **WHEN** it renders
- **THEN** `Nothing to show.` is printed, then one blank line, then the summary

#### Scenario: No trailing whitespace

- **GIVEN** any table whose last column's cells differ in width
- **WHEN** it renders
- **THEN** no printed line ends in a space

### Flow Layout

A flow is the same cells with no column meaning: a list of short items filling the width available.

- A flow's items MUST be the cells of its rows, flattened into one sequence in row order and, within a row, in cell order. A row of one cell therefore contributes one item, and a row of several contributes several. The rows are how a request carries cells; only a table gives a row's shape any further meaning, so a flow MUST NOT reject a multi-cell row, MUST NOT join one into a single item, and MUST NOT pad rows out to a common length.
- A flow MUST place its items into as many equal columns as the width available affords, and MUST use one column when it affords no more.
- Items MUST read down each column before across, so a flowed list stays alphabetical down the page.
- Every item MUST be padded to the shared column width except the last on its line, so no line carries trailing whitespace.
- A flow MUST ignore a supplied header row and MUST ignore a cell's declared alignment, because its columns carry no per-column meaning and there is nothing for a cell to be aligned against; supplying either MUST NOT be an error. A cell's declared variable MUST still be honoured, because that is a property of the cell rather than of a column.
- A flow MUST draw the empty message and the summary exactly as [Table Layout](#table-layout) requires, so the two layouts differ only in how the cells are placed.

#### Scenario: Items flow down then across

- **GIVEN** six items and a width affording two columns
- **WHEN** the flow renders
- **THEN** the first three items form the left column and the remaining three the right

#### Scenario: A multi-cell row contributes several items

- **GIVEN** a flow of two rows, the first carrying the cells `alpha` and `beta` and the second carrying `gamma`
- **WHEN** the flow renders
- **THEN** it places three items in the order `alpha`, `beta`, `gamma`

### Printing

Printing is a command producing output and finishing, not an application taking the terminal.

- Printing MUST write to the stream the consumer supplies and MUST NOT reach for the process's own standard output or error.
- Printing MUST render once and terminate, and MUST NOT hold the terminal open, install an input handler, enter an alternate screen buffer, or patch the console.
- The bytes printed MUST be identical whether the stream is a terminal or a pipe, given the same width, apart from the hues [Theming: Colour Enablement](../theming/index.md#colour-enablement) drops. Nothing about the output MUST depend on the stream beyond the width it reports and that colour decision.
- Printed output MUST NOT contain cursor-positioning, screen-clearing, or repaint escape sequences.
- The grid MUST take the width it lays out against from the stream the consumer supplied, and MUST NOT probe the terminal by any other means. A stream reporting no width MUST be treated as eighty columns, so a layout that depends on the width — the [flow](#flow-layout) — still produces one determinate answer through a pipe.
- Printing MUST NOT require an interactive stream, so a grid remains printable when output is redirected.

#### Scenario: Piped output matches the terminal

- **GIVEN** a grid printed to a terminal of eighty columns and the same grid printed through a pipe reporting no width
- **WHEN** both outputs are compared with hues removed
- **THEN** they are byte-identical

#### Scenario: Printing leaves the terminal alone

- **GIVEN** a command prints a grid and returns
- **WHEN** the output is inspected
- **THEN** it carries no repaint or screen-clearing sequence and the scrollback above it is untouched

### Interactive Grid

- Selecting MUST present the grid's rows as the options of a select supplied by [Dialogs](../dialogs/), so movement, filtering, the viewport, the cursor bar, and cancellation behave exactly as [Dialogs: Selection](../dialogs/index.md#selection) and [Dialogs: Filtering](../dialogs/index.md#filtering) require, and this specification restates none of it.
- A row's cells MUST be presented as the multi-cell option [Dialogs: Select Request](../dialogs/index.md#select-request) owns, so alignment within a row is one contract rather than two.
- Every row MUST carry the value that identifies it, declared on the row rather than in a list parallel to the rows, so a row the caller cannot identify is unrepresentable rather than rejected.
- A cell's declared `variable` MUST NOT survive into a selecting grid: every cell of a row presented through [Dialogs](../dialogs/) is drawn as `content`, whatever role it declared for printing. [Dialogs: Select Request](../dialogs/index.md#select-request) takes an option's cells as display text, and [Dialogs: Presentation](../dialogs/index.md#presentation) requires every column's cursor bar to be the inversion alone with no cell shaded differently beneath it; a per-cell role would have to be composed with that bar on the active row and would contradict it. A consumer that needs a row's state visible while selecting MUST put it in a cell's text.
- Selecting MUST require the interactive streams a dialog requires, and MUST reject rather than fall back to printing when they are absent.
- A cancelled selection MUST resolve to nothing, MUST print nothing, and MUST NOT assign an exit code.
- A grid MUST NOT be both printed and selected in one call; a consumer choosing between them owns that choice.

#### Scenario: Select a row

- **GIVEN** an interactive grid of three rows
- **WHEN** the user moves to the second and confirms
- **THEN** the selection carries the value the caller supplied for that row

#### Scenario: A cell's role does not survive selection

- **GIVEN** a row whose second cell declares the `danger` variable
- **WHEN** the same row is printed and then presented for selection
- **THEN** the printed cell carries `danger` and the selectable one is drawn as `content`

### Row Actions

- A row MAY declare its own actions, and they MUST be presented as the sub-dialog that row opens, so acting on a row is the drilling [Dialogs: Sub-Dialog Columns](../dialogs/index.md#sub-dialog-columns) already owns. Actions are declared per row rather than once for the grid, so two rows MAY offer different ones and a row MAY offer none while its neighbour does.
- A selection MUST report which row was chosen and, when the chosen row declared actions, which action was chosen, so a consumer never has to infer one from the other. [Dialogs: Sub-Dialog Columns](../dialogs/index.md#sub-dialog-columns) resolves a nested select with the completing option's value alone, so the grid MUST carry enough through the actions column to recover both and MUST NOT ask the consumer to reconstruct the row from the action.
- A row declaring no actions MUST resolve on the row alone, so a grid used only to pick something needs no action model.
- The grid MUST NOT run, spawn, interpret, or name a command. What an action means belongs to the consumer that declared it.

#### Scenario: Act on a row

- **GIVEN** an interactive grid whose rows declare the actions `connect` and `open logs`
- **WHEN** the user confirms a row and then confirms `connect`
- **THEN** the selection carries both that row's value and the `connect` action

#### Scenario: Backing out of the actions

- **GIVEN** the actions for a row are on screen
- **WHEN** the user backs out
- **THEN** the row list is being driven again with its cursor where it was, and nothing has been selected

### Terminal Handover

The first thing a consumer will want to do with a chosen row is run something on it. That MUST be possible without the consumer knowing anything about how a dialog held the terminal.

- Selecting MUST NOT settle until the terminal has been restored and the renderer unmounted, under the guarantee [Dialogs: Terminal Streams and Cleanup](../dialogs/index.md#terminal-streams-and-cleanup) already owns.
- Once a selection has settled, a process the consumer starts on the same terminal MUST find it in the state it was in before the grid ran: no raw mode, no input handler installed by the grid, and no further output written by the grid or by anything it drove.
- The grid MUST NOT write to standard output while selecting, so a consumer's own output and a launched process's output remain the only things on it.
- A failed or cancelled selection MUST leave the terminal in that same restored state, so a consumer never has to repair a terminal it did not break.

#### Scenario: A launched process inherits a clean terminal

- **GIVEN** a consumer selects a row and immediately starts an interactive process on the same terminal
- **WHEN** that process reads from the terminal
- **THEN** it finds the terminal in its pre-dialog state and receives the user's keystrokes itself

## Design

### Ownership

The grid plugin owns cell sanitation, display-width measurement, column and flow geometry, the empty and summary lines, and the one-shot print. It owns no subject matter: it never fetches, never parses a payload, never formats a date or a duration, and never decides what a row means.

It consumes two capabilities and supplies one. [Theming](../theming/) answers what a variable looks like; [Dialogs](../dialogs/) answers how a list is driven. Neither is re-implemented here.

### Why Geometry Is Pure

Widths, gaps, padding, alignment, flow placement, and the empty and summary lines are decided from values alone, so they are testable as pure functions rather than through a rendered frame. This is the rule [Dialogs](../dialogs/) already follows for its column geometry, and it is what makes a width bug a failing assertion on a number instead of a diff of a drawn panel.

### Why Formatting Is Not Here

A duration, a timestamp, a byte count, and a relative time are all things a consumer will want in a cell, and none of them belong to the grid. They are policy — how precise, in whose timezone, rounded which way — and a grid that decided them would be making a product decision on behalf of every consumer. The grid takes strings.

### Why Print and Select Are One Capability

They share every measurement decision and differ only in what drives them. Splitting them would duplicate the geometry, and the duplication would drift the moment one of them gained a column rule the other did not.

## Constraints

- Sorting, grouping, filtering the supplied rows, pagination, and any query language are out of scope. A consumer supplies the rows it wants, in the order it wants them.
- Borders, rules, box drawing around a printed grid, zebra striping, and per-cell background fills are out of scope.
- Column spanning, row spanning, nested grids, wrapped multi-line cells, and per-row heights are out of scope; a row is one line.
- Caller-specified column widths, minimum or maximum widths, weights, and horizontal scrolling are out of scope.
- Machine-readable output — JSON, CSV, TSV — is out of scope. A consumer that offers it writes it itself and never routes it through the grid.
- Value formatting of every kind is out of scope: durations, dates, relative times, numbers, byte sizes, and truncation policy for a consumer's own text.
- Mouse input, column reordering, resizable columns, multi-row selection, and in-place editing of a cell are out of scope.
- Match highlighting within a cell is out of scope, as it is for [Dialogs](../dialogs/).
- Running, spawning, or supervising a process is out of scope; the grid reports a chosen action and nothing more.
- A public grid type export is out of scope while the only consumers are bundled plugins.

## Open Questions

- Whether `flow` earns its place before a bundled consumer needs it is undecided. It is specified because the capability is named for cells rather than tables and because a flowed list is the second-most-common shape a CLI shows, but no bundled command produces one today.
- Whether a printed grid SHOULD do anything at all when the terminal is narrower than its natural width, beyond not re-flowing, is undecided. Dropping a column, eliding one, and letting the terminal wrap are all defensible, and the right answer likely depends on a real consumer's columns.
- Whether the placeholder for an absent value SHOULD be caller-supplied rather than fixed at `—` is undecided; fixing it keeps grids across plugins looking alike, which is the stronger default until someone has a reason.
- Whether a selection SHOULD be able to report that the user chose a row and explicitly declined every action, distinctly from cancelling, is undecided.
- Whether a selectable row's cells SHOULD be able to carry their declared variable after all is undecided. The reason they cannot is [Dialogs](../dialogs/)' rule that a cursor bar is the inversion alone, and that binds only the active row; whether the rows behind it could keep their roles without the list reading as two different things is the open part.
- Whether the grid SHOULD offer a repeating select — return to the rows after the consumer has acted, as a file manager does — is undecided. It would require the grid to know when the consumer's action finished, which is process lifecycle it deliberately does not own today.

## References

- [Dialogs](../dialogs/)
- [Theming](../theming/)
- [Plugin System](../plugin-system/)
- [Architecture](../architecture/)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-09-05 | Initial grid capability, cell model, table and flow layouts, and printing | [0028-add-the-grid-plugin](../../changes/0028-add-the-grid-plugin.md) |
| 2026-09-05 | Interactive grid, row actions, and the terminal-handover guarantee | [0029-add-interactive-grid-row-actions](../../changes/0029-add-interactive-grid-row-actions.md) |
