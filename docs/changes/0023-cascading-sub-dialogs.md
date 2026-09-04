# 0023: Cascading Sub-Dialogs

## Summary

Give the bundled `select` dialog cascading sub-dialogs: an option MAY declare a nested select or a single text input that Ctrl+Enter opens as an overlapping panel stacked over its parent, Escape pops one level while anything is stacked and cancels only at the root, and completing any level resolves the whole stack with the chosen value and the inputs collected along the way. [Dialogs](../specs/dialogs/) owns the observable behavior.

**Specs:** [Dialogs](../specs/dialogs/)
**Status:** complete
**Depends On:** [0021](./0021-restyle-dialogs-as-norton-commander.md)

## Motivation

`select` is flat: Enter takes the active option, and the only thing an option can lead to is field collection. Any caller with a hierarchy — a category that drills into its items, an option that needs one clarifying value first — must either flatten the hierarchy into labels or chain separate dialogs with its own terminal handling in between. The [viability check](../specs/dialogs/index.md#open-questions) confirmed both halves are implementable inside one render session: a modified-key trigger that the filter ignores, and overlapping panels with an ASCII shadow.

The two halves are one change because neither is useful alone. A trigger that opens a sub-dialog rendered as another panel underneath is just sequential dialogs with extra state; overlapping panels without a way to open them are decoration. Shipping them together keeps the trigger, the stack discipline, and the look in one contract.

This change follows [0021](./0021-restyle-dialogs-as-norton-commander.md) so that every panel it stacks already exists.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable trigger, push, pop, resolution, values-merge, hint, overlap, shadow, clamping, and request-validation behavior MUST have automated tests.
- Dialog tests MUST use injected streams or controlled terminal doubles and MUST NOT read from or write to the process-global streams.
- `test/plugin-boundary.test.ts` MUST keep passing for the bundled plugin graph.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Dialogs](../specs/dialogs/) owns the [cascading sub-dialogs](../specs/dialogs/index.md#cascading-sub-dialogs) — the per-option declaration, the Ctrl+Enter trigger, one-session stacking, Escape popping, whole-stack resolution, values merging, and filter interplay — and the stacked-panels half of [presentation](../specs/dialogs/index.md#presentation): overlap, offset, shadow, clamping, and the expand hint. Its scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **The capability stays internal and structural.** The sub-dialog declaration joins the provider's local request type; no dialog vocabulary enters `src/` or `@fx/tx/plugin`, and no dialogs module is exported.
- **Terminal delivery of Ctrl+Enter is verified, not assumed.** The implementation confirms what the injected input layer reports for the chord and enables what distinguishes it, or records the terminals where the trigger cannot work — see the open question below.
- **Leaf inputs reuse text entry.** An input sub-dialog's editing is the existing entry logic, not a second implementation, so the control-sequence rule in `REVIEW.md` keeps holding once rather than twice.
- **The manual follows the implementation.** `docs/manual/plugins.md` documents the declaration, the trigger, popping, resolution, and the stacked look in the PR that ships them.

#### Scenario: Existing flat behavior is unchanged

- **GIVEN** the existing tests for a select whose options declare no sub-dialog
- **WHEN** this change lands
- **THEN** each passes unmodified, because no option declares anything to open and the trigger has nothing to act on

## Design

### Approach

The select view gains a stack of levels, each level holding what the flat dialog already holds: its request slice, its filter text, its active index, and its window start. Matching and viewport arithmetic stay pure and directly tested; the stack composition lives in the view. `index.ts` keeps the adapters, the render session, and registration. The `require("node:stream")` loader stays exactly as it is, for the coverage reason `REVIEW.md` records.

### Decisions

- **Decision:** The trigger is Ctrl+Enter, fixed — no configurable chords, no bare letters, no function keys.
  - **Why:** The filter owns every bare printable while enabled and ignores them while disabled, so any bare-letter trigger collides with one of those states. A single modified chord needs no per-request configuration and no focus model. Function-key delivery was left unverified deliberately: it varies by terminal and adds a detection matrix for one more way to say the same thing.
  - **Alternatives considered:** A per-request hotkey map was rejected as configuration surface for a trigger with one binding. Bare-letter triggers were rejected for the filter collision above.

- **Decision:** The declaration lives on the option, as `dialog`, holding either a nested select request or a single text field.
  - **Why:** The option is what the trigger acts on, so the option is what declares the consequence; an option without one makes the trigger a no-op, which keeps flat lists behaving exactly as today. A text field already carries the name, message, and initial value an input leaf needs, so no second leaf shape is introduced.
  - **Alternatives considered:** A dialog-level hotkey map from key to request was rejected because it separates the trigger from the option under the bar and needs its own validation. A distinct input-leaf type was rejected as a duplicate of the field model.

- **Decision:** Completing any level resolves the whole stack; Escape pops one level above the root and cancels at the root.
  - **Why:** Enter already means "this is the choice" at every level, so the finally-Entered option's value is the result and everything collected on the way down merges into its values. Popping on Escape mirrors that: Escape undoes the last push, and at the root there is nothing to undo, so it cancels as today.
  - **Alternatives considered:** Submitting an input leaf back to its parent for further navigation was rejected because it turns one outcome into two (pop vs resolve) with no trigger left to distinguish them. Per-level bubbling, where each completion returns to its parent, was rejected for the same reason with more steps.

- **Decision:** Input values merge by field name with deeper submissions winning collisions.
  - **Why:** Names are already opaque caller keys unique only within their declaring option; paths through different branches can honestly reuse a name, and at render time there is exactly one chain of submissions, so last-writer-wins is deterministic without a whole-graph validation pass before rendering.
  - **Alternatives considered:** Rejecting duplicate names across the reachable graph was rejected because it validates paths the user never walks. Namespacing values by level was rejected because it changes the result shape the caller already handles.

- **Decision:** The shadow is a dimmed block-fill box behind each stacked panel, greyscale only.
  - **Why:** It is the Norton Commander shadow in the palette the spec already fixes — default foreground, dim, and inverse, no hue — and a box the renderer draws needs no hand-drawn border arithmetic beyond the offset.
  - **Alternatives considered:** A hand-drawn `░` border was rejected as border code the renderer already owns. Any hue was rejected by the existing palette rule.

### Non-Goals

- Any change to matching, navigation, field collection order, results of flat dialogs, or cleanup semantics beyond keeping the stack inside the one session.
- Function-key, bare-letter, or configurable triggers; mouse or scroll-wheel input.
- Multi-field forms, field validation, or any new field type.
- Concurrent dialogs in separate render sessions; a stacked dialog is still one session.
- A confirm dialog, progress dialog, or any dialog beyond `select` and `input`.
- Configurable themes, palettes, offsets, or shadows.
- Screen-reader or accessibility policy beyond what the renderer does unprompted.

## Tasks

- [x] Stack, trigger, and pop
  - [x] Add the per-option `dialog` declaration to the provider's local request type, holding a nested select request or a single text field
  - [x] Hold a stack of levels in the select view inside the single render session: push the active option's sub-dialog on Ctrl+Enter, route all keys to the top level, pop one level on Escape above the root, cancel at the root
  - [x] Resolve the whole session on any level's completion with the completing option's value and the path's input values merged by field name, deeper winning; leave the filter text untouched by the trigger
  - [x] Validate every reachable sub-request before rendering alongside the existing rejections, so any invalid stack renders nothing
  - [x] Name the expand key in the select hint exactly while a visible option declares a sub-dialog
  - [x] Add Bun tests for the trigger as a no-op without a declaration, push and pop, root cancel, whole-stack resolution from a nested select and from an input leaf, values merging with a colliding name, filter text preserved across push and pop, and unchanged empty output on every pre-render rejection
  - [x] Verify 100% coverage and `bun run check`
- [x] Stacked presentation and manual
  - [x] Render stacked levels as overlapping offset panels with a dimmed block-fill shadow behind each panel above the root, clamped to the terminal, greyscale only
  - [x] Make the viewport row budget overlay-aware so a stacked dialog stays strictly shorter than the terminal
  - [x] Add Bun tests for the overlap offset, the shadow's dimmed rendering in one dedicated raw-output test, clamping on a narrow terminal, the shrunken window on a short terminal with a stack open, and a deep stack keeping the top level's option row on screen with lower levels covered
  - [x] Document the declaration, trigger, popping, resolution, and stacked look in `docs/manual/plugins.md`
  - [x] Verify 100% coverage and `bun run check`, then set this document's status to complete and sync `docs/index.yml` and `docs/index.md`

## Open Questions

- [x] How Ctrl+Enter is delivered on terminals without an enhanced keyboard protocol — superseded by [0024](./0024-sub-dialog-trigger-tab.md): the trigger is Tab, which arrives as one keystroke on every terminal with no protocol needed. (Earlier answer preserved for the record: enabling Ink's kitty protocol was tried and reverted — its enable/disable sequences pollute the error-stream frames and its auto mode replays buffered keys as text — and on a terminal that cannot deliver the chord, e.g. tmux 3.4 with `extended-keys off`, Ctrl+Enter arrived as plain Enter and confirmed the option.)

## References

- Specs: [Dialogs](../specs/dialogs/), [Plugin System](../specs/plugin-system/), [Architecture](../specs/architecture/)
- Related changes: [0021-restyle-dialogs-as-norton-commander](./0021-restyle-dialogs-as-norton-commander.md), [0020-add-select-filter-and-viewport](./0020-add-select-filter-and-viewport.md), [0017-add-dialog-text-input-and-composition](./0017-add-dialog-text-input-and-composition.md)
- Manual: [Plugins](../manual/plugins.md)
- External: [Ink](https://github.com/vadimdemedes/ink) — `Box` absolute positioning, `useInput` key report with `isActive`, `useWindowSize`; [Norton Commander](https://en.wikipedia.org/wiki/Norton_Commander) for the overlapping-panel vocabulary
