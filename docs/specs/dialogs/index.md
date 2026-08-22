# Dialogs

## Overview

`tx` provides a bundled dialogs plugin for terminal interactions shared by its own plugins. The plugin MUST expose dialogs through the generic registry rather than through core vocabulary, and its initial contract MUST contain only a single-choice `select` dialog.

The behavior is implemented by [Change 0016](../../changes/0016-add-plugin-capabilities-and-dialogs.md): the generic registry carries the internal capability, and the namespace-free bundled provider supplies `select`.

## Background

Plugins already receive the host's React and Ink instances and injected process streams through the [Plugin System](../plugin-system/). They can render their own terminal interfaces, but unrelated plugins have no supported way to share one runtime capability.

The dialogs plugin provides that first concrete use of the generic registry. It owns terminal interaction policy while callers own the meaning of selection, cancellation, output, and command failure.

## Requirements

### Dialog Capability

- The bundled dialogs plugin MUST register one dialog capability under the opaque registry key `dialogs` and MUST NOT claim a command namespace.
- The dialog capability MUST expose only `select`; confirm, text input, and every other dialog are outside the initial contract.
- A consumer MUST read the capability while its command runs, after plugin initialization has completed, rather than snapshotting it during initialization.
- The dialogs plugin and its consumers MUST use a local structural contract; the initial capability MUST NOT add dialog types or runtime values to `@fx/tx/plugin`.
- A consumer MUST own the behavior for an absent dialog capability; the registry and provider MUST NOT prescribe that command's output or exit code.

Conceptual internal shape:

```ts
type SelectOption<T> = {
  readonly label: string
  readonly value: T
}

type SelectRequest<T> = {
  readonly message: string
  readonly options: readonly SelectOption<T>[]
}

type Dialogs = {
  select<T>(request: SelectRequest<T>): Promise<T | undefined>
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

#### Scenario: Invalid empty request

- **GIVEN** a caller supplies an empty options array
- **WHEN** it calls `select`
- **THEN** the call rejects before rendering anything

#### Scenario: Duplicate options remain available

- **GIVEN** two options have equal labels or values
- **WHEN** the dialog renders
- **THEN** both appear in their supplied positions and can be selected independently

### Selection

- Up and Down input MUST move the active option by one position and MUST keep it at the first or last option when movement would pass that boundary.
- Enter MUST resolve with the exact value belonging to the active option.
- Escape or Ctrl-C MUST cancel the dialog and resolve with `undefined` without terminating the process.
- The dialog MUST NOT print the selected value or assign cancellation an exit code; those decisions belong to the consuming command.

#### Scenario: Select a value

- **GIVEN** a dialog with three options and the first active
- **WHEN** the user presses Down and then Enter
- **THEN** `select` resolves with the second option's value

#### Scenario: Movement stops at a boundary

- **GIVEN** the last option is active
- **WHEN** the user presses Down
- **THEN** the last option remains active

#### Scenario: Cancel without exiting

- **GIVEN** a selection dialog is active
- **WHEN** the user presses Escape or Ctrl-C
- **THEN** `select` resolves with `undefined` and the host process remains available to the consuming command

### Terminal Streams and Cleanup

- The dialog MUST read input only from the dialogs provider's injected standard-input stream.
- The dialog MUST render its prompt and options only to the dialogs provider's injected standard-error stream, leaving standard output untouched for the consumer's data.
- `select` MUST reject before rendering when its injected standard-input or standard-error stream is not an interactive terminal; it MUST NOT provide a non-interactive fallback.
- `select` MUST restore the injected terminal's prior state and finish unmounting before its promise settles after selection, cancellation, or rendering failure.
- If an injected `setRawMode(false)` or `unref()` method persistently throws, restoration through that API is impossible: `select` MUST retry finitely, reject with the first cleanup failure, and treat only that exceptional path as best-effort rather than hanging indefinitely.
- A rendering or interaction failure MUST reject `select` and MUST NOT terminate the process directly.

#### Scenario: Command output remains clean

- **GIVEN** a consuming command reserves standard output for machine-readable data
- **WHEN** it presents a selection dialog
- **THEN** the prompt and options appear on standard error and standard output remains untouched until the consumer writes its result

#### Scenario: Non-interactive invocation

- **GIVEN** standard input or standard error is redirected rather than attached to an interactive terminal
- **WHEN** a command calls `select`
- **THEN** the call rejects without rendering or waiting for input

#### Scenario: Terminal restored before completion

- **GIVEN** an active dialog
- **WHEN** it selects, cancels, or fails
- **THEN** terminal state is restored and rendering is unmounted before the caller observes settlement

## Design

### Ownership

The dialogs plugin is an ordinary bundled provider outside `src/`. Core stores its value under an opaque key and has no dialog vocabulary. Internal consumers depend on a small structural `Dialogs` shape, not on the provider's module graph.

The provider obtains React, Ink, and process streams from its own initialization API. It renders interactive UI on standard error so command results may continue to use standard output. The caller decides whether cancellation is success, failure, or no action.

### Registry Use

The provider registers during initialization. Consumers read committed values inside command actions, when all successful root and child plugins have initialized. Repository composition supplies one dialogs provider; behavior with additional values under the same key belongs to neither this spec nor the initial consumer contract.

## Constraints

- Only `select` is in scope.
- The dialogs capability is internal to bundled plugins; a stable external dialogs package or public export is out of scope.
- Search, filtering, text entry, multi-select, disabled or grouped options, configurable defaults, custom option rendering, paging, mouse input, themes, and layout APIs are out of scope.
- Non-interactive fallback, concurrent or nested dialogs, global serialization, persistence, and terminal accessibility policy are out of scope.
- Registry collision policy, provider priority, deduplication, ownership metadata, and version negotiation are owned by neither this spec nor the initial implementation.

## Open Questions

- A public dialogs type export MAY be considered when an external plugin needs one; the initial internal consumer does not justify that contract.
- Confirm and text-input dialogs MAY be specified when a concrete bundled consumer needs them.

## References

- [Plugin System](../plugin-system/)
- [Architecture](../architecture/)
- [Change 0016: Add Plugin Capabilities and Dialogs](../../changes/0016-add-plugin-capabilities-and-dialogs.md)
- [Ink](https://github.com/vadimdemedes/ink)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-22 | Initial desired dialogs capability and select behavior | [0016-add-plugin-capabilities-and-dialogs](../../changes/0016-add-plugin-capabilities-and-dialogs.md) |
| 2026-08-22 | Implemented the namespace-free bundled provider and single-choice `select` | [0016-add-plugin-capabilities-and-dialogs](../../changes/0016-add-plugin-capabilities-and-dialogs.md) |
