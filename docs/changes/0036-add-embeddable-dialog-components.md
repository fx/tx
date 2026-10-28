# 0036: Add Embeddable Dialog Components

## Summary

Expose the dialogs as components — `Select` and `Input` — that a plugin renders inside its own render session, sized and focused by that plugin, and make `select` and `input` the same components mounted in a session of the provider's own, with nothing observable about them changing.

**Spec:** [Dialogs](../specs/dialogs/)
**Status:** complete
**Depends On:** 0017, 0023, 0031, 0033

## Motivation

A plugin that draws its own full-screen interface — a chat client, a dashboard — renders in a session of its own, built on the React and Ink `tx` injects. When it needs to ask a question, `select` and `input` are no use to it: each mounts a second render session on the terminal, which fights the host's session over raw mode, the input stream, and the screen. The plugin's only way out today is to re-implement the select — its filter, viewport, columns, and Norton Commander presentation — which is exactly the duplication the capability exists to remove, and the copy drifts the moment the dialogs change.

The dialog is already two things welded together: the interaction, and the session that holds a terminal for it. `runDialog` in `plugins/dialogs/index.ts` owns the session; `createSelectView` in `plugins/dialogs/select.ts` and `createEntry` in `plugins/dialogs/entry.ts` own the interaction, except that both read the terminal's size themselves and both answer keys unconditionally. Cutting along that seam is most of this change.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions)). CI enforces these as merge gates:

