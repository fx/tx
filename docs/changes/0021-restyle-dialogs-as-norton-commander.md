# 0021: Restyle Dialogs as Norton Commander

## Summary

Give the bundled dialogs a Norton Commander look in greyscale: framed panels with the message set into the frame as a title, an inverted full-width cursor bar, dimmed chrome and key hints, width-aware truncation, and three bounded animations — a blinking caret, a pulsing overflow indicator, and a flash on confirmation — none of which may slow a keystroke. [Dialogs](../specs/dialogs/) owns the observable behavior.

**Specs:** [Dialogs](../specs/dialogs/)
**Status:** draft
**Depends On:** [0020](./0020-add-select-filter-and-viewport.md)

## Motivation

The dialogs render unstyled text: a `>` marker, a message line, a bare value. They work, and they look like a debugging aid. Every `tx` interaction that asks the user something goes through them, so their look is the tool's look.

The renderer already draws borders, colors, inverse video, truncation, and timed animation; the plugin uses none of it. Norton Commander is the target because it solved exactly this problem — a fast, keyboard-driven interface that reads clearly in a character grid — and its vocabulary needs no color to work, which is what lets the palette stay greyscale and identical on every theme. Speed stays the first constraint: the look is chrome around the same immediate interaction, and every animation is bounded so it can never be the reason a keystroke waits.

