# 0020: Add Select Filter and Viewport

## Summary

Give the bundled `select` dialog a type-to-filter input that is the active element from the moment the dialog opens, enabled per request or automatically for long lists, and bound the option list to a scrolling viewport so long lists stay usable. [Dialogs](../specs/dialogs/) owns the observable behavior of both.

**Specs:** [Dialogs](../specs/dialogs/)
**Status:** complete
**Depends On:** [0017](./0017-add-dialog-text-input-and-composition.md)

## Motivation

`select` renders every option and moves the cursor one row at a time. That is fine for three choices and hopeless for thirty: the list overflows the terminal, and reaching the twentieth entry takes twenty keystrokes. A consumer offering branches, marketplaces, plugins, or versions needs the user to type a few characters and press Enter.

The two halves are one change because neither is useful alone. A filter over a list that still overflows the screen does not help the user see what matched, and a viewport without a filter still makes the user scroll. Shipping them together also keeps the visual change that follows ([0021](./0021-restyle-dialogs-as-norton-commander.md)) purely visual: every row it styles — filter, options, overflow indicators — exists after this change.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable filtering, matching, activation, navigation, viewport, indicator, resize, and request-validation behavior MUST have automated tests.
- Dialog tests MUST use injected streams or controlled terminal doubles and MUST NOT read from or write to the process-global streams.
- `test/plugin-boundary.test.ts` MUST keep passing for the bundled plugin graph.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Dialogs](../specs/dialogs/) owns the [filter request](../specs/dialogs/index.md#filter-request) setting and its default, [filtering](../specs/dialogs/index.md#filtering) — term matching, pinned user-provided options, activation on change, the no-match state, and cancellation — the [viewport](../specs/dialogs/index.md#viewport), and the extended [selection](../specs/dialogs/index.md#selection) keys. Its scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **The capability stays internal and structural.** `filter` is added to the provider's local request type; no bundled consumer declares a dialogs type yet, so there is nothing else to update. No dialog vocabulary enters `src/` or `@fx/tx/plugin`, and no dialogs module is exported.
- **Existing callers are untouched.** `filter` is optional and `"auto"` leaves a list of eight or fewer options behaving exactly as today, so no caller changes in this PR; there is no external caller to migrate.
- **Filter entry reuses text entry.** The filter's printable-input, chunk, and Backspace handling is the existing entry logic, not a second implementation, so the control-sequence rule in `REVIEW.md` keeps holding once rather than twice.
- **Matching is a pure function.** Visibility is computed from the option list and the filter text alone, with no state of its own, so it is tested directly and the dialog's rendering tests stay about rendering.
- **One render session, one input handler.** The filter, list navigation, and field collection remain the single `select` session with the existing cleanup-before-settlement contract; collection still declines everything but cancellation, filter edits included.
- **The manual follows the implementation.** `docs/manual/plugins.md` documents the `filter` setting, matching, pinned options, the viewport, and the new keys in the PR that ships them; its current "unrelated input is ignored" and "Up and Down move one position" sentences are corrected in the same PR.

#### Scenario: Short lists are unchanged

- **GIVEN** the existing test that sends `x` to a three-option select and expects it ignored
- **WHEN** this change lands
- **THEN** that test passes unmodified, because three options leave `"auto"` off

## Design

### Approach

`plugins/dialogs/index.ts` is already the largest bundled plugin, and this change adds three concerns to `select`. The plugin boundary test permits relative imports that stay within `plugins/dialogs/`, so the implementation splits into modules under that directory: the matcher (filter text → visible indices), the viewport arithmetic (visible count, active index, terminal rows → window start and hidden counts), and the select view that composes them with the existing entry logic. `index.ts` keeps the adapters, the render session, and registration. The `require("node:stream")` loader stays exactly as it is, for the coverage reason `REVIEW.md` records.

The select view holds three pieces of state: the filter text, the active index into the visible list, and the window start. Typing changes the filter text and resets the active index to zero; the window start follows the active index minimally. Navigation keys change the active index within the visible list. Enter on a visible plain option settles; on a visible user-provided option it begins collection as today. With no visible option, Enter and navigation return early.

Visibility is `options.map((option, index) => ...)` filtered to indices whose option declares fields or whose lowercased label contains every lowercased whitespace-separated term. The active index and the window are always expressed over that visible index list, so the supplied option order survives and the settled value is looked up by original index.

The viewport height is `min(10, rows - chrome - 1, visible.length)` with a floor of one, where `rows` comes from Ink's window-size hook (which reads the injected output adapter's `rows` and re-renders on the forwarded `resize` event, both already in place) and `chrome` counts every non-option row the dialog draws, indicator rows and the hint line included. The `- 1` is load-bearing: Ink treats output as tall as the terminal as full-screen and clears the terminal when such output is replaced or unmounted, which is the clearing the spec forbids; keeping the dialog strictly shorter than the terminal keeps Ink in its ordinary incremental mode. Because the count depends on which chrome rows [0021](./0021-restyle-dialogs-as-norton-commander.md) adds, the chrome height is a single constant the later change updates rather than something spread through the arithmetic. The test output double already exposes `rows` and `columns` as mutable fields that an existing test changes mid-dialog, so viewport tests set them the same way.

