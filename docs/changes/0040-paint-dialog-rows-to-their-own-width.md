# 0040: Paint Dialog Rows to Their Own Width

## Summary

Paint each row of a dialog only to its own width — a frame row to its closing border, the hint line from its leading column to its last character, an entry under a select to its own frame and hint line — rather than every row to the widest of them, so a host drawing a component over content of its own sees that content beside a frame narrower than its hint line instead of a blank block.

**Spec:** [Dialogs](../specs/dialogs/)
**Status:** complete
**Depends On:** 0039

## Motivation

[Change 0039](./0039-take-every-tick-and-paint-dialog-rows.md) paints every row of a dialog to its widest row, so a host drawing a component over content of its own sees none of that content inside the component's rows. Where the hint line is wider than the frame — every select with a short message and short labels — that pads each frame row with blank cells out to the hint's width. A host drawing such a component over content of its own sees a blank block beside the frame where its content used to be, covering cells the dialog draws nothing in. The same happens under a select collecting a field: the narrower of the select's frame and the entry beneath it is padded out to the wider one.

What a host needs is the opposite boundary: its content hidden under the cells the component draws — the frame and the hint line — and shown everywhere else. The hint line covering the cells under it is the part of 0039 that serves that; padding the frame rows out to the hint's width is not.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions)). CI enforces these as merge gates:

- Tests MUST use Bun's test runner, and new observable behavior MUST have automated tests.
- Tests MUST maintain 100% statement, function, and line coverage across production source files; coverage exclusions MUST stay limited to generated or non-executable files and MUST be documented in configuration.
- Committed tests MUST NOT contain focused or skipped cases without a documented reason.
- Biome formatting and lint, and TypeScript, MUST pass with no errors; `bun run check` MUST pass.
- The painted rows MUST be tested as a host sees them — a component drawn over rows of the host's own text in a session rendered through the injected `ink.render`, as [Change 0036](./0036-add-embeddable-dialog-components.md) established. The host-drawn assertions 0039 added encode the widest-row painting this change replaces, and are rewritten to the new rule: a frame narrower than its hint line and a frame wider than it, and an entry under a select both wider and narrower than the select's frame. The function forms' existing frame assertions MUST keep passing unchanged, which is the evidence a standalone dialog draws what it drew.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Dialogs: Presentation](../specs/dialogs/index.md#presentation) owns how far each row is painted, and [Dialogs: Embeddable Components](../specs/dialogs/index.md#embeddable-components) owns where a host's content is hidden and where it shows through, with the scenarios that are this change's acceptance criteria. None of it is restated here. What implementing them requires of this change:

- No contract changes: `plugins/dialogs/contract.ts` is untouched.
- Nothing under `src/` or in the grid plugin changes: `SelectGrid` renders `Select` and inherits the rule.
- The hint line's wording and width, the width a dialog is laid out in, and the key handling 0039 added are unchanged.

## Design

### Approach

1. **The laid-out width.** `paintedWidth` in `plugins/dialogs/frame.ts` becomes `laidOutWidth`: the wider of the panel and the hint line with its leading column, never past the terminal, with no floor. It is the envelope a dialog is laid out in — the width of the box holding its rows and the width the hint line is cut to so it never wraps — and no longer a width any row is padded to.
2. **Each row its own width.** The frame stops appending blank cells after the closing border of each panel row and after the hint, so a frame row ends at its border and the hint line at its last character. The hint line keeps its painted leading column, so it starts at the frame's left edge like the rows above it.
3. **No floor across panels.** The select stops measuring the entry it is about to draw and passing a shared width to its frame and to the entry; `entryHint` and the `box` prop on the frame and the entry, which existed only for that, are removed.

### Decisions

- **Decision**: every row is painted to its own width — a frame row to its closing border, the hint line to its last character.
  - **Why**: the cells a dialog draws are the ones a host's content should be hidden under; a blank cell the dialog draws nothing in hides the host's content for no reason, and reads as a hole in the host's own layout.
  - **Alternatives considered**: widest-row painting, which is what 0039 did and what this change replaces, because it leaves a blank block beside a frame narrower than its hint line; one block width shared by the whole dialog with the cells beyond each row painted in a background, which is widest-row painting with an appearance added when the theme, not the frame, owns appearance.

- **Decision**: an entry under a select is painted to its own frame and hint line, neither widening the select's rows nor widened by them.
  - **Why**: the two are separate panels, each with its own border; the same rule that ends a frame row at its border ends each of theirs.

- **Decision**: the hint line's leading column stays painted.
  - **Why**: it lines the hint up under the frame's left edge, and a host's content showing through in that one column would read as a stray character at the start of the hint.
  - **Alternatives considered**: an unpainted leading column, which is what the hint line had before 0039, because it leaves one column of host content showing at the start of the hint.

### Non-Goals

- Changing the hint line's wording or its width.
- Changing the width a dialog is laid out in, or the column widths inside it.
- A background option, or any appearance for cells a dialog does not draw.
- Any change to the published contracts, to `src/`, or to the grid plugin.

## Tasks

- [x] Paint each dialog row to its own width
  - [x] `plugins/dialogs/frame.ts`: `paintedWidth` replaced by `laidOutWidth` with no floor; no blank cells after a panel row's closing border or after the hint; the `box` prop removed
  - [x] `plugins/dialogs/entry.ts`: `entryHint` and the `box` prop removed
  - [x] `plugins/dialogs/select.ts`: the entry no longer measured ahead of rendering, and no shared width passed to the frame or the entry
  - [x] `test/dialogs-keystrokes.test.ts`, `test/dialogs-embedded.test.ts`: the laid-out width, and a host drawing `Select` and `Input` over its own rows, a select collecting a field included, rewritten to the new rule
  - [x] [Dialogs](../specs/dialogs/) spec and the [plugin guide](../manual/plugins.md): the amended rules, the rewritten and added scenarios, and a changelog row; this change `complete` in `docs/index.yml` and `docs/index.md`

## References

- Spec: [Dialogs: Presentation](../specs/dialogs/index.md#presentation), [Dialogs: Embeddable Components](../specs/dialogs/index.md#embeddable-components)
- Related changes: [0036-add-embeddable-dialog-components](./0036-add-embeddable-dialog-components.md), [0039-take-every-tick-and-paint-dialog-rows](./0039-take-every-tick-and-paint-dialog-rows.md)
