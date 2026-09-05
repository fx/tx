# Dialogs

## Overview

`tx` provides a bundled dialogs plugin for terminal interactions shared by its own plugins. The plugin MUST expose dialogs through the generic registry rather than through core vocabulary, and its contract MUST contain only a single-choice `select` dialog and a single-field text `input` dialog, which compose when a select option is marked as user-provided.

[Change 0016](../../changes/0016-add-plugin-capabilities-and-dialogs.md) implements the generic registry that carries the internal capability and the namespace-free bundled provider that supplies `select`. [Change 0017](../../changes/0017-add-dialog-text-input-and-composition.md) implements the text `input` dialog and the user-provided option that composes the two. Those requirements are implemented.

[Change 0020](../../changes/0020-add-select-filter-and-viewport.md) implements the [Filter Request](#filter-request), [Filtering](#filtering), and [Viewport](#viewport) sections, together with the Home, End, and Page rules added to [Selection](#selection). Those requirements are implemented. [Change 0021](../../changes/0021-restyle-dialogs-as-norton-commander.md) implements [Presentation](#presentation) together with the confirmation wording added to [Selection](#selection). Those requirements are implemented. [Change 0023](../../changes/0023-render-sub-dialogs-as-columns.md) implements the [Sub-Dialog Columns](#sub-dialog-columns) section together with its column rules in [Presentation](#presentation), the always-live [Filter Request](#filter-request), and the chrome the [Viewport](#viewport) sets into the frame's edges. Those requirements are implemented.

The cell-width guarantee in [Presentation](#presentation), the delegation of every appearance to [Theming](../theming/), and the aligned cells and headers in [Select Request](#select-request), [Filtering](#filtering), and [Presentation](#presentation) are **not yet implemented**. [Change 0025](../../changes/0025-guarantee-cell-width-by-construction.md), [Change 0026](../../changes/0026-add-theme-variables.md), and [Change 0027](../../changes/0027-add-multi-cell-select-rows.md) implement them in that order.

## Background

Plugins already receive the host's React and Ink instances and injected process streams through the [Plugin System](../plugin-system/). They can render their own terminal interfaces, but unrelated plugins have no supported way to share one runtime capability.

The dialogs plugin provides that first concrete use of the generic registry. It owns terminal interaction policy while callers own the meaning of selection, cancellation, output, and command failure.

## Requirements

### Dialog Capability

- The bundled dialogs plugin MUST register one dialog capability under the opaque registry key `dialogs` and MUST NOT claim a command namespace.
- The dialog capability MUST expose only `select` and `input`; confirm and every other dialog are outside the contract.
- A consumer MUST read the capability while its command runs, after plugin initialization has completed, rather than snapshotting it during initialization.
- The dialogs plugin and its consumers MUST use a local structural contract; the capability MUST NOT add dialog types or runtime values to `@fx/tx/plugin`.
- A consumer MUST own the behavior for an absent dialog capability; the registry and provider MUST NOT prescribe that command's output or exit code.

Conceptual internal shape:

```ts
type TextField = {
  readonly type: "text"
  readonly name: string
  readonly message: string
  readonly initialValue?: string
}

type SelectOption<T> = {
  readonly label?: string
  readonly cells?: readonly string[]
  readonly value: T
  readonly fields?: readonly TextField[]
  readonly dialog?: SelectRequest<T> | TextField
}

type SelectRequest<T> = {
  readonly message: string
  readonly options: readonly SelectOption<T>[]
  readonly headers?: readonly string[]
  readonly filter?: "typed" | "always"
  readonly expand?: "enter" | "tab"
}

type SelectResult<T> = {
  readonly value: T
  readonly values: Readonly<Record<string, string>>
}

type InputRequest = {
  readonly message: string
  readonly initialValue?: string
}

type Dialogs = {
  input(request: InputRequest): Promise<string | undefined>
  select<T>(request: SelectRequest<T>): Promise<SelectResult<T> | undefined>
}
```

The exact structural representation MAY vary, but it MUST preserve the owned contracts above.

#### Scenario: Capability used by a command

- **GIVEN** the dialogs provider and an internal consumer initialized successfully
- **WHEN** the consumer reads `dialogs` while its command runs
- **THEN** it can present a selection without importing the provider's implementation

#### Scenario: Provider claims no namespace

- **GIVEN** the dialogs plugin registers its capability and no commands
- **WHEN** root help is rendered
- **THEN** no dialogs namespace appears

### Select Request

- `select` MUST reject a request with no options before rendering or changing terminal state.
- `select` MUST render the request message and the display text of every option the [filter](#filtering) leaves visible and the [viewport](#viewport) has room for.
- `select` MUST treat an option's display text as display text and option values as opaque values.
- An option MUST declare either one label or a list of cells, and MUST NOT declare both or neither; a request violating that MUST be rejected before rendering or changing terminal state.
- Every option of one column MUST declare the same one of those two shapes. A column mixing label options with cell options MUST be rejected before rendering or changing terminal state: a label is not a one-cell row, and treating it as one would put a lone label into a field measured against cells that mean something else. Each column decides its own shape independently, exactly as it decides its own headers, so a column of labels MAY open a column of cells and the reverse.
- An option declaring cells MUST have its cells aligned into fields shared with every other option of its column, as [Presentation](#presentation) requires, so a column of cells reads as a table rather than as padded labels.
- A column of cell options MUST declare the same number of cells on every one of them, and a request violating that MUST be rejected before rendering or changing terminal state.
- A request MAY declare headers for its own column, and headers MUST be accepted only on a column of cell options and MUST match those cells in number; a request violating either MUST be rejected before rendering or changing terminal state.
- `select` MUST preserve option order and MUST NOT remove options whose display text or values repeat.
- The first option MUST be active when the dialog opens.
- An option that declares no fields MUST be a plain option, and an option that declares fields MUST be a user-provided option.
- `select` MUST reject a request in which an option declares an empty field list or repeats a field name within that same option, before rendering or changing terminal state.

#### Scenario: Invalid empty request

- **GIVEN** a caller supplies an empty options array
- **WHEN** it calls `select`
- **THEN** the call rejects before rendering anything

#### Scenario: Duplicate options remain available

- **GIVEN** two options have equal labels or values
- **WHEN** the dialog renders
- **THEN** both appear in their supplied positions and can be selected independently

#### Scenario: Invalid field declaration

- **GIVEN** an option declares two fields sharing one name, or an empty field list
- **WHEN** the caller calls `select`
- **THEN** the call rejects before rendering anything

#### Scenario: Invalid cell declaration

- **GIVEN** a column whose options declare differing numbers of cells, or an option declaring both a label and cells or neither, or a column mixing label options with cell options, or headers declared on a column of labels, or headers whose count differs from its column's cells
- **WHEN** the caller calls `select`
- **THEN** the call rejects before rendering anything

#### Scenario: Cells align across a column

- **GIVEN** a column of options whose first cells are `alpha`, `b`, and `charlie-delta`
- **WHEN** the dialog renders
- **THEN** every option's second cell begins at the same terminal column

### Selection

- Up and Down input MUST move the active option by one position among the visible options and MUST keep it at the first or last visible option when movement would pass that boundary.
- Home and End input MUST make the first and the last visible option active.
- Page Up and Page Down input MUST move the active option by the number of option rows the [viewport](#viewport) shows, clamped at the first and last visible option.
- Enter on a plain option declaring no sub-dialog MUST confirm the selection and resolve with a result carrying the exact value belonging to that option and no collected values; [Sub-Dialog Columns](#sub-dialog-columns) governs Enter on an option that declares one.
- Escape or Ctrl-C before a selection is confirmed MUST cancel the dialog and resolve with `undefined` without terminating the process; after confirmation the outcome is fixed, and [Presentation](#presentation) bounds how long settlement may take.
- Printable input MUST always reach the [filter](#filtering); there is no state of an open list in which typing leaves the dialog unchanged.
- The dialog MUST NOT print the selected value or assign cancellation an exit code; those decisions belong to the consuming command.

Every option is visible while the filter text is blank; [Filtering](#filtering) defines visibility otherwise.

#### Scenario: Select a value

- **GIVEN** a dialog with three plain options and the first active
- **WHEN** the user presses Down and then Enter
- **THEN** `select` resolves with a result whose value is the second option's value and whose collected values are empty

#### Scenario: Movement stops at a boundary

- **GIVEN** the last option is active
- **WHEN** the user presses Down
- **THEN** the last option remains active

#### Scenario: Jump to the end

- **GIVEN** a dialog with thirty options and the first active
- **WHEN** the user presses End, then Page Up
- **THEN** the last option becomes active, and then the option one viewport height above it

#### Scenario: Cancel without exiting

- **GIVEN** a selection dialog is active
- **WHEN** the user presses Escape or Ctrl-C
- **THEN** `select` resolves with `undefined` and the host process remains available to the consuming command

### Filter Request

- Filtering MUST always be live: typed text MUST narrow the list in every column and whatever the list's length. There MUST be no setting that makes typing do nothing.
- A select request MAY carry a `filter` setting of `"typed"` or `"always"`, and an omitted setting MUST mean `"typed"`. It MUST decide only whether the filter is on screen before anything has been typed into it.
- `"typed"` MUST keep the filter off screen until something is typed into it, and `"always"` MUST show it from the moment the dialog opens.
- The setting belongs to the request it is written on: a nested sub-dialog request MUST decide its own column's filter, and an omitted setting MUST mean `"typed"` there too. Unlike the `expand` binding, it MUST NOT be read from the root request for every column.

#### Scenario: Typing brings the filter up

- **GIVEN** a request with no `filter` setting
- **WHEN** the dialog opens and the user types `a`
- **THEN** the filter was not on screen before the keystroke, is after it, and the options are narrowed to those matching `a`

#### Scenario: Filter shown before a keystroke

- **GIVEN** a request with `filter: "always"`
- **WHEN** the dialog opens
- **THEN** the filter is on screen with no text in it

### Filtering

- The filter MUST be the element that receives typed text from the moment the dialog opens, with no key moving focus to or from it.
- Printable input and Backspace MUST edit the filter text exactly as they edit a [text input's](#text-input) value.
- The dialog MUST render the current filter text once there is any, and MUST render it in a place whose appearing and disappearing moves no option row.
- The filter's terms are the whitespace-separated pieces of its text; an option MUST be visible when every term occurs within its display text under a case-insensitive comparison, or when the option declares fields.
- A term MUST be matched against an option's cells individually rather than against the cells joined together, so a term never matches by spanning the gap between two cells, and an option MUST be visible when every term occurs within at least one of its cells. Headers MUST NOT participate in matching.
- Visible options MUST keep their supplied order; the filter MUST NOT rank, reorder, or deduplicate them.
- Whenever the filter text changes, the first visible option MUST become active.
- When no option is visible, the dialog MUST indicate that nothing matches, Enter and navigation MUST do nothing, and cancellation MUST remain available.
- Escape MUST cancel the dialog even while the filter text is non-empty; it MUST NOT clear the filter instead.
- Once field collection begins, the filter MUST stop accepting input alongside option navigation.
- The filter text MUST NOT appear in the result.

#### Scenario: Type to narrow, then select

- **GIVEN** a dialog listing `Alpha`, `Beta`, `Gamma`, and `Alphabet`
- **WHEN** the user types `alp` and presses Enter
- **THEN** only `Alpha` and `Alphabet` were visible, in that order, and `select` resolves with `Alpha`'s value

#### Scenario: Terms match cells individually

- **GIVEN** a column of cell options, one of which carries the cells `alpha` and `beta`
- **WHEN** the user types `alphab`
- **THEN** that option is not visible, because no single cell contains the term

#### Scenario: Several terms in any order

- **GIVEN** a dialog listing `release branch`, `branch archive`, and `main`
- **WHEN** the user types `branch rel`
- **THEN** only `release branch` is visible

#### Scenario: Backspace widens the match

- **GIVEN** the filter text `gam` leaves only `Gamma` visible
- **WHEN** the user presses Backspace three times
- **THEN** every option is visible again and the first is active

#### Scenario: A user-provided option stays reachable

- **GIVEN** a dialog whose last option is `Other…` with a text field
- **WHEN** the user types `zzz`
- **THEN** `Other…` is the only visible option, and it is active

#### Scenario: Nothing matches

- **GIVEN** a dialog with plain options only
- **WHEN** the user types text no label contains and presses Enter
- **THEN** the dialog shows that nothing matches, stays open, and Escape still resolves `undefined`

#### Scenario: Navigation survives the filter

- **GIVEN** the filter text leaves three options visible
- **WHEN** the user presses Down twice
- **THEN** the third visible option is active, whatever its position in the supplied list

### Viewport

- The dialog MUST render at most ten option rows at once, and fewer so that the dialog as a whole — its edges and hints included — stays shorter than the terminal. One row is the floor wherever the terminal can afford one and something is visible to fill it; where the terminal cannot afford that row, or the filter has left nothing visible, the dialog MUST render no option rows at all, because the row a terminal cannot afford is exactly the row that would take the frame to the terminal's own height and clear the screen when it is replaced.
- Whenever the terminal is tall enough for the dialog's other rows plus one option row, the dialog MUST NOT clear the terminal or scroll away what was on screen before it opened, on any frame or when it settles.
- Wherever the dialog renders any option rows, the active option MUST be among them, and the rendered window MUST move only as far as needed to keep it there. A window collapsed to no rows MUST keep the place it held, so the terminal growing back reopens it there rather than at the top of the list.
- When visible options exist above or below the rendered window, the dialog MUST indicate that on that side together with how many are hidden there. The counts describe the rightmost column, which is the one taking keys and the only one scrolling.
- After the terminal is resized, the rendered window MUST reflect the new row count.
- Opening a sub-dialog MUST NOT cost the dialog any rows: the columns sit beside each other rather than over each other, so every column is windowed against the same terminal height whatever the depth.
- The columns share one band of option rows, and the band is as tall as its tallest column. An entry panel appearing beneath the browser — a field under collection, or a text-field sub-dialog — MUST therefore shrink that band for every column rather than only for the one taking keys, because a column keeping a taller window would take the dialog past the terminal's height. Each column MUST return to the window it was left on once the band grows back, so the shrink costs no column its place in its own list.

#### Scenario: Long list opens at the top

- **GIVEN** a dialog with thirty options in a terminal of forty rows
- **WHEN** the dialog opens
- **THEN** the first ten options are rendered, the first is active, and the dialog indicates twenty more below

#### Scenario: Window follows the active option

- **GIVEN** the first ten of thirty options are rendered
- **WHEN** the user presses Down ten times
- **THEN** the eleventh option is active, options two through eleven are rendered, and the dialog indicates one above and nineteen below

#### Scenario: Short terminal shrinks the window

- **GIVEN** a dialog with thirty options in a terminal of eight rows
- **WHEN** the dialog opens
- **THEN** fewer than ten options are rendered and the active option is among them

#### Scenario: A terminal too short for a row keeps the screen

- **GIVEN** a dialog whose chrome plus one option row would fill the terminal exactly
- **WHEN** the dialog opens
- **THEN** no option rows are rendered, the dialog still draws its edges, still navigates, and still resolves with the choice it can no longer draw, and the terminal is neither cleared nor scrolled

### Field Model

- A field MUST describe exactly one value the user supplies and MUST carry a type that discriminates it, a name that is unique within the option declaring it, and a message to display while it is collected.
- `text` MUST be the only field type available to callers.
- A field name MUST be an opaque key that identifies the collected value to the caller and MUST NOT be rendered in place of the field's message.
- The fields of an option MUST form an ordered list whose order is the order they are collected in.
- A field's optional initial value MUST be the starting value when that field is collected, meaning exactly what it means for a standalone `input` request.

#### Scenario: Field names key the result

- **GIVEN** an option declares text fields named `owner` and `repository`
- **WHEN** the user supplies both values
- **THEN** the collected values are keyed by those names rather than by the messages displayed for them

#### Scenario: Field collected with an initial value

- **GIVEN** a chosen option declares a text field whose initial value is `origin`
- **WHEN** that field is collected
- **THEN** it starts with `origin` entered and editable, exactly as a standalone `input` request carrying that initial value would

### Text Input

- `input` MUST render the request message and the current value.
- `input` MUST begin with the request's initial value when one is supplied and MUST begin with an empty value otherwise.
- Printable character input MUST append to the current value in typed order.
- Input MAY arrive as more than one character at once, as a paste does; every printable character it carries MUST append in order, so a pasted chunk is appended whole. Control characters are never printable input, and neither is an escape sequence the host's input layer resolves to a key or leaves recognizable by its `CSI` introducer and final byte. A sequence that is neither MAY have its payload appended, because the leading escape is consumed before the dialog observes the input.
- Backspace MUST remove the last character of the current value and MUST do nothing when the value is empty.
- Any other input MUST leave the value unchanged.
- Enter MUST resolve with the current value exactly as entered, including the empty string; whether an empty value is acceptable belongs to the consuming command.
- Escape or Ctrl-C MUST cancel the dialog and resolve with `undefined` without terminating the process, so a caller can distinguish cancellation from an empty submission.
- `input` MUST NOT trim, validate, or transform the value, and MUST NOT write it to standard output.

#### Scenario: Enter a value

- **GIVEN** an input dialog with no initial value
- **WHEN** the user types `main` and presses Enter
- **THEN** `input` resolves with `main`

#### Scenario: Edit an initial value

- **GIVEN** an input dialog whose initial value is the four-character `main`
- **WHEN** the user presses Backspace five times and types `dev`
- **THEN** the fifth Backspace changes nothing, the rendered value is `dev`, and Enter resolves with `dev`

#### Scenario: Empty submission differs from cancellation

- **GIVEN** an input dialog with an empty value
- **WHEN** the user presses Enter in one run and Escape in another
- **THEN** the first run resolves with the empty string and the second resolves with `undefined`

### User-Provided Options

- Choosing a user-provided option MUST collect its fields instead of resolving immediately, one at a time rather than together, using the text input behavior above.
- The dialog MUST NOT present a field before the preceding field is submitted, and MUST NOT accept option navigation once field collection has begun.
- After the last field is submitted, `select` MUST resolve with a result carrying the chosen option's exact value and one collected value per declared field, keyed by that field's name.
- The result MUST let a caller tell the two kinds of option apart: a plain option carries no collected values, and a user-provided option carries exactly the field names it declared.
- Escape or Ctrl-C at any stage before the last field is submitted MUST cancel the entire dialog, resolve with `undefined`, and discard every value already collected; the dialog MUST NOT return to a previous stage or expose a partial result.

#### Scenario: Provide a value directly

- **GIVEN** a dialog offering two known branches and an option declaring one text field named `branch`
- **WHEN** the user chooses that option, types `release`, and presses Enter
- **THEN** `select` resolves with a result carrying that option's exact value and the collected value `release` under `branch`

#### Scenario: Several requested values

- **GIVEN** a chosen option declares text fields named `owner` and `repository` in that order
- **WHEN** the dialog collects them
- **THEN** `owner` is prompted and submitted before `repository` appears, and the result carries both collected values

#### Scenario: Cancel during field collection

- **GIVEN** the user has submitted the first of two fields
- **WHEN** the user presses Escape or Ctrl-C
- **THEN** `select` resolves with `undefined`, the already collected value is discarded, and the option list is not presented again

### Sub-Dialog Columns

An option MAY declare a sub-dialog holding a nested select request or a single text field:

- An option declaring a sub-dialog MUST be marked in its list, and opening one MUST add a column to the right of the column it was opened from, inside the same render session and inside the same frame.
- Enter MUST open the sub-dialog of an option that declares one, and MUST take an option that declares none. The right arrow MUST open a declared sub-dialog whatever the binding below, and MUST do nothing on an option declaring none.
- The root request MAY rebind opening from Enter to Tab. Under that binding Enter MUST take an option whether or not it declares a sub-dialog, and Tab MUST open a declared one. The binding MUST be read from the root request alone and MUST apply to every column.
- Only the rightmost column MUST answer keys; the columns left of it MUST stay rendered and ignore input until it closes.
- The left arrow MUST close the rightmost column and return to the one that opened it, and MUST do nothing at the leftmost column, where closing the dialog is Escape's alone.
- Escape or Ctrl-C with more than one column open MUST close only the rightmost and return to its parent with the parent's state unchanged; at the leftmost column it MUST cancel the dialog and resolve with `undefined`.
- Completing a nested select column MUST resolve the whole `select` with a result carrying the completing option's exact value and every input value collected along the path, keyed by field name with the deeper submission winning a repeated name.
- Submitting a text-field sub-dialog MUST resolve the whole `select` with a result carrying the opening option's exact value and every input value collected along the path including the submitted text under its field's name, keyed by field name with the deeper submission winning a repeated name.
- Opening a sub-dialog MUST NOT change its parent's filter text or active option, and closing it MUST restore exactly what the parent showed before it opened.
- The Tab binding MUST be answered from the Tab key report rather than from typed or pasted text; Shift+Tab reports the same key and MUST open a sub-dialog too rather than reaching the filter as text.
- `select` MUST reject before rendering when any reachable sub-dialog declares an empty options list, or when any reachable option declares an empty field list or repeats a field name within itself.

#### Scenario: Drill into a nested select

- **GIVEN** the active option declares a nested select whose second option is plain
- **WHEN** the user presses Enter, then Down, then Enter
- **THEN** the nested select opens as the column to its right and `select` resolves with the second nested option's value

#### Scenario: Submit a text leaf

- **GIVEN** the active option declares a text-field sub-dialog named `tag`
- **WHEN** the user presses the right arrow, types `nightly`, and presses Enter
- **THEN** `select` resolves with the opening option's value and the collected value `nightly` under `tag`

#### Scenario: Back out to the parent

- **GIVEN** a sub-dialog is open as the column right of its parent
- **WHEN** the user presses the left arrow or Escape
- **THEN** that column closes, the parent shows the same filter text and active option as before, and `select` stays open

#### Scenario: An entry opened over a column names backing out

- **GIVEN** a text leaf, or a field of an option chosen in an opened column, is taking input
- **WHEN** the user reads the hint line under its panel and presses Escape
- **THEN** the line reads `Enter submit · Esc back`, and Escape closes that entry and returns to the column that opened it rather than cancelling the dialog

#### Scenario: Opening without a declaration does nothing

- **GIVEN** the active option declares no sub-dialog
- **WHEN** the user presses the right arrow
- **THEN** nothing opens and the dialog stays on the same option

### Presentation

The look is Norton Commander's: framed panels, a title set into the frame, a full-width cursor bar, and a key bar underneath — in greyscale.

- Every dialog MUST be drawn inside a frame whose top edge carries its message as a title: the request message for a select or a standalone input, and the field's message for a field under collection.
- A select MUST use a double-line frame; a standalone input and a field under collection MUST use a single-line frame.
- Frame edges, the title, the key hints, the overflow counts, the filter prompt, the column divider, and a header row MUST be drawn as [Theming](../theming/)'s `chrome` variable; option cells, option labels, and entered text MUST be drawn as its `content` variable. The default theme renders `chrome` dimmed relative to `content`, which is the appearance this rule previously fixed directly.
- The active option MUST be rendered as [Theming](../theming/)'s `cursor` variable spanning its column's full width, which the default theme renders as the terminal's own inversion. The rightmost column MUST take whatever width the title or the edges left the panel spare, so a select showing one column has its bar spanning the frame's whole inner width.
- A dialog MUST resolve every appearance it draws through [Theming](../theming/) and MUST NOT choose a dim, an inversion, or a hue itself. Against the default theme a dialog therefore uses only the terminal's default foreground and background, their dimmed form, and their inversion, and emits no hue; that greyscale is the default theme's property rather than a prohibition this specification makes.
- The filter and the overflow counts MUST be set into the frame's own edges rather than drawn as rows of the panel: the filter into the bottom edge, the counts into the top and bottom edges on their right. Neither MUST cost the panel a row, and neither appearing nor disappearing MUST move an option row. The room the counts take MUST be held whether a count is showing or not, so the title does not resize as the reader scrolls. Both describe the rightmost column: it is the one taking keys, and it is the only one that scrolls.
- A dimmed key hint line MUST appear beneath the frame, naming exactly the keys the dialog answers where the reader is: a select's names moving, opening when the row under the cursor leads somewhere, taking when that row can be taken, backing out once a column has been opened, typing to filter, and cancelling; an entry's names submitting and then whichever of backing out or cancelling its own cancel key performs. A dialog MUST draw exactly one such line however many columns it is showing.
- Backing out and cancelling MUST NOT both be named. Above the leftmost column the cancel key backs out exactly as the left arrow does, so the line MUST name the two keys as the one thing they do there and MUST NOT promise a cancellation the dialog will not perform; cancelling MUST be named only at the leftmost column, where it is what the cancel key does. The same rule binds an entry: a standalone `input` and a field collected at the leftmost column MUST name cancelling, while a text leaf and a field collected in an opened column MUST name backing out, because their cancel key closes only that column.
- The line names the keys the dialog answers in the mode it is in — leftmost column or a column opened over it, list or entry — and MUST NOT track momentary availability. Typing to filter MUST be named whether or not the filter is on screen, because typing always filters. Moving and taking MUST stay named when a filter has left nothing to move over or take, though both are no-ops in that state. A phrase that came and went as the reader typed would be one more thing moving under them, which is the churn the filter and the overflow counts were set into the frame's edges to stop; a mode changes only when the reader opens or closes a column, which they do deliberately.
- Every column of a select MUST render inside one frame — the one the first level drew, and the only one however deep the reader goes — and a sub-dialog MUST NOT draw a border, an offset, or a shadow of its own. A text-field sub-dialog is not a column: it MUST render as its own single-line panel beneath the frame, as a collected field does.
- The columns MUST be laid out left to right in the order they were opened, separated by a dimmed divider, and MUST share one band of rows so lists of different lengths start on the same row.
- An option declaring a sub-dialog MUST be marked on the right edge of its column, on the same edge for every marked row of that column, drawn as [Theming](../theming/)'s `marker` variable.
- A cell MUST occupy exactly the columns its field was measured at, by construction rather than by a later truncation of the row it sits in. A field too narrow to hold both its text and a marker MUST drop the marker rather than overrun, and the row-level truncation the frame performs MUST remain a guard against a panel narrower than its content rather than the thing that makes a cell fit.
- An option's cells MUST be aligned into fields shared by every option of its column, each field as wide as its widest cell in that column and its header where one is declared, separated by a fixed gap. A field whose text does not fit MUST be truncated at its end with an ellipsis, so a narrow terminal loses characters from a cell rather than shifting the fields after it.
- A declared header row MUST be drawn once at the top of its column's band, MUST NOT be selectable, MUST NOT be filtered, MUST NOT scroll with the options beneath it, and MUST cost the [viewport](#viewport) one option row of the rows it had.
- A column a sub-dialog has been opened from MUST keep rendering what it was showing — the window its own filter text left it on, and its cursor bar on the choice it was left on — so the choices made on the way in stay readable beside the one being made now. The one thing that MUST move that window is the shared band shrinking under an entry panel, which shrinks it for every column at once, and the column MUST return to the window it was left on once the band grows back. It MUST be dressed at rest, with nothing on it animating. Its filter text and its hidden counts MUST NOT be drawn, because the edges that carry those belong to the column taking keys.
- Every column MUST draw its cursor bar identically: the bar is the inversion alone, and a column behind the driven one MUST NOT shade its bar or its label differently. Which column is being driven is said by where it sits — rightmost — and saying it a second time in a second way is what the reader has to unlearn.
- The frame's title MUST name the trail of the columns on screen.
- When the columns exceed the width available, the leftmost MUST be dropped first and the title MUST say that something was dropped. Dropping MUST stop at one column, which MUST be truncated to the width left rather than dropped.
- A frame MUST fit its content and MUST NOT exceed the terminal width; a title or label wider than the inner width MUST be truncated at its end with an ellipsis rather than wrapped, and filter text or a value under entry wider than the inner width MUST keep its end visible, so the caret is never cut off.
- Twenty columns is the narrowest supported terminal: below it, a dialog MUST lay itself out as if the terminal were twenty columns wide, and how the terminal wraps the result is unspecified.
- Text entry and the filter MUST show a caret after the current text, and the caret SHOULD alternate between visible and hidden at an interval between 400 and 600 milliseconds while the dialog waits for input. Only a line still answering keystrokes MUST carry one: a filter that has stopped accepting edits because a field is being collected MUST keep its text and its prompt and give up its caret.
- Confirming a plain option SHOULD flash the active bar before the dialog settles; once confirmed, the dialog MUST settle within 250 milliseconds and MUST ignore every key, cancellation included, because the choice is already made.
- An overflow indicator SHOULD pulse between its dimmed and normal rendering at the caret's interval.
- The caret blink and the indicator pulse MUST NOT delay input: a keystroke MUST be reflected in the very next render regardless of their phase.
- A dialog with no animated element on screen MUST NOT re-render on a timer.
- Every animation timer MUST be stopped before the dialog settles.
- A request rejected before rendering MUST still render nothing, frame included.

The glyphs are part of the contract, so tests and later changes have one source: the filter prompt is `›`, the caret is `█`, the overflow counts are `▲ N` on the top edge and `▼ N` on the bottom with `N` the hidden count, the no-match row reads `no match`, the marker on an option that opens a sub-dialog is `▸`, the divider between columns is `│`, the gap between the cell fields of one option is two spaces, and the trail in the title joins its columns with `›` and opens with `…` when columns have been dropped. The select hint line is assembled from `↑↓ move`, then `→/Enter open` on a row that leads somewhere (`→/Tab open` under the Tab binding), then `Enter select` unless Enter opens that row, then `←/Esc back` once a column has been opened, then `type to filter`, then `Esc cancel` at the leftmost column only, joined with ` · `; the entry hint line reads `Enter submit · Esc cancel` where Escape cancels the dialog — a standalone `input`, and a field collected at the leftmost column — and `Enter submit · Esc back` where it backs out instead — a text leaf, and a field collected in a column opened over the leftmost one. An entry offers no left arrow of its own, so it names Escape alone where the select's line reads `←/Esc back`.

Reference rendering of a select in a terminal of 80 columns and 10 rows, greyscale omitted; the [viewport](#viewport) leaves six option rows because the dialog's other three rows — the two frame edges and the hint line — must fit alongside them and still stay strictly under the terminal height. The filter and the counts are set into the edges the panel is already drawing, so neither takes a row:

```text
╔═ Which branch? ═════════════════ ▲ 1 ╗
║ release/1.4                          ║  ← inverted bar
║ release/1.5                          ║
║ release/1.6                          ║
║ release/2.0-rc                       ║
║ release/2.1                          ║
║ release/2.2                          ║
╚═ › rel█ ════════════════════════ ▼ 2 ╝
 ↑↓ move · Enter select · type to filter · Esc cancel
```

#### Scenario: Framed select with a title

- **GIVEN** a select whose message is `Which branch?`
- **WHEN** the dialog renders
- **THEN** a double-line frame appears with `Which branch?` set into its top edge, the active option is inverted across the frame's inner width, and a dimmed key hint line follows the frame

#### Scenario: A header names its fields

- **GIVEN** a column of cell options declaring headers
- **WHEN** the reader scrolls the list
- **THEN** the header row stays at the top of the band, is never selected, and never narrows the list when the reader types

#### Scenario: A cell fits its field without rescue

- **GIVEN** a column narrowed until a marked option's field affords only one terminal column
- **WHEN** the cell is built
- **THEN** it occupies exactly one column with the marker dropped, before the frame truncates anything

#### Scenario: Long label is truncated

- **GIVEN** a terminal of forty columns and an option label of sixty characters
- **WHEN** the dialog renders
- **THEN** the frame is no wider than forty columns and the label ends in an ellipsis on one row

#### Scenario: Caret blinks without delaying input

- **GIVEN** an input dialog waiting for input
- **WHEN** the user types `x` while the caret is in its hidden phase
- **THEN** the next render shows `x` followed by the caret

#### Scenario: Selection flash stays within budget

- **GIVEN** a select with the second plain option active
- **WHEN** the user presses Enter and then Escape 50 milliseconds later
- **THEN** the active bar flashes, the Escape changes nothing, and `select` settles with the second option's value within 250 milliseconds of the Enter

#### Scenario: Static dialog stays quiet

- **GIVEN** a select with three options, no filter on screen, and no overflow
- **WHEN** no input arrives for one second
- **THEN** nothing further is written to standard error

### Terminal Streams and Cleanup

- A dialog MUST read input only from the dialogs provider's injected standard-input stream.
- A dialog MUST render its prompts, options, and entered values only to the dialogs provider's injected standard-error stream, leaving standard output untouched for the consumer's data.
- A dialog MUST reject before rendering when its injected standard-input or standard-error stream is not an interactive terminal; it MUST NOT provide a non-interactive fallback.
- A dialog MUST restore the injected terminal's prior state and finish unmounting before its promise settles after completion, cancellation, or rendering failure.
- A `select` that collects fields MUST be one dialog: it MUST NOT restore terminal state, unmount, or settle between its selection and field stages. A `select` that opens sub-dialogs MUST be one dialog on the same terms: it MUST NOT restore terminal state, unmount, or settle between its columns.
- If an injected `setRawMode(false)`, `unref()`, or renderer `unmount()` method persistently throws, restoration or teardown through that API is impossible: a dialog MUST retry finitely, reject with the first applicable cleanup failure, and permit incomplete restoration or renderer teardown only on that exceptional path rather than hanging indefinitely.
- A rendering or interaction failure MUST reject the dialog and MUST NOT terminate the process directly.

#### Scenario: Command output remains clean

- **GIVEN** a consuming command reserves standard output for machine-readable data
- **WHEN** it presents a selection dialog
- **THEN** the prompt and options appear on standard error and standard output remains untouched until the consumer writes its result

#### Scenario: Non-interactive invocation

- **GIVEN** standard input or standard error is redirected rather than attached to an interactive terminal
- **WHEN** a command calls `select` or `input`
- **THEN** the call rejects without rendering or waiting for input

#### Scenario: Terminal restored before completion

- **GIVEN** an active dialog
- **WHEN** it selects, cancels, or fails
- **THEN** terminal state is restored and rendering is unmounted before the caller observes settlement

## Design

### Ownership

The dialogs plugin is an ordinary bundled provider outside `src/`. Core stores its value under an opaque key and has no dialog vocabulary. Internal consumers depend on a small structural `Dialogs` shape, not on the provider's module graph.

The provider obtains React, Ink, and process streams from its own initialization API. It renders interactive UI on standard error so command results may continue to use standard output. The caller decides whether cancellation is success, failure, or no action.

### Composition

A caller that only needs a value calls `input` directly. A caller that offers known choices alongside "let me type it" declares the fields on the option that means that, so one dialog covers both. The provider owns the transition between stages, which keeps the caller from stitching two dialogs together with its own terminal state, cancellation, and cleanup handling in between.

Fields are the extension point. A field carries a discriminating type, so a later field kind is a new type rather than a new dialog method or a second request shape, and a later multi-choice dialog can reuse the same option and field declarations. `text` is the only type that exists today; nothing about the model presumes the collection is a form, and nothing about it forecloses one.

Results carry the option's value and the collected values side by side because the two are different kinds of information: the value is opaque and the caller's own, while the collected values are strings the provider gathered against names the caller chose. Merging them would require the provider to interpret the caller's value.

### Registry Use

The provider registers during initialization. Consumers read committed values inside command actions, when all successful root and child plugins have initialized. Repository composition supplies one dialogs provider; behavior with additional values under the same key belongs to neither this spec nor the initial consumer contract.

### Why the Filter Is Plain

The filter has one job: let a user type a few characters and press Enter. That is why there is no focus model — the filter is always the thing typed text reaches, and arrows, Enter, and Escape keep the meanings they have in an unfiltered select. Substring matching on whitespace-separated terms is deliberately plain: it is predictable, needs no ranking, and every visible option keeps the position the caller gave it, so a list a caller ordered by relevance stays ordered by relevance under a filter. Options that declare fields are the caller's escape hatch, and a filter that could hide the escape hatch would defeat it, so they are always visible.

Filtering is always live because there is no second thing a printable character could sensibly mean at a list, and a reader who starts typing at one is asking for exactly one thing. What a caller can decide is only whether the filter takes up room before it has been used, which is a presentation question rather than a behavioral one — hence a setting about showing rather than about enabling.

### Why a Viewport

A bounded window is what makes a long list usable at all, filter or not, and it is what keeps rendering cost proportional to what is on screen rather than to the option count. The window scrolls minimally so the list does not jump under the cursor bar, and the indicators show how much is hidden so the user knows whether to keep scrolling or start typing.

### Why Norton Commander

The Norton Commander vocabulary — double-line panels, a title set into the frame, an inverted cursor bar, a key bar — is familiar and reads well in a monospace grid without any color, which is why the palette is greyscale only: it looks the same on every terminal theme and needs no configuration. Speed is the constraint every visual choice answers to. Animations are confined to a blinking caret, a pulsing overflow indicator, and a bounded flash on confirmation; none may delay a keystroke, none run when nothing animated is on screen, and all stop before the dialog settles. The glyphs and hint wording are fixed here because tests assert on them; how they are drawn is the change documents' decision.

## Constraints

- Only `select`, `input`, and their composition are in scope.
- The dialogs capability is internal to bundled plugins; a stable external dialogs package or public export is out of scope.
- `text` is the only field type. Dropdown, checkbox, numeric, masked, and multi-line fields are out of scope, as is a form that presents several fields at once with focus movement between them. An option's cells are display text and are unrelated to fields: they collect nothing and take no focus.
- Field validation, required-field policy, defaults beyond an initial value, error messages, and re-prompting after a rejected value are out of scope; a caller validates what it receives.
- Caret movement, word or line deletion, clipboard integration, paste-specific handling, entry history, completion, and character masking are out of scope for text entry and for the filter; a terminal paste arrives as ordinary input and is appended as such.
- Fuzzy or prefix matching, match ranking, match highlighting, matching against option values, a caller-supplied matcher, an initial filter text, and a filter on `input` are out of scope.
- Returning to an earlier stage, partial results, and any back-navigation key are out of scope, except that Escape and the left arrow MUST close the rightmost sub-dialog column and return to the one that opened it.
- Multi-select, disabled or grouped options, arbitrary caller-supplied option rendering, mouse input, and layout APIs are out of scope. Aligned cells and a header row are the only structure an option may have, and they are declared rather than drawn by the caller.
- Deciding an appearance is out of scope: [Theming](../theming/) owns the variables, the default greyscale theme, whether hues are emitted, and what a plugin may override.
- Per-field alignment, caller-specified field widths, per-field truncation policy, sorting or reordering by a field, and a header that can be clicked or activated are out of scope.
- Non-interactive fallback, concurrent dialogs, independently nested dialogs in separate render sessions, global serialization, persistence, and terminal accessibility policy are out of scope. Sub-dialog columns are not nested dialogs in this sense: they are one dialog in one render session.
- Registry collision policy, provider priority, deduplication, ownership metadata, and version negotiation are owned by neither this spec nor the initial implementation.

## Open Questions

- A public dialogs type export MAY be considered when an external plugin needs one; the current internal consumers do not justify that contract.
- A confirm dialog MAY be specified when a concrete bundled consumer needs one.
- Further field types and a multi-choice dialog MAY reuse the field and option model when a concrete bundled consumer needs them; neither is specified here.
- Whether a reduced-motion preference, such as an environment variable, SHOULD disable the caret blink, the indicator pulse, and the confirmation flash is undecided; all three are SHOULD-level, so adding one changes no MUST.
- Whether a filter that has been cleared back to empty should stay on screen for the column it was used in MAY be revisited once a bundled consumer presents real lists.
- Whether a column left of the rightmost one SHOULD report its own hidden counts is undecided. Only the rightmost reports today, so a column behind it whose list runs past the band shows a list that stops without saying it was cut; the two edges have room for one column's pair, and a rule for the rest needs somewhere to put the numbers first.
- Highlighting the matched characters within a visible label MAY be specified later; it is presentation only and changes no result.
- Whether a column of cells SHOULD elide or drop a field, rather than truncating every field proportionally, when the terminal cannot afford the column is undecided; the answer likely depends on a real consumer's fields.
- Whether a header row SHOULD be repeated when a list is long enough to scroll past it is undecided; it does not scroll today, so the question is only whether a second one would ever help.

## References

- [Plugin System](../plugin-system/)
- [Architecture](../architecture/)
- [Theming](../theming/)
- [Grid](../grid/)
- [Change 0016: Add Plugin Capabilities and Dialogs](../../changes/0016-add-plugin-capabilities-and-dialogs.md)
- [Change 0017: Add Dialog Text Input and Composition](../../changes/0017-add-dialog-text-input-and-composition.md)
- [Change 0020: Add Select Filter and Viewport](../../changes/0020-add-select-filter-and-viewport.md)
- [Change 0021: Restyle Dialogs as Norton Commander](../../changes/0021-restyle-dialogs-as-norton-commander.md)
- [Change 0023: Render Sub-Dialogs as Columns](../../changes/0023-render-sub-dialogs-as-columns.md)
- [Ink](https://github.com/vadimdemedes/ink)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-22 | Initial desired dialogs capability and select behavior | [0016-add-plugin-capabilities-and-dialogs](../../changes/0016-add-plugin-capabilities-and-dialogs.md) |
| 2026-08-22 | Implemented the namespace-free bundled provider and single-choice `select` | [0016-add-plugin-capabilities-and-dialogs](../../changes/0016-add-plugin-capabilities-and-dialogs.md) |
| 2026-08-29 | Desired text `input` dialog, the field model, user-provided select options, and the select result carrying collected values | [0017-add-dialog-text-input-and-composition](../../changes/0017-add-dialog-text-input-and-composition.md) |
| 2026-08-29 | Implemented the standalone text `input` dialog | [0017-add-dialog-text-input-and-composition](../../changes/0017-add-dialog-text-input-and-composition.md) |
| 2026-08-29 | Implemented user-provided select options, sequential field collection in one render session, and the `select` result carrying collected values | [0017-add-dialog-text-input-and-composition](../../changes/0017-add-dialog-text-input-and-composition.md) |
| 2026-09-01 | Desired select filter with its `filter` request setting, term matching, pinned user-provided options, and the bounded viewport with Home, End, and Page navigation | [0020-add-select-filter-and-viewport](../../changes/0020-add-select-filter-and-viewport.md) |
| 2026-09-01 | Desired Norton Commander presentation: framed dialogs with titles, greyscale palette, inverted cursor bar, key hints, truncation, and bounded animations | [0021-restyle-dialogs-as-norton-commander](../../changes/0021-restyle-dialogs-as-norton-commander.md) |
| 2026-09-02 | Implemented the select filter with its `filter` request setting, term matching, and pinned user-provided options, and the bounded viewport with its overflow indicators and Home, End, and Page navigation | [0020-add-select-filter-and-viewport](../../changes/0020-add-select-filter-and-viewport.md) |
| 2026-09-02 | Implemented the Norton Commander presentation: greyscale framed panels with their message set into the top edge, the inverted cursor bar, dimmed chrome and key hints, width-aware truncation, and the bounded caret blink, indicator pulse, and confirmation flash | [0021-restyle-dialogs-as-norton-commander](../../changes/0021-restyle-dialogs-as-norton-commander.md) |
| 2026-09-05 | Desired sub-dialogs as columns of one frame, the Enter-opens binding with its `expand` escape hatch, the always-live filter with its `filter` showing setting, and the filter and overflow counts set into the frame's edges | [0023-render-sub-dialogs-as-columns](../../changes/0023-render-sub-dialogs-as-columns.md) |
| 2026-09-05 | Implemented the column browser inside one frame with its divider, shared band, expand marker, trail title, and collapsing from the left; the Enter and arrow opening keys with the root-only `expand` binding; the always-live filter; and the filter and overflow counts set into the frame's edges with their room held | [0023-render-sub-dialogs-as-columns](../../changes/0023-render-sub-dialogs-as-columns.md) |
| 2026-09-05 | Stated the viewport's one-row floor and its active-option rule with the conditions they hold under, so both match the collapse a too-short terminal forces, closing the open question 0020 recorded | [0023-render-sub-dialogs-as-columns](../../changes/0023-render-sub-dialogs-as-columns.md) |
| 2026-09-05 | Cell width made a construction-time guarantee rather than a rescue by row truncation | [0025-guarantee-cell-width-by-construction](../../changes/0025-guarantee-cell-width-by-construction.md) |
| 2026-09-05 | Appearance decisions delegated to Theming; the greyscale rule became the default theme's property | [0026-add-theme-variables](../../changes/0026-add-theme-variables.md) |
| 2026-09-05 | Options may declare aligned cells and a column may declare headers | [0027-add-multi-cell-select-rows](../../changes/0027-add-multi-cell-select-rows.md) |
