# Dialogs

## Overview

`tx` provides a bundled dialogs plugin for terminal interactions shared by its own plugins. The plugin MUST expose dialogs through the generic registry rather than through core vocabulary, and its contract MUST contain only a single-choice `select` dialog and a single-field text `input` dialog, which compose when a select option is marked as user-provided.

[Change 0016](../../changes/0016-add-plugin-capabilities-and-dialogs.md) implements the generic registry that carries the internal capability and the namespace-free bundled provider that supplies `select`. [Change 0017](../../changes/0017-add-dialog-text-input-and-composition.md) implements the text `input` dialog and the user-provided option that composes the two. Those requirements are implemented.

[Change 0020](../../changes/0020-add-select-filter-and-viewport.md) implements the [Filter Request](#filter-request), [Filtering](#filtering), and [Viewport](#viewport) sections, and [Change 0021](../../changes/0021-restyle-dialogs-as-norton-commander.md) implements [Presentation](#presentation). Those sections, and the Home, End, and Page rules and confirmation wording added to [Selection](#selection), describe desired behavior and are not yet implemented; a select today renders every option as plain text and ignores printable input.

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
  readonly label: string
  readonly value: T
  readonly fields?: readonly TextField[]
}

type SelectRequest<T> = {
  readonly message: string
  readonly options: readonly SelectOption<T>[]
  readonly filter?: boolean | "auto"
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
- `select` MUST render the request message and the label of every option the [filter](#filtering) leaves visible and the [viewport](#viewport) has room for.
- `select` MUST treat option labels as display text and option values as opaque values.
- `select` MUST preserve option order and MUST NOT remove options whose labels or values repeat.
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

### Selection

- Up and Down input MUST move the active option by one position among the visible options and MUST keep it at the first or last visible option when movement would pass that boundary.
- Home and End input MUST make the first and the last visible option active.
- Page Up and Page Down input MUST move the active option by the number of option rows the [viewport](#viewport) shows, clamped at the first and last visible option.
- Enter on a plain option MUST confirm the selection and resolve with a result carrying the exact value belonging to that option and no collected values.
- Escape or Ctrl-C before a selection is confirmed MUST cancel the dialog and resolve with `undefined` without terminating the process; after confirmation the outcome is fixed, and [Presentation](#presentation) bounds how long settlement may take.
- While the filter is disabled, printable input MUST leave the dialog unchanged.
- The dialog MUST NOT print the selected value or assign cancellation an exit code; those decisions belong to the consuming command.

Every option is visible while the filter is disabled or its text is blank; [Filtering](#filtering) defines visibility otherwise.

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

- A select request MAY carry a `filter` setting of `true`, `false`, or `"auto"`, and an omitted setting MUST mean `"auto"`.
- `true` MUST enable the filter and `false` MUST disable it, whatever the option count.
- `"auto"` MUST enable the filter exactly when the request carries more than eight options.

#### Scenario: Filter enabled automatically

- **GIVEN** a request with nine options and no `filter` setting
- **WHEN** the dialog opens
- **THEN** the filter is present and typed text narrows the options

#### Scenario: Filter kept off for a long list

- **GIVEN** a request with nine options and `filter: false`
- **WHEN** the user types `a`
- **THEN** every option stays visible and nothing else changes

### Filtering

- While the filter is enabled, it MUST be the element that receives typed text from the moment the dialog opens, with no key moving focus to or from it.
- Printable input and Backspace MUST edit the filter text exactly as they edit a [text input's](#text-input) value.
- The dialog MUST render the current filter text.
- The filter's terms are the whitespace-separated pieces of its text; an option MUST be visible when every term occurs within its label under a case-insensitive comparison, or when the option declares fields.
- Visible options MUST keep their supplied order; the filter MUST NOT rank, reorder, or deduplicate them.
- Whenever the filter text changes, the first visible option MUST become active.
- When no option is visible, the dialog MUST indicate that nothing matches, Enter and navigation MUST do nothing, and cancellation MUST remain available.
- Escape MUST cancel the dialog even while the filter text is non-empty; it MUST NOT clear the filter instead.
- Once field collection begins, the filter MUST stop accepting input alongside option navigation.
- The filter text MUST NOT appear in the result.

#### Scenario: Type to narrow, then select

- **GIVEN** a filter-enabled dialog listing `Alpha`, `Beta`, `Gamma`, and `Alphabet`
- **WHEN** the user types `alp` and presses Enter
- **THEN** only `Alpha` and `Alphabet` were visible, in that order, and `select` resolves with `Alpha`'s value

#### Scenario: Several terms in any order

- **GIVEN** a filter-enabled dialog listing `release branch`, `branch archive`, and `main`
- **WHEN** the user types `branch rel`
- **THEN** only `release branch` is visible

#### Scenario: Backspace widens the match

- **GIVEN** the filter text `gam` leaves only `Gamma` visible
- **WHEN** the user presses Backspace three times
- **THEN** every option is visible again and the first is active

#### Scenario: A user-provided option stays reachable

- **GIVEN** a filter-enabled dialog whose last option is `Other…` with a text field
- **WHEN** the user types `zzz`
- **THEN** `Other…` is the only visible option, and it is active

#### Scenario: Nothing matches

- **GIVEN** a filter-enabled dialog with plain options only
- **WHEN** the user types text no label contains and presses Enter
- **THEN** the dialog shows that nothing matches, stays open, and Escape still resolves `undefined`

#### Scenario: Navigation survives the filter

- **GIVEN** the filter text leaves three options visible
- **WHEN** the user presses Down twice
- **THEN** the third visible option is active, whatever its position in the supplied list

### Viewport

- The dialog MUST render at most ten option rows at once, fewer so that the dialog as a whole — indicators and hints included — stays shorter than the terminal, and never fewer than one.
- Whenever the terminal is tall enough for the dialog's other rows plus one option row, the dialog MUST NOT clear the terminal or scroll away what was on screen before it opened, on any frame or when it settles.
- The active option MUST always be among the rendered options, and the rendered window MUST move only as far as needed to keep it there.
- When visible options exist above or below the rendered window, the dialog MUST indicate that on that side together with how many are hidden there.
- After the terminal is resized, the rendered window MUST reflect the new row count.

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

### Presentation

The look is Norton Commander's: framed panels, a title set into the frame, a full-width cursor bar, and a key bar underneath — in greyscale.

- Every dialog MUST be drawn inside a frame whose top edge carries its message as a title: the request message for a select or a standalone input, and the field's message for a field under collection.
- A select MUST use a double-line frame; a standalone input and a field under collection MUST use a single-line frame.
- Frame edges, the title, the key hints, the overflow indicators, and the filter prompt MUST be rendered dimmed relative to option labels and entered text.
- The active option MUST be rendered as an inverted bar spanning the frame's full inner width.
- A dialog MUST use only the terminal's default foreground and background, their dimmed form, and their inversion; it MUST NOT emit any hue.
- A dimmed key hint line MUST appear beneath the frame: a select's names the navigation, selection, and cancel keys and, when the filter is enabled, typing to filter; an input's or a field's names the submit and cancel keys.
- A frame MUST fit its content and MUST NOT exceed the terminal width; a title or label wider than the inner width MUST be truncated at its end with an ellipsis rather than wrapped, and filter text or a value under entry wider than the inner width MUST keep its end visible, so the caret is never cut off.
- Twenty columns is the narrowest supported terminal: below it, a dialog MUST lay itself out as if the terminal were twenty columns wide, and how the terminal wraps the result is unspecified.
- Text entry and the filter MUST show a caret after the current text, and the caret SHOULD alternate between visible and hidden at an interval between 400 and 600 milliseconds while the dialog waits for input.
- Confirming a plain option SHOULD flash the active bar before the dialog settles; once confirmed, the dialog MUST settle within 250 milliseconds and MUST ignore every key, cancellation included, because the choice is already made.
- An overflow indicator SHOULD pulse between its dimmed and normal rendering at the caret's interval.
- The caret blink and the indicator pulse MUST NOT delay input: a keystroke MUST be reflected in the very next render regardless of their phase.
- A dialog with no animated element on screen MUST NOT re-render on a timer.
- Every animation timer MUST be stopped before the dialog settles.
- A request rejected before rendering MUST still render nothing, frame included.

The glyphs are part of the contract, so tests and later changes have one source: the filter prompt is `›`, the caret is `█`, the overflow indicators are `▲ N more` above and `▼ N more` below with `N` the hidden count, the no-match row reads `no match`, and the select hint line reads `↑↓ move · Enter select · type to filter · Esc cancel`, without the filter phrase when the filter is disabled; the input hint line reads `Enter submit · Esc cancel`.

Reference rendering of a filter-enabled select in a terminal of 80 columns and 9 rows, greyscale omitted; the [viewport](#viewport) leaves three option rows because the dialog's other six rows must stay under the terminal height:

```text
╔═ Which branch? ═══════════════════════╗
║ › rel█                                ║
║ release/1.4                           ║  ← inverted bar
║ release/1.5                           ║
║ release/1.6                           ║
║ ▼ 2 more                              ║
╚═══════════════════════════════════════╝
 ↑↓ move · Enter select · type to filter · Esc cancel
```

#### Scenario: Framed select with a title

- **GIVEN** a select whose message is `Which branch?`
- **WHEN** the dialog renders
- **THEN** a double-line frame appears with `Which branch?` set into its top edge, the active option is inverted across the frame's inner width, and a dimmed key hint line follows the frame

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

- **GIVEN** a select with three options, the filter disabled, and no overflow
- **WHEN** no input arrives for one second
- **THEN** nothing further is written to standard error

### Terminal Streams and Cleanup

- A dialog MUST read input only from the dialogs provider's injected standard-input stream.
- A dialog MUST render its prompts, options, and entered values only to the dialogs provider's injected standard-error stream, leaving standard output untouched for the consumer's data.
- A dialog MUST reject before rendering when its injected standard-input or standard-error stream is not an interactive terminal; it MUST NOT provide a non-interactive fallback.
- A dialog MUST restore the injected terminal's prior state and finish unmounting before its promise settles after completion, cancellation, or rendering failure.
- A `select` that collects fields MUST be one dialog: it MUST NOT restore terminal state, unmount, or settle between its selection and field stages.
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

`"auto"` exists so callers need not think about the filter at all: a short list stays a short list, and a long one gets a filter. The threshold is a fixed count rather than the terminal size so a caller can predict what the user sees.

### Why a Viewport

A bounded window is what makes a long list usable at all, filter or not, and it is what keeps rendering cost proportional to what is on screen rather than to the option count. The window scrolls minimally so the list does not jump under the cursor bar, and the indicators show how much is hidden so the user knows whether to keep scrolling or start typing.

### Why Norton Commander

The Norton Commander vocabulary — double-line panels, a title set into the frame, an inverted cursor bar, a key bar — is familiar and reads well in a monospace grid without any color, which is why the palette is greyscale only: it looks the same on every terminal theme and needs no configuration. Speed is the constraint every visual choice answers to. Animations are confined to a blinking caret, a pulsing overflow indicator, and a bounded flash on confirmation; none may delay a keystroke, none run when nothing animated is on screen, and all stop before the dialog settles. The glyphs and hint wording are fixed here because tests assert on them; how they are drawn is the change documents' decision.

## Constraints

- Only `select`, `input`, and their composition are in scope.
- The dialogs capability is internal to bundled plugins; a stable external dialogs package or public export is out of scope.
- `text` is the only field type. Dropdown, checkbox, numeric, masked, and multi-line fields are out of scope, as is a form that presents several fields at once with focus movement between them.
- Field validation, required-field policy, defaults beyond an initial value, error messages, and re-prompting after a rejected value are out of scope; a caller validates what it receives.
- Caret movement, word or line deletion, clipboard integration, paste-specific handling, entry history, completion, and character masking are out of scope for text entry and for the filter; a terminal paste arrives as ordinary input and is appended as such.
- Returning to an earlier stage, partial results, and any back-navigation key are out of scope.
- Fuzzy or prefix matching, match ranking, match highlighting, matching against option values, a caller-supplied matcher, an initial filter text, and a filter on `input` are out of scope.
- Multi-select, disabled or grouped options, custom option rendering, mouse input, configurable themes or palettes, color hues, and layout APIs are out of scope.
- Non-interactive fallback, concurrent or nested dialogs, global serialization, persistence, and terminal accessibility policy are out of scope.
- Registry collision policy, provider priority, deduplication, ownership metadata, and version negotiation are owned by neither this spec nor the initial implementation.

## Open Questions

- A public dialogs type export MAY be considered when an external plugin needs one; the current internal consumers do not justify that contract.
- A confirm dialog MAY be specified when a concrete bundled consumer needs one.
- Further field types and a multi-choice dialog MAY reuse the field and option model when a concrete bundled consumer needs them; neither is specified here.
- Whether a reduced-motion preference, such as an environment variable, SHOULD disable the caret blink, the indicator pulse, and the confirmation flash is undecided; all three are SHOULD-level, so adding one changes no MUST.
- The `"auto"` threshold of eight MAY be revisited once a bundled consumer presents real lists.
- Highlighting the matched characters within a visible label MAY be specified later; it is presentation only and changes no result.

## References

- [Plugin System](../plugin-system/)
- [Architecture](../architecture/)
- [Change 0016: Add Plugin Capabilities and Dialogs](../../changes/0016-add-plugin-capabilities-and-dialogs.md)
- [Change 0017: Add Dialog Text Input and Composition](../../changes/0017-add-dialog-text-input-and-composition.md)
- [Change 0020: Add Select Filter and Viewport](../../changes/0020-add-select-filter-and-viewport.md)
- [Change 0021: Restyle Dialogs as Norton Commander](../../changes/0021-restyle-dialogs-as-norton-commander.md)
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
