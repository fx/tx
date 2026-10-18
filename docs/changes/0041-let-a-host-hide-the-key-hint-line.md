# 0041: Let a Host Hide the Key Hint Line

## Summary

Add an optional `keyHints` prop to the embeddable components, on by default, with which a host turns the key hint line off: no line under the frame, none under an entry a select collects, the component laid out in its frame's width alone, and the hint line's row given back to a select's option rows. The function forms always draw their hint.

**Spec:** [Dialogs](../specs/dialogs/)
**Status:** complete
**Depends On:** 0040

## Motivation

An embedded `Select` or `Input` always draws a key hint line under its frame. A host that shows its own key help — a bar of its own naming the keys of whatever has focus — gets the same keys named twice, once by the component and once by itself, and has no way to stop it. The line also costs the host a row it may not have, and because a dialog is laid out in the wider of its frame and its hint line, it widens the component past its frame: whatever the host places beside a short select starts after the hint's last character rather than after the frame's closing border.

Only the host knows whether it shows its own key help, so the choice is the host's to make, the way `width`, `height`, and `isActive` already are.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions)). CI enforces these as merge gates:

- Tests MUST use Bun's test runner, and new observable behavior MUST have automated tests.
- Tests MUST maintain 100% statement, function, and line coverage across production source files; coverage exclusions MUST stay limited to generated or non-executable files and MUST be documented in configuration.
- Committed tests MUST NOT contain focused or skipped cases without a documented reason.
- Biome formatting and lint, and TypeScript, MUST pass with no errors; `bun run check` MUST pass.
- The components MUST be tested as a host sees them — in a session rendered through the injected `ink.render`, as [Change 0036](./0036-add-embeddable-dialog-components.md) established: the rows a select of a given height draws without key hints and how far Page Down moves in them, the width the component is laid out in beside a host's own content, a select and an input drawn over the host's rows, a field collected and a text leaf opened without key hints, and `keyHints` true drawing exactly what leaving it out draws. `SelectGrid` MUST be tested passing the prop through, and the published-contract consumer fixture MUST set it.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Dialogs: Presentation](../specs/dialogs/index.md#presentation) owns where a key hint line is drawn, [Dialogs: Embeddable Components](../specs/dialogs/index.md#embeddable-components) owns the `keyHints` prop and how it changes the height budget, the laid-out width, and what a host's content shows through, with the scenarios that are this change's acceptance criteria, and [Grid: Embeddable Selection](../specs/grid/index.md#embeddable-selection) owns `SelectGrid` passing it through. None of it is restated here. What implementing them requires of this change:

- One contract addition: the optional `keyHints` on `EmbeddedProps<R>` in `plugins/dialogs/contract.ts`. No new type names.
- Nothing under `src/` changes, and neither do `plugins/dialogs/frame.ts` or `plugins/dialogs/viewport.ts`: the frame already draws no hint line and lays out in the panel's width where it is given none, and the viewport's chrome constants are left counting one hint row.
- The function forms `select` and `input` are unchanged: they never pass `keyHints`, so they always draw their hint.

## Design

### Approach

1. **The contract.** `EmbeddedProps<R>` gains `keyHints?: boolean`, documented as defaulting to true; the `height` and `InputProps` comments say the hint line counts only where one is drawn.
2. **The entry.** `Entry` takes `keyHints`, defaulting to true, and passes its frame no hint where it is false. The frame then draws no hint row and is laid out in its panel's width, which is what `laidOutWidth` already returns for no hint.
3. **The select.** `SelectView` takes `keyHints` as a required prop. Its frame gets no hint where it is false, and both entries it mounts — a collected field and a text leaf — are given it. Its height budget is measured against `height + 2` rather than `height + 1` where it is false: the viewport's chrome constants count one hint row, under the frame or under the entry, and one more measured row hands that row back to the option rows. That one budget feeds every viewport call, so the window, the band rows, and Page Down all agree.
4. **The components.** `Select` and `Input` default `keyHints` to true and pass it to the view and the entry; `SelectGrid` defaults it to true and passes it to the `Select` it is drawn as.

### Decisions

- **Decision**: one boolean, `keyHints`, on the props every embeddable component shares, defaulting to on.
  - **Why**: whether the host shows key help of its own is a property of the host, not of the request, and every embeddable component draws a hint line; a default of on keeps every existing host's output unchanged and leaves a host that says nothing with a component that tells its reader the keys.
  - **Alternatives considered**: a prop on `Select` and `Input` alone, which `SelectGrid` would then have to re-declare; a hint string the host supplies, which makes the host restate wording the dialog already keeps in step with its mode.

- **Decision**: turning it off also removes the hint under an entry a select collects.
  - **Why**: the entry's hint is the select's hint for that mode — the select draws none of its own while one is on screen — so a host that has turned key hints off would otherwise see them come back exactly when a field opens.

- **Decision**: the row a hint line would take goes to the option rows, and the width follows the frame alone.
  - **Why**: a row or a column reserved for a line that is never drawn is a blank the host cannot use; the height a host gives is the most rows the select draws, and with no hint line the select can draw one more option row in it.

- **Decision**: the function forms always draw their hint.
  - **Why**: they own their session, so nothing else on screen can name the keys for them.

### Non-Goals

- Placing a component — centring it, or anywhere else — which stays the host's.
- Changing the hint line's wording, or the keys any dialog answers.
- Any change to how rows are painted, which [Change 0040](./0040-paint-dialog-rows-to-their-own-width.md) settled.
- Any change to `plugins/dialogs/frame.ts`, `plugins/dialogs/viewport.ts`, or `src/`.

## Tasks

- [x] Let a host hide the key hint line
  - [x] `plugins/dialogs/contract.ts`: the optional `keyHints` on `EmbeddedProps<R>`, and the `SelectProps.height` and `InputProps` comments
  - [x] `plugins/dialogs/entry.ts`: `keyHints`, defaulting to true, passing the frame no hint where it is false
  - [x] `plugins/dialogs/select.ts`: the required `keyHints` view prop, the height budget handing the hint row back, the frame's hint, and both entries given it
  - [x] `plugins/dialogs/index.ts`, `plugins/grid/select.ts`: `Select`, `Input`, and `SelectGrid` defaulting it to true and passing it through
  - [x] `test/dialogs-embedded.test.ts`, `test/grid-embedded.test.ts`, `test/plugin-consumer.test.ts`: the rows, the width, the host's content, a collected field and a text leaf without key hints, the default, `SelectGrid` passing it through, and the consumer fixture setting it
  - [x] [Dialogs](../specs/dialogs/) and [Grid](../specs/grid/) specs and the [plugin guide](../manual/plugins.md): the prop, the amended rules, the new scenarios, and changelog rows; this change `complete` in `docs/index.yml` and `docs/index.md`

## References

- Spec: [Dialogs: Presentation](../specs/dialogs/index.md#presentation), [Dialogs: Embeddable Components](../specs/dialogs/index.md#embeddable-components), [Grid: Embeddable Selection](../specs/grid/index.md#embeddable-selection)
- Related changes: [0036-add-embeddable-dialog-components](./0036-add-embeddable-dialog-components.md), [0038-add-embeddable-grid-components](./0038-add-embeddable-grid-components.md), [0040-paint-dialog-rows-to-their-own-width](./0040-paint-dialog-rows-to-their-own-width.md)