This change follows [0020](./0020-add-select-filter-and-viewport.md) so that every row it styles already exists.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable framing, titling, shading, truncation, hint, caret, flash, pulse, timer-quiescence, and timer-teardown behavior MUST have automated tests.
- Dialog tests MUST use injected streams or controlled terminal doubles and MUST NOT read from or write to the process-global streams.
- `test/plugin-boundary.test.ts` MUST keep passing for the bundled plugin graph.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Dialogs](../specs/dialogs/) owns [presentation](../specs/dialogs/index.md#presentation): frames and titles, the greyscale palette, the cursor bar, the key hints, truncation, the caret, the confirmation flash, the indicator pulse, the no-delay and quiescence rules, and timer teardown before settlement. Its scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **No new dependency.** Borders, dimming, inversion, truncation, window size, and animation come from the injected renderer's own component props and hooks. The plugin MUST NOT import a color, box, or width library of its own; `REVIEW.md` already forbids separate React and Ink runtime imports, and the transitive packages the renderer depends on are not the plugin's to import.
- **Validation still precedes rendering.** Every pre-render rejection — empty options, invalid fields, non-interactive streams — happens before any frame is drawn, so the existing tests asserting an empty error stream on rejection keep passing unmodified.
- **The cleanup contract absorbs the timers.** Animation timers are owned by the render session and are stopped by the existing unmount path, so the settle-after-cleanup guarantee and its retry behavior are unchanged; the confirmation flash is the one place settlement is deliberately deferred, and it is bounded.
- **Tests assert on plain text, and styling is forced on.** Rendered output now carries escape sequences. The dialog tests gain a helper that strips them before matching and a helper that returns the text of the inverted row, and every existing assertion on `> label` markers is rewritten against the inverted row; a test that today passes because a marker is absent is rewritten to assert which row is inverted instead, so it cannot pass vacuously. The renderer's styling library decides at load time whether standard output is a terminal and emits no sequences under a piped `bun test`, so the test run MUST force styling on before any module loads — a Bun test preload setting `FORCE_COLOR=1` — or the inverted-row helper and both shading tests are no-ops that fail.
- **Animation intervals are constants, and the flash settles on elapsed time.** The caret and pulse interval and the flash duration are single named constants, so tests wait against the same numbers the implementation uses and the spec's bounds are checked in one place. The flash MUST settle when elapsed time reaches its duration rather than on a particular frame number: the renderer's animation hook derives its frame from elapsed time and drops ticks inside its render throttle, so a frame-equality check can be skipped and would leave the dialog waiting forever with input ignored.
- **The viewport's chrome height is updated.** [0020](./0020-add-select-filter-and-viewport.md) leaves the number of non-option rows as one constant; the frame edges and hint line change it, and the viewport tests are re-run against the new value.
- **The manual follows the implementation.** `docs/manual/plugins.md` gains a short paragraph on the look and the animations in the PR that ships them, including that a dialog with nothing animated writes nothing while idle.

#### Scenario: Existing marker assertions are migrated

- **GIVEN** the dialog tests that match `> Alpha`, `> Two`, and the absence of `> Known`
- **WHEN** this change lands
- **THEN** each is replaced by an assertion through the inverted-row helper that fails against the old output and passes against the new

## Design

### Approach

A frame module under `plugins/dialogs/` renders one framed panel: a bordered box (`double` for select, `single` for input and fields) whose title is a text element absolutely positioned over the top edge, one column in, padded with a space on each side so it reads as set into the border. Frame edges use the renderer's dim-border prop; the title, hint line, overflow indicators, and filter prompt use the dim text prop; the active option is a full-inner-width text with the inverse prop, padded to the inner width so the bar spans it. No color name is ever passed: default foreground, dim, and inverse are the entire palette.

The panel's width is the widest of the title and its content, plus padding, capped at the terminal width from the renderer's window-size hook (which reads the injected output adapter's `columns` and re-renders on the forwarded `resize` event, both already in place). Labels and the title use end truncation with the renderer's ellipsis; the filter text and an entry value use start truncation so their tail and the caret stay visible.

Animation is one subscription per dialog, not one per element: the dialog view calls the renderer's animation hook once, with the shared interval constant and `isActive` true exactly when a caret, an overflow indicator, or a flash is on screen, and passes the resulting frame down. Each hook call keeps its own start time, so two subscribers mounted at different moments drift out of phase and wake the shared timer twice per interval, each wake a full-frame rewrite; a single subscription keeps the caret and the indicator on one phase and halves the idle wakes. The caret shows on even frames and hides on odd; the indicator is dim on even frames and normal on odd; a select with neither, and no flash in progress, passes `isActive: false`, so no timer runs and nothing is written while it idles. The confirmation flash is a one-shot: Enter on a plain option records the outcome, resets the hook, and marks the flash active; the bar inverts on even frames and un-inverts on odd using a flash interval no shorter than the renderer's render throttle (about 34 ms, so 60 ms), input is ignored while the outcome is recorded, and the outcome settles as soon as the hook's elapsed time reaches the flash duration (180 ms), which keeps it under the 250 ms budget the spec sets even with a late tick. Unmount stops the shared timer, so the existing cleanup path needs no new step.

Tests strip escape sequences with the runtime's built-in stripper before matching text, so they assert on what the user reads, and identify the active option through a helper that returns the row wrapped in the inverse sequence. Dimming is asserted by the presence of its sequence around the expected text in the raw output, in the one test that exists to prove it, and nowhere else. Both depend on the preload that forces styling on.

### Decisions

- **Decision:** Greyscale only — default foreground, dim, and inverse.
  - **Why:** It renders identically on light and dark themes, on a 16-color terminal and a true-color one, and it needs no palette configuration, which is a surface the spec keeps out of scope. Norton Commander's structure — frames, a title, a cursor bar, a key bar — is what makes it recognizable; the blue is incidental and fights half the terminals in use.
  - **Alternatives considered:** The classic blue and cyan panel was rejected for theme conflicts and for needing a background fill that paints over the terminal. A single accent color was rejected because choosing it is a theme decision, and one accent invites a second.

- **Decision:** The title is set into the top edge of the frame rather than rendered as a line above or inside it.
  - **Why:** It is the single most recognizable Norton Commander trait, it saves a row, and the renderer's absolute positioning makes it one overlaid text element rather than a hand-drawn border.
  - **Alternatives considered:** Drawing the border by hand to embed the title was rejected because it re-implements what the renderer does, width calculation included. A title row inside the frame was rejected as a row the viewport arithmetic must then give up.

- **Decision:** Three animations only — caret blink, indicator pulse, confirmation flash — each bounded and each mounted only when its element is on screen.
  - **Why:** These are the animations the user asked for, and each has a job: the caret says "type here", the pulse says "there is more", the flash confirms the choice was taken. Mounting the animated element only when needed is what lets the quiescence rule be a consequence of structure rather than a flag.
  - **Alternatives considered:** A reveal animation on open was rejected because it delays the first usable frame, which is the one that matters most. Continuous ambient motion was rejected as noise that fights the speed constraint.

- **Decision:** The flash defers settlement by at most 250 ms and ignores input meanwhile.
  - **Why:** A flash that settles immediately is not visible; one that runs long is a delay the user feels. Ignoring input during the flash keeps the committed outcome the outcome: a keystroke after Enter must not change what was chosen.
  - **Alternatives considered:** Flashing after settlement was rejected because the renderer is unmounted by then. Cancelling during the flash was rejected because the choice is already made.

- **Decision:** Only the widths the renderer provides — end and start truncation with its ellipsis — and no wrapping.
  - **Why:** A wrapped label changes the row count under the viewport arithmetic and breaks the cursor bar's one-row shape. Start truncation for entered text and filter text keeps the caret and the newest characters in view, which is where the user is looking.
  - **Alternatives considered:** Horizontal scrolling of the entered text was rejected as caret-movement work the spec keeps out of scope.

- **Decision:** Tests strip escape sequences and assert on text, locate the active option through an inverted-row helper, and force styling on through a test preload.
  - **Why:** Every existing assertion is about what the user reads, and stripping keeps it that way while styling changes underneath. The inverted row is the only way to tell which option is active once the `>` marker is gone, so one helper owns that knowledge rather than every test. Forcing styling on is unavoidable: the styling library reads the terminal once at load, before any test runs, and a piped test run would otherwise never see a sequence.
  - **Alternatives considered:** Snapshot tests of raw frames were rejected as brittle against any spacing change and unreadable in review. Setting the environment variable inside the test file was rejected because module imports are hoisted above it and the styling level is already fixed by then. Skipping shading tests was rejected because the shading is observable behavior.

### Non-Goals

- Any change to matching, navigation, the viewport's rules, results, cancellation, or cleanup semantics; this change is presentation only.
- A configurable theme, palette, accent color, or any color hue.
- Match highlighting within labels.
- A reduced-motion preference; the spec records it as an open question.
- Mouse input, scroll-wheel input, or clickable hints.
- Screen-reader or accessibility policy beyond what the renderer does unprompted.
- A confirm dialog, progress dialog, or any dialog beyond `select` and `input`.
- Styling anything outside the dialogs plugin.

## Tasks

- [ ] Frame, title, palette, and layout
  - [ ] Add a frame module under `plugins/dialogs/` rendering a bordered panel with the title set into the top edge, dimmed chrome, and greyscale-only styling, sized to content and capped at the terminal width
  - [ ] Render `select` in a double-line frame with the inverted full-width cursor bar, the dimmed filter prompt and overflow indicators, and the dimmed key hint line beneath the frame that names the filter only when it is enabled
  - [ ] Render `input` and each collected field in a single-line frame with the caret after the value
  - [ ] Truncate labels and filter text at the end and entered values at the start, never wrapping
  - [ ] Update the viewport chrome-height constant from [0020](./0020-add-select-filter-and-viewport.md) and re-run its tests
  - [ ] Add a Bun test preload that sets `FORCE_COLOR=1` before any module loads, an escape-stripping helper and an inverted-row helper to the dialog tests, migrate every marker assertion to the inverted-row helper so it fails against the old output, and add tests for the frame and title, the double and single frames, the hint lines for select with and without the filter and for input, truncation at forty columns for labels and titles, start truncation for entered text and filter text, width following resize, dimming in one dedicated raw-output test, and unchanged empty output on every pre-render rejection
  - [ ] Document the look in `docs/manual/plugins.md`
  - [ ] Verify 100% coverage and `bun run check`

- [ ] Animations
  - [ ] Add the shared interval, flash interval, and flash-duration constants and the single per-dialog animation subscription, active only while a caret, an indicator, or a flash is on screen, with the caret blinking on its frame parity wherever text entry or the filter is on screen
  - [ ] Pulse the overflow indicator between dim and normal on the same frame parity, only while rows are hidden
  - [ ] Flash the cursor bar on a plain-option Enter, ignore every key including Escape and Ctrl-C during the flash, and settle on elapsed time within the 250 ms budget
  - [ ] Add Bun tests for the caret toggling, a keystroke reflected in the next render during the hidden phase, the pulse present only with hidden rows, the flash settling within budget with Escape ignored, a static select writing nothing while idle, and no timer outliving unmount on completion, cancellation, and failure
  - [ ] Document the animations and idle quiescence in `docs/manual/plugins.md`
  - [ ] Verify 100% coverage and `bun run check`, then set this document's status to complete and sync `docs/index.yml` and `docs/index.md`

## Open Questions

- [ ] Whether a reduced-motion preference should disable the three animations — the spec leaves it open; an environment variable read once at dialog start would be the natural shape, and nothing here forecloses it.
- [ ] Whether the hint line should be omitted below a terminal height at which it costs an option row — the viewport already has a floor of one row; this is a polish question for narrow terminals.

## References

- Specs: [Dialogs](../specs/dialogs/), [Plugin System](../specs/plugin-system/), [Architecture](../specs/architecture/)
- Related changes: [0020-add-select-filter-and-viewport](./0020-add-select-filter-and-viewport.md), [0017-add-dialog-text-input-and-composition](./0017-add-dialog-text-input-and-composition.md)
- Manual: [Plugins](../manual/plugins.md)
- External: [Ink](https://github.com/vadimdemedes/ink) — `Box` border and `Text` style props, `useAnimation`, `useWindowSize`; [Norton Commander](https://en.wikipedia.org/wiki/Norton_Commander) for the visual vocabulary
