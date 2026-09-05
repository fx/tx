# 0023: Render Sub-Dialogs as Columns

## Summary

Lay the bundled `select` out as a column browser: a sub-dialog becomes the next column of the panel its parent is already in rather than a panel stacked over it, Enter opens an option that leads somewhere with `expand: "tab"` as the escape hatch, typing always filters, and the filter and the overflow counts are set into the frame's own edges so neither costs a row. It replaces the stacked, shadowed, Tab-triggered presentation the spec previously carried, wholly rather than in part: nothing of that presentation survives in the tree, so the two change documents that described it are removed here rather than kept alongside a design they no longer describe, and this document takes the first of their numbers. [Dialogs](../specs/dialogs/) owns the observable behavior.

**Specs:** [Dialogs](../specs/dialogs/)
**Status:** complete
**Depends On:** [0021](./0021-restyle-dialogs-as-norton-commander.md)

## Motivation

The stacked presentation cost the reader the thing they were in the middle of using. A sub-dialog opened as a panel over its parent, so the list the choice was made from — and the choice itself — went behind the panel that the choice led to. Three levels in, the only readable list was the deepest one, and the trail back out was a stack of title bars. A hierarchy is exactly the case where the path matters, and stacking hid it.

The shadow could not be composited. It was specified as a dimmed block-fill box behind each panel above the root, which the renderer has no way to draw: Ink lays out boxes, it does not compose a cell from two sources, so a shadow could only ever be a box of block characters that covered whatever it fell on. A surface-and-palette layer that would composite one anyway was tried and abandoned before it landed — it did not survive contact with a renderer that owns its own layout, and nothing in this change ships it.

And the panel would not hold still. A filter row appeared the moment the filter turned on and an overflow indicator row appeared the moment the window first hid something, each pushing every option row down by one — under a reader who was in the middle of typing or scrolling, which is precisely when those rows arrive. Rows that come and go are the wrong shape for chrome that comes and goes.