Rendering in this change stays unstyled but uses the glyphs the spec fixes, so its tests assert on the final strings and 0021 changes only styling: the filter row is `›` followed by a space and the text, hidden rows are indicated by `▲ N more` / `▼ N more` on the relevant side, and an empty visible list renders `no match`. The `›` prompt is deliberately distinct from the `>` marker the active option still carries in this change, so an assertion on `> Alpha` cannot be satisfied by filter text.

### Decisions

- **Decision:** `filter` is `boolean | "auto"` with `"auto"` as the default and a fixed threshold of more than eight options.
  - **Why:** A caller that never thinks about the filter still gets one when it matters, and a caller that knows its list is best unfiltered — a short menu of verbs, say — can say so. A count threshold, unlike one derived from terminal height, gives the same behavior on every terminal, so a test and a user see the same thing. Eight fits comfortably under the ten-row viewport, so a list that gets a filter is also one that scrolls.
  - **Alternatives considered:** Always on was rejected because a two-option select with a filter row looks broken. A count-only option (`filterAbove: n`) was rejected as configuration nobody asked for; the boolean overrides cover both directions.

- **Decision:** Case-insensitive substring matching on whitespace-separated terms, all of which must match, in any order, against the label only.
  - **Why:** It is what a user expects from "type to filter", it never surprises with a match the user cannot see, it needs no ranking so the caller's order survives, and it is a pure function of two strings. Term splitting lets `rel 1.4` find `release/1.4` without the user recalling the separator.
  - **Alternatives considered:** Fuzzy subsequence matching was rejected because its matches are hard to predict and it wants a ranking to be useful, and ranking would reorder the caller's list. Prefix matching was rejected as too strict for labels like `origin/release/1.4`. Matching against values was rejected because values are opaque.

- **Decision:** Options that declare fields are always visible.
  - **Why:** A user-provided option is the caller's "none of these" answer. Typing something that matches nothing is exactly the moment the user needs it, and it must not be the moment it disappears.
  - **Alternatives considered:** Filtering every option uniformly was rejected for the above. Rendering pinned options separately, outside the list, was rejected as a layout the spec does not own and a second navigation region.

- **Decision:** Changing the filter text always makes the first visible option active.
  - **Why:** The point of typing is to narrow to the thing you want and press Enter; the first match is that thing far more often than whatever row happened to be under the bar. It also removes a class of state bugs where the active index outlives its option.
  - **Alternatives considered:** Keeping the previously active option active when it remains visible was rejected because it makes Enter's target depend on history the user cannot see.

- **Decision:** Escape cancels; it never clears the filter.
  - **Why:** [0017](./0017-add-dialog-text-input-and-composition.md) fixed Escape's single meaning for this capability, and Ctrl-C must never mean "clear". Backspace clears a filter quickly enough, and a two-meaning Escape is the most common way filter prompts surprise their users.
  - **Alternatives considered:** Escape clearing a non-empty filter first was rejected for the above. A dedicated clear key was rejected as surface nobody asked for; it can be added without changing Escape.

- **Decision:** The viewport applies to every select, not only filtered ones.
  - **Why:** A filtered-off list of thirty options overflows exactly as a filtered one does, and having two rendering paths for the same list is a bug factory. A short list is unaffected: the window is as tall as the list.
  - **Alternatives considered:** A viewport only when the filter is on was rejected for the above.

- **Decision:** At most ten option rows, and the window scrolls minimally.
  - **Why:** Ten rows is the largest window that still leaves a reasonable terminal usable, and it is small enough that the indicators' hidden counts are meaningful. Minimal scrolling keeps the list still under the cursor bar; a centered-cursor window would move every row on every keystroke.
  - **Alternatives considered:** Filling the terminal was rejected because a dialog that consumes the screen is a different kind of interface. Paging (replacing the window a page at a time) was rejected because it hides the option next to the active one.

- **Decision:** Page Up, Page Down, Home, and End join Up and Down.
  - **Why:** Once a list scrolls, reaching its end one row at a time is the problem this change exists to solve, and the terminal's own keys for that are already parsed by the host's input layer at no cost. They apply to the visible list, so they compose with the filter.
  - **Alternatives considered:** Leaving them out was rejected as a certain follow-up.

- **Decision:** Split `plugins/dialogs/` into modules rather than growing `index.ts`.
  - **Why:** Matching and viewport arithmetic are pure and deserve direct tests; keeping them out of the view keeps the view's tests about rendering. The boundary test already allows relative imports within one plugin directory.
  - **Alternatives considered:** One file was rejected because it is already 600 lines before this change.

### Non-Goals

- Any change to how a dialog looks beyond the rows this change adds; framing, shading, and animation belong to [0021](./0021-restyle-dialogs-as-norton-commander.md).
- Fuzzy matching, ranking, match highlighting, matching against values, a caller-supplied matcher, or an initial filter text.
- A filter on `input`, or on a field under collection.
- Multi-select, disabled or grouped options, or custom option rendering.
- Caret movement, word deletion, or clipboard handling in the filter.
- Mouse or scroll-wheel input.
- Returning to the option list from field collection, or clearing the filter on Escape.
- A dialogs command namespace or a permanent demo command.

