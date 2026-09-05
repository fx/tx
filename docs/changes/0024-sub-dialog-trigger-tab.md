# 0024: Sub-Dialog Trigger Tab

## Summary

Retarget the bundled `select` sub-dialog trigger from Ctrl+Enter to Tab: Tab on an option declaring a sub-dialog opens it as an overlapping panel stacked over its parent, with Escape popping, whole-stack resolution, and the stacked look unchanged. [Dialogs](../specs/dialogs/) owns the observable behavior.

**Specs:** [Dialogs](../specs/dialogs/)
**Status:** complete
**Depends On:** [0023](./0023-cascading-sub-dialogs.md)

## Motivation

Ctrl+Enter only arrives distinctly under the kitty keyboard protocol. On terminals without it — tmux before extended-keys support, for example — the chord arrives as plain Enter and confirms the option instead of opening anything, which is exactly what `bun demo nested` showed. Tab arrives as one keystroke on every terminal with no protocol needed, and the dialogs never otherwise answer it: standalone inputs and field entries have no focus to move, and the select has none either. So the trigger works everywhere for the cost of a name.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable trigger behavior MUST have automated tests.
- Dialog tests MUST use injected streams or controlled terminal doubles and MUST NOT read from or write to the process-global streams.
- `test/plugin-boundary.test.ts` MUST keep passing for the bundled plugin graph.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Dialogs](../specs/dialogs/) owns the [cascading sub-dialogs](../specs/dialogs/index.md#cascading-sub-dialogs) trigger wording and the stacked-panels half of [presentation](../specs/dialogs/index.md#presentation): the Tab trigger, the `· Tab expand` hint, and the typed-or-pasted-text interplay. Its scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **The trigger is Tab, fixed — no configurable chords, no bare letters, no function keys, no modifier.** Tab is the only key the dialogs never otherwise answer, so it needs no per-request configuration and no focus model. Shift+Tab reports the same key and opens a sub-dialog too rather than reaching the filter as text.
- **The capability stays internal and structural.** No dialog vocabulary enters `src/` or `@fx/tx/plugin`, and no dialogs module is exported.
- **The manual follows the implementation.** `docs/manual/plugins.md` documents Tab, the no-protocol-needed delivery, popping, resolution, and the stacked look in the PR that ships them.
- **The demo follows the implementation.** The repo-root `demo` names Tab in its header and usage text.

## Design

### Approach

The select view answers `key.tab` where it answered the modified return report, keeping the push, pop, resolution, values-merge, validation, and stacked presentation exactly as they are. The hint names `Tab expand` exactly while a visible option declares a sub-dialog. Tests drive the trigger with `"\t"`, including one new case proving the key opens a sub-dialog from a filtered list without reaching the filter as text.

### Decisions

- **Decision:** The trigger is Tab, fixed.
  - **Why:** Ctrl+Enter needs the kitty keyboard protocol, which most terminals in the wild do not speak; Tab arrives everywhere and collides with nothing the dialogs answer.
  - **Alternatives considered:** Keeping Ctrl+Enter alongside Tab as a second trigger was rejected as two ways to say the same thing with a detection matrix for the second. A per-request hotkey map was rejected as configuration surface for a trigger with one binding, same as in 0023.

### Non-Goals

- Any change to matching, navigation, field collection order, results of flat dialogs, stacking, popping, resolution, values merging, validation, or cleanup semantics beyond the trigger key and its hint.
- Focus movement between fields, multi-field forms, field validation, or any new field type.
- Configurable themes, palettes, offsets, or shadows.

## Tasks

- [x] Provider trigger and hint
  - [x] Answer `key.tab` in the select view's input handler, replacing the Ctrl+Enter report
  - [x] Name `Tab expand` in the select hint exactly while a visible option declares a sub-dialog
  - [x] Update provider comments (`types.ts` declaration, stack and trigger notes) to Tab
  - [x] Verify 100% coverage and `bun run check`
- [x] Tests
  - [x] Drive the trigger with `"\t"` across the cascading sub-dialog suite
  - [x] Add Tab-from-filtered-list coverage proving the key opens rather than types
  - [x] Verify 100% coverage and `bun run check`
- [x] Spec, manual, and demo
  - [x] Retarget the spec's trigger wording, scenarios, hint contract, and changelog
  - [x] Retarget the manual's trigger wording and hint literal
  - [x] Retarget the repo-root `demo` header and usage text to Tab
  - [x] Record this change's changelog row in the spec
  - [x] Verify 100% coverage and `bun run check`, then set this document's status to complete and sync `docs/index.yml` and `docs/index.md`

## Open Questions

None.

## References

- Specs: [Dialogs](../specs/dialogs/), [Plugin System](../specs/plugin-system/), [Architecture](../specs/architecture/)
- Related changes: [0023-cascading-sub-dialogs](./0023-cascading-sub-dialogs.md), [0021-restyle-dialogs-as-norton-commander](./0021-restyle-dialogs-as-norton-commander.md)
- Manual: [Plugins](../manual/plugins.md)
- External: [Ink](https://github.com/vadimdemedes/ink) — `useInput` key report with `tab`, `useWindowSize`; [Norton Commander](https://en.wikipedia.org/wiki/Norton_Commander) for the overlapping-panel vocabulary