Miller columns answer all three at once. Columns side by side keep every list on screen, need no compositing because nothing overlaps, and give the filter and the counts somewhere to live that the panel was already spending rows on — its own edges.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable layout, opening, backing-out, filtering, and edge-chrome behavior MUST have automated tests.
- Column geometry — widths, collapsing, stretching, and cells — MUST be tested as pure functions rather than only through rendered frames.
- Dialog tests MUST use injected streams or controlled terminal doubles and MUST NOT read from or write to the process-global streams.
- `test/plugin-boundary.test.ts` MUST keep passing for the bundled plugin graph.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Dialogs](../specs/dialogs/) owns the [sub-dialog columns](../specs/dialogs/index.md#sub-dialog-columns) — the marker, the opening and backing-out keys, the `expand` binding, and what a column keeps while another is driven — together with the [filter request](../specs/dialogs/index.md#filter-request) and the column half of [presentation](../specs/dialogs/index.md#presentation): the single frame, the divider, the shared band, the trail title, collapsing, and the chrome set into the edges. Its scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **The capability stays internal and structural.** The `expand` setting joins the provider's local request type; no dialog vocabulary enters `src/` or `@fx/tx/plugin`, and no dialogs module is exported.
- **The geometry is pure.** Column widths, collapsing, stretching, and cells live in their own module over already-decided state, so they are directly testable rather than reachable only through a rendered frame.
- **The frame draws its own edges.** Chrome set into an edge is not something a border style can carry, so `Frame` takes rows as styled segments and draws its edges itself rather than delegating to Ink's `borderStyle`.
- **Nothing composites.** No shadow, no offset, no solid panel background, and no second surface to blend: one frame, drawn once.
- **The manual follows the implementation.** `docs/manual/plugins.md` documents the columns, the binding, the always-live filter, and the edge-set chrome in the PR that ships them.
- **The demo follows the implementation.** The repo-root `demo` shows a tree deep enough to need columns, one column long enough to scroll, and both bindings.

#### Scenario: Existing flat behavior is unchanged

- **GIVEN** the existing tests for a select whose options declare no sub-dialog
- **WHEN** this change lands
- **THEN** each passes with the same result, because a browser of one column is the flat dialog

## Design

### Approach

The select view keeps its stack of levels and stops treating the stack as a stack of panels. Every select level on it is a column of one browser: the view lays them out left to right, measures each against its own visible list, and hands the frame one band of rows built from all of them. `columns.ts` owns that geometry — the width one list takes, the width a run of them takes with its dividers, how many collapse off the left, how the last one is stretched into the room the title left, and the cells one column contributes to the band — as pure functions over already-decided state.

`Frame` stops using Ink's `borderStyle` and draws its own edges, because the filter and the overflow counts are set into them and a border style cannot carry a payload. It takes rows as styled segments rather than as children, so a row can mix a dimmed divider with an inverted bar and still be cut as one line.

`viewport.ts` loses everything the overlay needed — `stackedOffsetColumns`, `stackedShadowRows`, `stackedExtraRows`, and the `extraRows` parameter — because columns share the terminal's rows rather than spending them on each other. Its chrome counts drop with the rows the filter and the indicators used to take: `selectChromeHeight` 6 → 3 and `collectingChromeHeight` 9 → 6.

`filter.ts` keeps the matcher and replaces the enablement question with a showing one. No compositing layer is added, because there is nothing left to composite.

### Decisions

- **Decision:** Sub-dialogs are columns inside the root level's single frame, not panels stacked over it.
  - **Why:** The reader needs the path they walked, and stacking is what hides it: the list a choice was made from goes behind the panel that choice opened. Columns keep every list on screen, so the choices on the way in stay readable beside the one being made now, and there is nothing to composite because nothing overlaps.
  - **Alternatives considered:** Keeping the stack and drawing only the parent's active row above the child was rejected as a strictly worse column — it costs the same room and shows one row instead of a list. Transparent panels were rejected because the renderer lays out boxes and cannot compose a cell from two sources, which is exactly what killed the shadow.

- **Decision:** Enter opens an option that declares a sub-dialog rather than submitting it, with `expand: "tab"` on the root request as the escape hatch.
  - **Why:** An option marked `▸` promises somewhere to go, and the key that takes a plain option is the key a reader already presses; making them the same key means one key to learn rather than two, and an option that leads somewhere then has exactly one meaning. A caller whose expandable options are also choices in their own right needs Enter back, so the binding moves opening to Tab and leaves Enter submitting at every level.
  - **Alternatives considered:** Keeping Tab as the only trigger was rejected because it leaves the common case — drill in — on the key nobody reaches for first, and leaves Enter submitting a row whose marker says it leads somewhere. A per-option binding was rejected as configuration surface for a question the whole dialog should answer once; the setting is read from the root request alone for the same reason.

- **Decision:** Filtering is always live, and `filter` decides only whether the filter is on screen before anything has been typed.
  - **Why:** There is no second thing a printable character could sensibly mean at a list, so a setting that made typing do nothing was a setting that made a reader's first instinct fail silently. What is left for a caller to decide is presentational — whether the filter takes up an edge before it has been used — which is what the setting now says.
  - **Alternatives considered:** Keeping `boolean | "auto"` with the eight-option threshold was rejected: the threshold predicted when typing would be wanted, and the prediction is unnecessary once typing always works. Dropping the setting entirely was rejected because a caller offering a list built to be typed at wants the filter visible from the first frame.

- **Decision:** The filter and the `▲ N` / `▼ N` counts are set into the frame's own edges rather than drawn as rows.
  - **Why:** Chrome that comes and goes must not move the list, and a row that appears pushes every option row down by one — as the filter turns on, or as scrolling first hides something, which is exactly when the reader is watching the list. The panel is already spending two rows on its edges, and an edge has room to the right of a title.
  - **Alternatives considered:** Reserving the rows permanently was rejected because it takes three rows from every short terminal to keep three rows still. Drawing the counts inside the option band was rejected for the same movement, plus it makes a column's width depend on a count that changes as it scrolls.

- **Decision:** The room the counts take is held whether a count is showing or not.
  - **Why:** Otherwise the title's available width changes the moment the reader scrolls past the first hidden row, and a title that retruncates mid-scroll is the same restlessness the counts were moved out of the panel to stop.
  - **Alternatives considered:** Sizing the edges to what is on screen was rejected for that retruncation. Reserving a fixed width for any count was rejected because the reserve is cheap to derive exactly — the driven column's total hidden count is the largest either side can carry.

- **Decision:** Columns collapse from the left when the run exceeds the width, and collapsing stops at one column, which is truncated instead.
  - **Why:** The rightmost column is the one being driven and must always be on screen; the ones behind it hold decisions already made, so they are what a narrow terminal can afford to lose. The title says a `…` when something has gone, so it still names exactly the columns on screen. One column has to survive whatever the terminal is doing, and truncating it is what every other row of a dialog does when it runs out of columns.
  - **Alternatives considered:** Dropping from the right was rejected as dropping the column the reader is in. Horizontally scrolling the run was rejected as a second navigation model for a browser whose whole point is that the path is visible. Wrapping columns onto a second band was rejected because the band's height is the viewport's budget.

- **Decision:** Every column draws the same cursor bar — the inversion alone, with no dimming on the trail.
  - **Why:** Which column is being driven is already said by where it sits: it is the rightmost. Saying it a second time, by shading the bars behind it, adds a convention the reader has to learn in order to read something the layout already told them, and it makes the choices on the path look less real than they are.
  - **Alternatives considered:** Dimming the trail's bars was tried and rejected on exactly that reading. Marking the driven column in its own title was rejected because the title names the trail, and a marker inside it competes with the trail it is part of.

- **Decision:** The hint line tracks the mode the dialog is in — leftmost column or one opened over it, list or entry — and not the momentary availability of a key. So `Esc cancel` gives way to `←/Esc back` once a column is open, but `↑↓ move` and `Enter select` stay on the line when a filter has matched nothing and both are no-ops. The rule reaches the entry line too: an entry mounted over a column — a text leaf, or a field of an option chosen in an opened column — reads `Enter submit · Esc back`, while a standalone `input` and a field collected at the leftmost column keep `Enter submit · Esc cancel`. Which one applies is passed in by whoever mounts the entry, keyed for a collected field on the very condition the select's own Escape handler branches on, because an entry cannot see the stack it sits over and a line derived from a second condition would drift from the key.
  - **Why:** The two cases look alike and are not. A column is opened and closed deliberately, so a line that changes with it changes when the reader has just acted and is looking at the column they opened; naming `Esc cancel` there was a plain mislabel, because Escape backs out of a column exactly as the left arrow does and there is no key that cancels from a nested column at all. A filter, by contrast, changes on every keystroke: stripping `↑↓ move` and `Enter select` the moment nothing matched — and putting them back on the next Backspace — would reflow the hint under the reader while they type. That is the same restlessness the filter and the overflow counts were set into the frame's edges to stop, one axis over, and this change had already ruled the same way for `type to filter`, which is named whether or not the filter is on screen.
  - **Alternatives considered:** Naming `Esc cancel` alongside `← back` in a nested column was rejected: no key cancels outright from there, so it would promise something the dialog will not do. Adding a key that cancels the whole session from any column was rejected as a third meaning for Escape in one dialog when backing out to the leftmost column is one keypress per column and already visible in the title. Dropping the movement and selection phrases in the no-match state was rejected on the churn above; a test now pins them so a later change cannot quietly "helpfully" remove them.

- **Decision:** The [Viewport](../specs/dialogs/index.md#viewport)'s one-row floor is stated with the two conditions it holds under — the terminal affording the row, and something visible to fill it — and the active-option requirement is scoped to the frames that draw rows at all. Both were unconditional MUSTs that the code has never satisfied.
  - **Why:** [0020](./0020-add-select-filter-and-viewport.md) found the conflict, chose the no-clearing guarantee over both of the others, and recorded the choice as an open question rather than amending the rules it had decided against. That left the spec asserting two things the implementation deliberately does not do, and a spec that contradicts the code it governs stops being usable as the contract: a reader cannot tell which side is the defect. The manual already described the real behaviour, so the spec was the only place stating it wrongly, and this change was amending that section anyway.
  - **Alternatives considered:** Making the code honour the floor was rejected — it is the branch [0020](./0020-add-select-filter-and-viewport.md) already considered and declined, and it trades a row the reader never sees for a terminal wiped out from under them. Leaving the open question standing was rejected because it had already outlived the change that raised it and cost a review pass to rediscover.

### Non-Goals

- Shadows, offsets, stacked or overlapping panels, solid panel backgrounds, and any cell-level compositing. The renderer lays out boxes; nothing here asks it to blend two sources.
- Per-column overflow reporting. Only the driven column's hidden counts are set into the edges, so a column behind it whose list runs past the band reports nothing — see the open question below.
- A filter that stays on screen for the column it was used in once its text is cleared back to empty — see the open question below.
- A hint line per column, a title per column, or any second frame inside the browser.
- Horizontal scrolling of the column run, mouse or scroll-wheel input, and resizable or caller-sized columns.
- Configurable dividers, markers, glyphs, themes, or palettes; the glyph set stays fixed in the spec.
- Any change to matching, field collection order, values merging, validation, resolution, or cleanup semantics beyond the layout, the opening keys, and the filter setting.
- Multi-field forms, field validation, any new field type, and any dialog beyond `select` and `input`.

## Tasks

- [x] Column geometry
  - [x] Add `plugins/dialogs/columns.ts` owning the marker, the divider, the overflow glyphs, the no-match text, and the pure width, collapsing, stretching, and cell functions
  - [x] Measure a column against its whole visible list rather than the rows one frame draws, so scrolling does not resize it under the cursor bar
  - [x] Give the last column the room the title and the edges left spare, so its cursor bar spans the panel
  - [x] Add Bun tests for the widths, the divider arithmetic, collapsing from the left, stopping at one column, stretching, and the cells a short and a long list contribute to one band
  - [x] Verify 100% coverage and `bun run check`
- [x] One frame with chrome in its edges
  - [x] Make `Frame` draw its own edges instead of Ink's `borderStyle`, and take rows as styled segments so a row can mix chrome with content
  - [x] Set the filter into the bottom edge and the `▲ N` / `▼ N` counts into the top and bottom edges on their right, holding their room whether a count shows or not
  - [x] Drop `selectChromeHeight` to 3 and `collectingChromeHeight` to 6, and remove `stackedOffsetColumns`, `stackedShadowRows`, `stackedExtraRows`, and the `extraRows` parameter from `viewport.ts`
  - [x] Add Bun tests for the edge-set filter and counts, the held reserve, the dimmed chrome, and the row budget the new counts leave
  - [x] Verify 100% coverage and `bun run check`
- [x] The column browser
  - [x] Lay the select levels out as columns of one frame, left to right in the order opened, separated by a dimmed divider and sharing one band of rows
  - [x] Mark an option that declares a sub-dialog with `▸` on the right edge of its column, reserved for the whole column so the markers line up
  - [x] Title the frame with the trail of the columns on screen, joined with `›` and opened with `…` once columns have collapsed off the left
  - [x] Keep every column drawing the list it was left on with its bar on the choice that opened the next one, dressed at rest, with the bar identical in every column
  - [x] Cache the frozen columns' matching and measurement per level so the animation's timer does not re-match them
  - [x] Render a text-field sub-dialog as its own panel beneath the frame, as a collected field does
  - [x] Add Bun tests for the single frame, the divider, the shared band, the marker, the trail title, collapsing on a narrow terminal, and the identical bars
  - [x] Verify 100% coverage and `bun run check`
- [x] Opening, backing out, and the binding
  - [x] Open on Enter for an option that declares a sub-dialog and take one that declares none; open on the right arrow under either binding
  - [x] Add `expand: "enter" | "tab"` to the provider's local request type, read from the root request alone and applied to every column
  - [x] Back out on the left arrow, doing nothing at the leftmost column, and keep Escape closing the rightmost column and cancelling only at the leftmost
  - [x] Assemble the hint line from the phrases that apply, so it never names a key the row under the bar does not answer
  - [x] Let the entry's hint line name backing out where its Escape backs out — a text leaf, and a field collected in an opened column — and keep it naming cancelling for a standalone `input` and a field collected at the leftmost column
  - [x] Add Bun tests for opening and taking under both bindings, the arrows, backing out at the leftmost column, opening from a filtered list, and the hint on each kind of row and each kind of entry
  - [x] Verify 100% coverage and `bun run check`
- [x] The always-live filter
  - [x] Replace `filter: boolean | "auto"` and the eight-option threshold with `filter: "typed" | "always"` deciding visibility only
  - [x] Keep typing filtering at every level and whatever the list's length, with each column keeping its own text
  - [x] Add Bun tests for typing bringing the filter up, `"always"` showing it before a keystroke, and filtering inside a nested column
  - [x] Verify 100% coverage and `bun run check`
- [x] Spec, manual, demo, and indexes
  - [x] Amend [Dialogs](../specs/dialogs/) for the columns, the always-live filter, the edge-set chrome, and the viewport budget, and record this change's changelog rows
  - [x] State the viewport's one-row floor and its active-option rule with the conditions they hold under, and close [0020](./0020-add-select-filter-and-viewport.md)'s open question with the answer
  - [x] Remove the superseded cascading-sub-dialogs and sub-dialog-trigger-tab change documents together with every reference to them, and renumber this document into the first of the two freed numbers
  - [x] Document the column browser, the binding, the always-live filter, and the edge-set chrome in `docs/manual/plugins.md`
  - [x] Deepen the repo-root `demo` to a three-level tree with a scrolling column and both leaves, and add the Tab-binding scenario
  - [x] Verify 100% coverage and `bun run check`, then set this document's status to complete and sync `docs/index.yml` and `docs/index.md`

## Open Questions

- [ ] Only the driven column reports overflow, so a column behind it whose list runs past the band shows no count at all: the reader sees a list that stops without being told it was cut. The counts are set into the frame's two edges, which have room for one column's pair and no obvious place for a second, so reporting for every column needs somewhere to put the numbers before it needs a rule.
- [ ] A filter cleared back to empty hides again rather than staying on screen for the column it was used in, so the edge it occupied is handed back to the title mid-keystroke. Whether that is right depends on whether a reader who has emptied the filter has finished with it; it is the same question [Dialogs](../specs/dialogs/index.md#open-questions) already records, and real lists from a bundled consumer would answer it.

## References

- Specs: [Dialogs](../specs/dialogs/), [Plugin System](../specs/plugin-system/), [Architecture](../specs/architecture/)
- Related changes: [0021-restyle-dialogs-as-norton-commander](./0021-restyle-dialogs-as-norton-commander.md), [0020-add-select-filter-and-viewport](./0020-add-select-filter-and-viewport.md)
- Manual: [Plugins](../manual/plugins.md)
- External: [Ink](https://github.com/vadimdemedes/ink) — `Box` layout, `useInput` key report with `tab`, `leftArrow`, and `rightArrow`, `useWindowSize`; [Miller columns](https://en.wikipedia.org/wiki/Miller_columns) for the browser vocabulary; [Norton Commander](https://en.wikipedia.org/wiki/Norton_Commander) for the panel vocabulary