- Tests MUST use Bun's test runner, and new observable behavior MUST have automated tests.
- Tests MUST maintain 100% statement, function, and line coverage across production source files; coverage exclusions MUST stay limited to generated or non-executable files and MUST be documented in configuration.
- Every first-party executable file committed MUST be reachable by the linter, the type checker, and the test suite; a published contract module MUST NOT escape those gates by being types-only.
- Committed tests MUST NOT contain focused or skipped cases without a documented reason.
- Biome formatting and lint, and TypeScript, MUST pass with no errors; `bun run check` MUST pass.
- The embedded form MUST be tested as a host uses it: a host component rendered through the injected `ink.render` on captured streams, the way `test/dialogs-plugin.test.ts` drives the function form, rendering `dialogs.Select` and `dialogs.Input` read from the registry.
- Every existing test of `select` and `input` MUST keep passing without an assertion changing; that is the evidence the function forms kept their behavior.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Dialogs: Embeddable Components](../specs/dialogs/index.md#embeddable-components) owns the components, their shared props, their sizing, focus, and settlement rules, how `select` and `input` mount them, and the scenarios that are this change's acceptance criteria; [Dialogs: Dialog Capability](../specs/dialogs/index.md#dialog-capability) owns the contract's membership and its conceptual shape. Neither is restated here. What implementing them requires of this change:

- The published contract is `plugins/dialogs/contract.ts`. It gains `EmbeddedProps<R>`, `SelectProps<T>`, and `InputProps`, and `Dialogs` gains `Select` and `Input`, as types alone with no import added — in particular no React or Ink type. `EmbeddedProps` is exported, because [Change 0038](./0038-add-embeddable-grid-components.md) types the grid's selecting component by importing it from `@fx/tx/dialogs`.
- Adding members to `Dialogs` is an addition, not a breaking change, under [Plugin System: Published Capability Contracts](../specs/plugin-system/index.md#published-capability-contracts): nothing a consumer reads is removed or narrowed.
- `plugins/dialogs/types.ts` keeps `DialogElement` and `DialogView`; the rendering vocabulary stays unpublished, as [Change 0031](./0031-publish-the-dialogs-and-config-contracts.md) decided.
- `select` and `input` keep their order of rejections: request validation, then the interactive-stream check, then the first terminal change. The validations the component runs at render are the same functions, so the two forms cannot disagree about what is rejected.
- The plugin guide's dialogs section ([`docs/manual/plugins.md`](../manual/plugins.md#use-the-bundled-dialogs-capability)) documents the components with a host example once they ship. The README documents no capability — only the demo — so it does not change.

## Design

### Approach

1. **Sizes from props.** `createSelectView`'s `Select` reads `ink.useWindowSize()` for `columns` and `rows` (around `select.ts:306`); `createEntry`'s `Entry` reads it for `columns` (around `entry.ts:122`). Both take `width` instead, and the select takes `height`. `createFrame` in `frame.ts` already takes a `columns` prop and `panelWidth` already caps at it, so the frame needs nothing beyond being handed `width`.
2. **The one-row rule moves to the wrapper.** `viewport.ts`'s `affordableBandRows` subtracts one row from the terminal's height so Ink never treats the dialog as full-screen. That subtraction belongs to `select`, which now passes `height` as the terminal's rows less one. `optionRowCount`, `affordsBandRows`, and `movedPosition`'s page size read that height. The arithmetic is unchanged for the function form, which is what keeps its tests unchanged. As implemented, `viewport.ts` keeps its one-row margin and the select view measures it against `height + 1`, the height the dialog must stay strictly under: `test/dialogs-viewport.test.ts` states the viewport's arithmetic against a terminal's rows, and removing the subtraction from the module would have changed its assertions, which the testing requirements above forbid. A host's `height` is still the most rows `Select` ever draws.
3. **Focus.** Every `ink.useInput` call in the select and the entry passes `{ isActive }` (Ink 8 supports it), and the select's one `ink.useAnimation` subscription is active only while `isActive` and something animated is on screen — except while a confirmation flash is running, which runs out regardless. The caret is drawn only while active. A field entry or text leaf inside a select inherits the select's `isActive`.
4. **Settlement as callbacks.** `createSelectView` takes a `settle(outcome)` callback today; the component calls `onSubmit(result)` and `onCancel()` instead, read through a ref so a host passing fresh callbacks on every render never re-subscribes an input handler. A `finished` ref set by the first callback makes every later key a no-op — the select's `confirmed` ref already does this for the flash, but field completion, text-leaf submission, cancellation, and the entry do not.
5. **The components.** `Select` and `Input` are created once, when the provider registers, closing over the injected React, Ink, the registry, and `context.stderr`, so every read of the capability yields the same functions. Each resolves its theme for `context.stderr` once per mount — today `components()` in `index.ts` resolves it once per call, which is the same thing for a function form — and builds its `Frame` and `Entry` from it. Each validates its request on first render with the existing `requireNonEmptyOptions`, `requireCollectableFields`, and `requireAlignedCells`, and throws before drawing.
6. **The wrappers.** `select` and `input` keep `requireInteractiveStreams` and `runDialog`, and mount a small root that reads `ink.useWindowSize()` — so a resize re-renders it — and renders the component with `isActive: true` and callbacks that call `runDialog`'s `settle` — `select` rendering `Select` with `width: columns` and `height: rows - 1`, and `input` rendering `Input` with `width: columns` alone.

### Decisions

- **Decision**: type each component as a function of its props returning `unknown`, and have a host cast it where it calls `createElement`.
  - **Why**: published contracts are types-only and carry no React type ([Change 0031](./0031-publish-the-dialogs-and-config-contracts.md) kept `DialogElement` out for this reason). React's `createElement` wants a component returning a React node, so a host writes `react.createElement(dialogs.Select as FunctionComponent<SelectProps<T>>, props)`, or an equivalent cast, once. The guide shows it.
  - **Alternatives considered**: typing the return as `never`, which `createElement` accepts without a cast but which is a false statement about the function; importing React's element type into the contract, which makes an internal rendering decision a breaking change; a `mount(host)` API returning a handle, which hands the layout back to the provider and is exactly what a host embedding a dialog does not want.

- **Decision**: the components are the capability's members, created once per provider, rather than a factory a host calls.
  - **Why**: React remounts a component whose function identity changes. A factory, or a component created per read, would throw away the filter text and the open columns on every host render.
  - **Alternatives considered**: `dialogs.createSelect()`, rejected because a host calling it inside its render remounts every frame and calling it outside is a rule the type cannot enforce.

- **Decision**: a component presents the request it was mounted with.
  - **Why**: the select's state — its stack of levels, active positions, filter texts, and collected fields — is indexed into the request. Accepting a new request mid-interaction would need rules for every one of those, and a host wanting a different question can key a new component.
  - **Alternatives considered**: resetting on request identity change, rejected because a host building its request inline produces a new object every render and would reset the dialog on every keystroke.

- **Decision**: a component is one-shot: after its first callback it ignores every key until unmounted.
  - **Why**: it is what the function form is — a dialog that settles once — and it keeps one meaning for `onSubmit`. A host that wants another answer mounts another component, which also resets `Input` to its initial value.
  - **Alternatives considered**: a re-submittable `Input` for chat-style prompts, left as an open question in the spec rather than built speculatively.

- **Decision**: an inactive component keeps its hint line and its rows.
  - **Why**: a host moving focus between panels must not see its layout jump. The hint describes the keys the component answers once focused.
  - **Alternatives considered**: hiding the hint while inactive, rejected because it changes the component's height on every focus change.

- **Decision**: Ctrl-C reaching the component cancels it; whether it reaches the component is the host's session's choice.
  - **Why**: `runDialog` renders with `exitOnCtrlC: false` so the dialog sees Ctrl-C; a host session rendered with Ink's default exits on it before any input handler runs. That is the host's policy and the component cannot override it.
  - **Alternatives considered**: none that a component could enforce.

### Non-Goals

- Publishing `Frame`, its row and segment vocabulary, or a helper turning a theme variable into Ink `Text` props.
- Any React or Ink type in a published contract.
- Multi-select, which [Change 0037](./0037-add-multi-select.md) owns.
- The grid's components, which [Change 0038](./0038-add-embeddable-grid-components.md) owns.
- A re-submittable `Input`, a component that accepts a new request while mounted, and a published lookup helper for the capability.
- Any change under `src/`, and any observable change to `select` or `input`.

## Tasks

- [x] Add the embeddable `Select` and `Input` components and mount `select` and `input` over them
  - [x] `plugins/dialogs/contract.ts`: `EmbeddedProps<R>`, `SelectProps<T>`, `InputProps`, and the `Select` and `Input` members of `Dialogs`, types alone
  - [x] `plugins/dialogs/select.ts`, `plugins/dialogs/entry.ts`, `plugins/dialogs/viewport.ts`: `width` and `height` from props, the one-row subtraction moved to `select` (the viewport keeps its margin and the view measures it against `height + 1`, as Approach item 2 records), `isActive` on every input handler and on the animation, callbacks through refs, and a finished state that ignores later keys
  - [x] `plugins/dialogs/index.ts`: create `Select` and `Input` once at registration with theme resolution and request validation per mount; `select` and `input` mount them under a root reading the terminal size, passing `isActive: true` to both, the columns and the rows less one to `Select`, and the columns alone to `Input`
  - [x] `test/dialogs-embedded.test.ts`: a host component rendered through `coreDependencies.ink.render` on captured streams, covering every scenario in [Dialogs: Embeddable Components](../specs/dialogs/index.md#embeddable-components) — submission and cancellation callbacks, the height-bounded window and the height affording no row, the width-bounded frame, two components with one active, focus moving nothing, a re-render keeping state, an invalid request failing the render, the finished component, and Escape at the root
  - [x] Existing `test/dialogs-plugin.test.ts`, `test/dialogs-columns.test.ts`, `test/dialogs-filter.test.ts`, and `test/dialogs-viewport.test.ts` pass with no assertion changed
  - [x] `test/plugin-consumer.test.ts`: the consumer fixture types `Select` and `Input` through the published contract, so the packed tarball proves the contract types them without React; `test/plugin-boundary.test.ts` keeps passing, showing the contract module still imports nothing
  - [x] [`docs/manual/plugins.md`](../manual/plugins.md#use-the-bundled-dialogs-capability): document the components, the shared props, and the cast at `createElement`, with a host example
  - [x] [Dialogs](../specs/dialogs/) spec: mark [Embeddable Components](../specs/dialogs/index.md#embeddable-components) implemented and add a changelog row; set this change `complete` in `docs/index.yml` and `docs/index.md`

## Open Questions

- [ ] Whether the demo SHOULD gain a scenario hosting an embedded dialog beside a host widget. It would need a host app inside `demo/`, which nothing else there has; the tests already exercise the embedding. **Follow-up:** Maintainers should revisit when a demo host is requested beyond the existing embedded-component tests. A later change must decide any behavior.

## References

- Spec: [Dialogs: Embeddable Components](../specs/dialogs/index.md#embeddable-components), [Dialogs: Dialog Capability](../specs/dialogs/index.md#dialog-capability), [Plugin System: Published Capability Contracts](../specs/plugin-system/index.md#published-capability-contracts)
- Related changes: [0017-add-dialog-text-input-and-composition](./0017-add-dialog-text-input-and-composition.md), [0023-render-sub-dialogs-as-columns](./0023-render-sub-dialogs-as-columns.md), [0031-publish-the-dialogs-and-config-contracts](./0031-publish-the-dialogs-and-config-contracts.md), [0033-upgrade-to-ink-8-and-react-19-3](./0033-upgrade-to-ink-8-and-react-19-3.md), [0037-add-multi-select](./0037-add-multi-select.md), [0038-add-embeddable-grid-components](./0038-add-embeddable-grid-components.md)