## Tasks

- [x] Add the select filter
  - [x] Add `filter?: boolean | "auto"` to the local `SelectRequest` in `plugins/dialogs/index.ts`, defaulting to `"auto"` with the more-than-eight threshold
  - [x] Extract the visibility matcher into a module under `plugins/dialogs/`: whitespace-separated terms, case-insensitive substring against the label, fielded options always visible, supplied order preserved
  - [x] Render the `›` filter row and route printable input and Backspace to the filter through the existing entry logic when the filter is enabled, leaving printable input ignored when it is disabled
  - [x] Make the first visible option active whenever the filter text changes, navigate within the visible list, render the no-match state, and make Enter and navigation no-ops when nothing is visible
  - [x] Keep Escape and Ctrl-C cancelling at every stage, and stop filter edits once field collection begins
  - [x] Add Bun tests for the matcher directly and for the dialog: auto threshold on either side of eight, explicit `true` and `false`, typing narrows and Enter selects, multi-term matching, Backspace widening, pinned user-provided option, no-match state, navigation within the visible list, cancellation with a non-empty filter, and collection declining filter edits
  - [x] Document the filter in `docs/manual/plugins.md` and correct its navigation and ignored-input sentences
  - [x] Verify 100% coverage and `bun run check`

- [x] Add the viewport and extended navigation
  - [x] Extract the viewport arithmetic into a module under `plugins/dialogs/`: at most ten rows, reduced so the dialog stays strictly shorter than the terminal using a single chrome-height constant, floor of one, minimal window movement, hidden counts per side
  - [x] Read terminal rows through the injected output adapter so the window re-derives on the forwarded `resize` event
  - [x] Render only the windowed options plus the `▲ N more` and `▼ N more` indicators with their hidden counts, and `no match` for an empty visible list
  - [x] Handle Home, End, Page Up, and Page Down over the visible list with clamping
  - [x] Add Bun tests for the arithmetic directly and for the dialog: opens at the top with the below count, window follows the active option, short terminal shrinks the window and the dialog stays shorter than the terminal, resize re-derives it, Home and End, Page keys clamp, and the window composes with a filter
  - [x] Document the viewport and the new keys in `docs/manual/plugins.md`
  - [x] Verify 100% coverage and `bun run check`, then set this document's status to complete and sync `docs/index.yml` and `docs/index.md`

## Open Questions

- [ ] Whether the `"auto"` threshold should be lower than eight once a bundled consumer presents a real list — the spec records it as revisitable; nothing in this change depends on the number beyond one constant and its tests.
- [ ] Whether the [viewport](../specs/dialogs/index.md#viewport)'s "never fewer than one" option row wants qualifying: at exactly `selectChromeHeight + 1` terminal rows with a user-provided option present, three of that section's requirements cannot all hold. One option row plus the chrome comes to exactly the terminal's height — which is what Ink reads as full-screen — so keeping that row breaks the "MUST NOT clear the terminal" guarantee, while dropping it breaks both "never fewer than one" and "The active option MUST always be among the rendered options". This change chose the no-clearing guarantee over both of the others, since a terminal wiped out from under the reader is the failure a user actually sees, while a row they were never shown is not; below that height the window renders nothing either, so those two go on failing where the no-clearing rule no longer applies.
- [ ] Whether the [viewport](../specs/dialogs/index.md#viewport)'s no-clearing guarantee wants a floor below which it is explicitly abandoned. The window shrinking to nothing bounds the option rows, but a frame has a minimum height of its own that no window can shrink below: once [0021](./0021-restyle-dialogs-as-norton-commander.md) frames the dialog, a filter-enabled select's smallest frame is five rows while choosing — two panel edges, the filter prompt, one overflow indicator, and the key hint line — and eight once a field's panel is on screen. So a terminal of five rows or fewer while choosing, or eight or fewer while collecting, cannot host a frame strictly shorter than itself whatever the window does, and Ink clears it on the way out. Six and nine rows are where the guarantee starts holding again, and the tests pin it from there up. Reducing the minimum further would mean dropping rows the spec makes mandatory — the filter text, the overflow indicators, the key hints — so it is a spec question rather than an implementation one.

## References

- Specs: [Dialogs](../specs/dialogs/), [Plugin System](../specs/plugin-system/), [Architecture](../specs/architecture/)
- Related changes: [0017-add-dialog-text-input-and-composition](./0017-add-dialog-text-input-and-composition.md), [0021-restyle-dialogs-as-norton-commander](./0021-restyle-dialogs-as-norton-commander.md)
- Manual: [Plugins](../manual/plugins.md)
- External: [fzf](https://github.com/junegunn/fzf) and [InquirerPy fuzzy prompt](https://inquirerpy.readthedocs.io/en/latest/pages/prompts/fuzzy.html), the type-to-filter interactions this change deliberately simplifies
