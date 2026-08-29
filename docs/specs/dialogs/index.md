# Dialogs

## Overview

`tx` provides a bundled dialogs plugin for terminal interactions shared by its own plugins. The plugin MUST expose dialogs through the generic registry rather than through core vocabulary, and its contract MUST contain only a single-choice `select` dialog and a single-field text `input` dialog, which compose when a select option is marked as user-provided.

[Change 0016](../../changes/0016-add-plugin-capabilities-and-dialogs.md) implements the generic registry that carries the internal capability and the namespace-free bundled provider that supplies `select`. [Change 0017](../../changes/0017-add-dialog-text-input-and-composition.md) specifies the text `input` dialog and the user-provided option that composes the two; the requirements below covering `input`, fields, and user-provided options describe desired behavior that is not implemented yet.

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
- `select` MUST render the request message and every option label.
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

- Up and Down input MUST move the active option by one position and MUST keep it at the first or last option when movement would pass that boundary.
- Enter on a plain option MUST resolve with a result carrying the exact value belonging to that option and no collected values.
- Escape or Ctrl-C MUST cancel the dialog and resolve with `undefined` without terminating the process.
- The dialog MUST NOT print the selected value or assign cancellation an exit code; those decisions belong to the consuming command.

#### Scenario: Select a value

- **GIVEN** a dialog with three plain options and the first active
- **WHEN** the user presses Down and then Enter
- **THEN** `select` resolves with a result whose value is the second option's value and whose collected values are empty

#### Scenario: Movement stops at a boundary

- **GIVEN** the last option is active
- **WHEN** the user presses Down
- **THEN** the last option remains active

#### Scenario: Cancel without exiting

- **GIVEN** a selection dialog is active
- **WHEN** the user presses Escape or Ctrl-C
- **THEN** `select` resolves with `undefined` and the host process remains available to the consuming command

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
- Input MAY arrive as more than one character at once, as a paste does; every printable character it carries MUST append in order, so a pasted chunk is appended whole. Control characters and escape sequences are not printable input.
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
- Escape or Ctrl-C at any stage MUST cancel the entire dialog, resolve with `undefined`, and discard every value already collected; the dialog MUST NOT return to a previous stage or expose a partial result.

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

## Constraints

- Only `select`, `input`, and their composition are in scope.
- The dialogs capability is internal to bundled plugins; a stable external dialogs package or public export is out of scope.
- `text` is the only field type. Dropdown, checkbox, numeric, masked, and multi-line fields are out of scope, as is a form that presents several fields at once with focus movement between them.
- Field validation, required-field policy, defaults beyond an initial value, error messages, and re-prompting after a rejected value are out of scope; a caller validates what it receives.
- Caret movement, word or line deletion, clipboard integration, paste-specific handling, entry history, completion, and character masking are out of scope for text entry; a terminal paste arrives as ordinary input and is appended as such.
- Returning to an earlier stage, partial results, and any back-navigation key are out of scope.
- Search, filtering, multi-select, disabled or grouped options, custom option rendering, paging, mouse input, themes, and layout APIs are out of scope.
- Non-interactive fallback, concurrent or nested dialogs, global serialization, persistence, and terminal accessibility policy are out of scope.
- Registry collision policy, provider priority, deduplication, ownership metadata, and version negotiation are owned by neither this spec nor the initial implementation.

## Open Questions

- A public dialogs type export MAY be considered when an external plugin needs one; the current internal consumers do not justify that contract.
- A confirm dialog MAY be specified when a concrete bundled consumer needs one.
- Further field types and a multi-choice dialog MAY reuse the field and option model when a concrete bundled consumer needs them; neither is specified here.

## References

- [Plugin System](../plugin-system/)
- [Architecture](../architecture/)
- [Change 0016: Add Plugin Capabilities and Dialogs](../../changes/0016-add-plugin-capabilities-and-dialogs.md)
- [Change 0017: Add Dialog Text Input and Composition](../../changes/0017-add-dialog-text-input-and-composition.md)
- [Ink](https://github.com/vadimdemedes/ink)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-22 | Initial desired dialogs capability and select behavior | [0016-add-plugin-capabilities-and-dialogs](../../changes/0016-add-plugin-capabilities-and-dialogs.md) |
| 2026-08-22 | Implemented the namespace-free bundled provider and single-choice `select` | [0016-add-plugin-capabilities-and-dialogs](../../changes/0016-add-plugin-capabilities-and-dialogs.md) |
| 2026-08-29 | Desired text `input` dialog, the field model, user-provided select options, and the select result carrying collected values | [0017-add-dialog-text-input-and-composition](../../changes/0017-add-dialog-text-input-and-composition.md) |
