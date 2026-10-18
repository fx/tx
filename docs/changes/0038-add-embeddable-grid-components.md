# 0038: Add Embeddable Grid Components

## Summary

Expose the grid as two components a plugin renders inside its own render session: `Grid`, the printed lines as an element laid out for a given width, and `SelectGrid`, the driven grid over the dialogs' embeddable `Select`. `print` and `select` stay as they are.

**Spec:** [Grid](../specs/grid/)
**Status:** draft
**Depends On:** 0029, 0030, 0036

## Motivation

A plugin running its own full-screen session cannot use either half of the grid. `print` writes to a stream, and a write beneath a live session lands under it and is overwritten by the next frame. `select` takes the terminal for a dialog session of its own, which fights the host's session as `select` in [Dialogs](../specs/dialogs/) does. Both halves already have what a component needs: `gridElement` in `plugins/grid/render.ts` builds the element `printGrid` renders to a string, and `selectRequest` and `selection` in `plugins/grid/select.ts` are a pure mapping to and from a dialogs request. What is missing is a way for a host to get them.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions)). CI enforces these as merge gates:

- Tests MUST use Bun's test runner, and new observable behavior MUST have automated tests.
- Tests MUST maintain 100% statement, function, and line coverage across production source files; coverage exclusions MUST stay limited to generated or non-executable files and MUST be documented in configuration.
- Every first-party executable file committed MUST be reachable by the linter, the type checker, and the test suite; a published contract module MUST NOT escape those gates by being types-only.
- Committed tests MUST NOT contain focused or skipped cases without a documented reason.
- Biome formatting and lint, and TypeScript, MUST pass with no errors; `bun run check` MUST pass.
- The components MUST be tested as a host uses them: a host component rendered through the injected `ink.render` on captured streams, rendering `grid.Grid` and `grid.SelectGrid` read from the registry, as `test/dialogs-plugin.test.ts` drives the dialogs' function form.
- Every existing test of `print` and `select` MUST keep passing without an assertion changing.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Grid: Embeddable Grid](../specs/grid/index.md#embeddable-grid) and [Grid: Embeddable Selection](../specs/grid/index.md#embeddable-selection) own both components' behavior and the scenarios that are this change's acceptance criteria; [Grid: Grid Capability](../specs/grid/index.md#grid-capability) owns the contract's membership and conceptual shape; [Dialogs: Embeddable Components](../specs/dialogs/index.md#embeddable-components) owns the props both share. None of it is restated here. What implementing them requires of this change:

- The published contract is `plugins/grid/contract.ts`. It gains `GridProps` and the `Grid` member in the first task, and `SelectGridProps<T, A>` and the `SelectGrid` member in the second. `SelectGridProps` imports `EmbeddedProps` type-only from `@fx/tx/dialogs`, the published specifier, exactly as the contract already imports `ThemeVariable` from `@fx/tx/theme`; a relative import into `plugins/dialogs/` is what `test/plugin-boundary.test.ts` forbids.
- The two tasks are independent of each other. The `Grid` task depends on nothing in [Change 0036](./0036-add-embeddable-dialog-components.md) and may land first; the `SelectGrid` task needs the dialogs' `Select` component and `EmbeddedProps` type, so it lands after 0036.
- `select` keeps calling `dialogs.select` with the request `selectRequest` builds. Since 0036 makes `dialogs.select` mount the dialogs' `Select`, `select` is `SelectGrid` mounted the way the spec requires without being rewritten.
- The plugin guide's grid section ([`docs/manual/plugins.md`](../manual/plugins.md#use-the-bundled-grid-capability)) documents each component in the task that ships it. The README documents no capability and does not change.

## Design

### Approach

1. **`Grid`.** A component created once at registration. It lays out with `gridLines` from `geometry.ts`, passing `width` where `printGrid` passes `layoutColumns(request.stream)`, and returns `gridElement(react, ink, theme, lines)` — or `null` when there are no lines. It resolves the theme for `context.stderr` once per mount, so the plugin's registration function takes `context` alongside `dependencies`, `register`, and `registrations`.
2. **`SelectGrid`.** A component created once at registration. On mount it reads `requireDialogsCapability(registrations)` from `plugins/grid/dialogs.ts`, which throws naming the count, and maps its request with `selectRequest` once. It renders `react.createElement(dialogs.Select, …)` with its own `width`, `height`, and `isActive`, an `onSubmit` that maps the dialogs result back through `selection(request, result.value)`, and its own `onCancel`.

### Decisions

- **Decision**: `GridProps.request` is the printing request without its stream, nested under `request` rather than spread into the props.
  - **Why**: every other embeddable component takes its request as `request`, so a host learns one prop shape; and because the type omits `stream` rather than forbidding it, a host holding a `GridRequest` it would print can pass it unchanged.
  - **Alternatives considered**: spreading the request's fields into the props beside `width`, which makes `Grid` the one component a host feeds differently.

- **Decision**: `Grid` resolves its theme for the injected `context.stderr`.
  - **Why**: a component has no stream of its own, and the dialogs resolve against that stream; an embedded grid beside an embedded select then agrees with it about whether colour is on.
  - **Alternatives considered**: a theme or stream prop from the host, which puts appearance back in the consumer's hands and contradicts [Grid: Grid Capability](../specs/grid/index.md#grid-capability)'s rule that the grid resolves every appearance itself.

- **Decision**: `Grid` passes `gridElement` the whole lines, trailing characters included, and does not use `printGrid`'s `splitTrailing`.
  - **Why**: `splitTrailing` exists because `printGrid` renders to a string and `renderToString` trims each line's unstyled trailing whitespace; it holds those characters back and appends them to the string afterwards. `Grid` renders to no string, so the element itself carries every character of every line, a cell's own trailing spaces included, as [Grid: Embeddable Grid](../specs/grid/index.md#embeddable-grid) requires. Whether the host's session then writes trailing spaces to the terminal is that session's renderer's business, which the spec leaves to it. The test reads the element's text, not the host's frame, for the trailing-space scenario.
  - **Alternatives considered**: splitting the lines as `printGrid` does and appending the held-back text as an extra unstyled `Text`, which carries the same characters in more pieces for no observable difference.

- **Decision**: `SelectGrid` reads the dialogs capability when it mounts, not when the grid registers.
  - **Why**: the registry rule every consumer follows — a plugin reading during its own initialization sees only what committed before it — and the same lookup `select` performs.
  - **Alternatives considered**: none consistent with [Plugin System](../specs/plugin-system/).

### Non-Goals

- Multi-row selection over a grid; a selecting grid never declares a multiple column.
- Any change to `print`, its bytes, or its stream handling, and any change to `select`'s observable behavior.
- Scrolling, sizing to a height, or clipping a printed `Grid`; it is as tall as its lines.
- Any change under `src/`.

## Tasks

- [x] Add the embeddable `Grid` component
  - [x] `plugins/grid/contract.ts`: `GridProps` and the `Grid` member, types alone
  - [x] `plugins/grid/render.ts` and `plugins/grid/index.ts`: the component, laid out against `width` and themed for `context.stderr`, created once at registration
  - [x] `test/grid-embedded.test.ts`: a host component rendered through `coreDependencies.ink.render` on captured streams, covering every scenario in [Grid: Embeddable Grid](../specs/grid/index.md#embeddable-grid) — the flow matching the printed one, re-flow on a width change, nothing written to the request's stream, a cell's own trailing spaces reaching the host — plus an empty grid drawing nothing and sanitized cells
  - [x] `test/plugin-consumer.test.ts`: the consumer fixture types `Grid` through the published contract; `test/plugin-boundary.test.ts` keeps passing
  - [x] [`docs/manual/plugins.md`](../manual/plugins.md#use-the-bundled-grid-capability): document `Grid`
  - [x] [Grid](../specs/grid/) spec: mark [Embeddable Grid](../specs/grid/index.md#embeddable-grid) implemented and add a changelog row
- [ ] Add the embeddable `SelectGrid` component (after [Change 0036](./0036-add-embeddable-dialog-components.md))
  - [ ] `plugins/grid/contract.ts`: `SelectGridProps<T, A>` importing `EmbeddedProps` type-only from `@fx/tx/dialogs`, and the `SelectGrid` member
  - [ ] `plugins/grid/index.ts` and `plugins/grid/select.ts`: the component over the dialogs' `Select`, mapping the request on mount and the answer on submit
  - [ ] `test/grid-embedded.test.ts`: every scenario in [Grid: Embeddable Selection](../specs/grid/index.md#embeddable-selection) — acting on a row, cancelling, and the absent dialogs provider — plus `isActive`, `height`, and a row offering no actions
  - [ ] `test/plugin-consumer.test.ts`: the consumer fixture types `SelectGrid`, resolving the grid contract through the dialogs contract in the packed tarball
  - [ ] [`docs/manual/plugins.md`](../manual/plugins.md#use-the-bundled-grid-capability): document `SelectGrid`
  - [ ] [Grid](../specs/grid/) spec: mark [Embeddable Selection](../specs/grid/index.md#embeddable-selection) implemented and add a changelog row; set this change `complete` in `docs/index.yml` and `docs/index.md`

## References

- Spec: [Grid: Embeddable Grid](../specs/grid/index.md#embeddable-grid), [Grid: Embeddable Selection](../specs/grid/index.md#embeddable-selection), [Grid: Grid Capability](../specs/grid/index.md#grid-capability), [Dialogs: Embeddable Components](../specs/dialogs/index.md#embeddable-components)
- Related changes: [0029-add-interactive-grid-row-actions](./0029-add-interactive-grid-row-actions.md), [0030-publish-bundled-capability-contracts](./0030-publish-bundled-capability-contracts.md), [0036-add-embeddable-dialog-components](./0036-add-embeddable-dialog-components.md)
