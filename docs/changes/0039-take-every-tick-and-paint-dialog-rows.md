# 0039: Take Every Tick and Paint Dialog Rows

## Summary

Three follow-ups from the first host that embedded `Select`: take the ticks of every column opened during a dialog rather than of the open columns alone, answer a carriage return that arrives inside one input event as the Enter it was, and paint every row of a dialog — its hint line included — to its widest row, so a host drawing a component over content of its own sees none of that content inside it.

**Spec:** [Dialogs](../specs/dialogs/)
**Status:** complete
**Depends On:** 0036, 0037

## Motivation

A plugin embedding `Select` as a filter dialog — a root column listing kinds of thing, a multiple column of the things of each kind beneath it — finds three things short of what it needs:

1. Ticks count only in the columns open at completion. Backing out of a column keeps its ticks for re-opening but drops them from the result, so one pass can filter by one kind and not by two.
2. A Space and an Enter typed faster than the terminal is read arrive as one input event. Ink separates escape sequences, Backspace, and Ctrl-C out of a chunk and nothing else, so the select receives the two-character text ` \r`: not the one-space keystroke that ticks, not the Enter that takes, and a space in the filter besides. It reproduces with a key burst; it is plausible over a slow link and unlikely typed on a local terminal.
3. The hint line is wider than the frame above it. A host drawing the dialog over a table sees table text through the cells beside the frame and after the hint, and works around it with a wrapper of a fixed width and a background colour Ink happens to fill with plain spaces because it does not recognise the colour's name.

Each is small, and each belongs in `tx` rather than in a workaround every host repeats.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions)). CI enforces these as merge gates:

- Tests MUST use Bun's test runner, and new observable behavior MUST have automated tests.
- Tests MUST maintain 100% statement, function, and line coverage across production source files; coverage exclusions MUST stay limited to generated or non-executable files and MUST be documented in configuration.
- Committed tests MUST NOT contain focused or skipped cases without a documented reason.
- Biome formatting and lint, and TypeScript, MUST pass with no errors; `bun run check` MUST pass.
- The painted rows MUST be tested as a host sees them — a component drawn over rows of the host's own text in a session rendered through the injected `ink.render`, as [Change 0036](./0036-add-embeddable-dialog-components.md) established — and the function forms' existing frame assertions MUST keep passing unchanged, which is the evidence a standalone dialog draws what it drew.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Dialogs: Multi-Select](../specs/dialogs/index.md#multi-select) owns which ticks `selected` holds and their order, [Dialogs: Selection](../specs/dialogs/index.md#selection) and [Dialogs: Text Input](../specs/dialogs/index.md#text-input) own how an input event carrying several keystrokes is answered, and [Dialogs: Presentation](../specs/dialogs/index.md#presentation) and [Dialogs: Embeddable Components](../specs/dialogs/index.md#embeddable-components) own the painted rows, with the scenarios that are this change's acceptance criteria. None of it is restated here. What implementing them requires of this change:

- No contract changes: `plugins/dialogs/contract.ts` is untouched, and `SelectResult.selected` keeps its type and its fallback.
- The order of `selected` across columns follows the request — a column before the columns opened from its options, siblings in supplied option order — which is the order of the paths the ticks are already keyed by.
- The existing test asserting that a chunk `ab`, carriage return, `cd` appends `abcd` to an input encodes the behavior this change replaces, and is rewritten to the new rule; it is the one assertion that changes.
- Nothing under `src/` or in the grid plugin changes: `SelectGrid` renders `Select` and inherits all three.

## Design

### Approach

1. **Every opened column's ticks.** `selectedValues` in `plugins/dialogs/select.ts` reads the tick map rather than the level stack, sorts its paths in request order, and resolves each path back to its column's options through the request. A column never opened has no entry and contributes nothing; its pre-ticks seed it only when it opens, as before.
2. **Keystrokes from one event.** A `keystrokes(input, key)` helper in `plugins/dialogs/entry.ts` cuts an event's text at carriage returns into the text before, an Enter key report, and whatever follows. The select's key child and the entry's own handler answer each piece in turn through the handler they already have, so text ahead of an Enter is filtered or appended first, the Enter is answered against that state, and anything after it meets a dialog that has finished — the one-shot guard already covers that. Only the carriage return is cut: it is what the Enter key sends in raw mode, and no other control character has a key meaning inside a dialog.
3. **Painted rows.** `paintedWidth` in `plugins/dialogs/frame.ts` is the widest of the panel, the hint line with its leading column, and a floor the caller passes, never past the terminal. The frame paints every row to it: blank cells after the closing border on each panel row, and the hint line as its leading blank, the hint, and blank cells to the painted width, in one `Text` per row rather than the margin and box the hint sat in. The select computes the width once per render — its frame, its hint while it draws one, and the entry it is about to draw beneath, sized by that entry's message and hint — and passes it to its frame and to the entry as the floor each paints to.

### Decisions

- **Decision**: ticks are taken from every column opened during the dialog, pre-ticks of a column never opened excluded.
  - **Why**: the branch a reader backed out of is one they ticked in on purpose, and taking it is what makes one dialog answer for several kinds of thing at once. A pre-tick is the state a column opens with, and a column that never opened never showed the reader anything to confirm or clear.
  - **Alternatives considered**: walking the whole request for pre-ticks at completion, rejected because the reader never saw them and a request may be cyclic; keeping open columns only, which this change exists to replace.

- **Decision**: the order across columns is the request's, not the order the reader opened them in.
  - **Why**: a caller reading `selected` knows its request and not the reader's route through it, so request order is the one order it can predict.
  - **Alternatives considered**: opening order, which depends on the route; completion-column-first, which is a route too.

- **Decision**: a carriage return inside a chunk is Enter everywhere a dialog takes keys, the standalone `input` included.
  - **Why**: one rule for every dialog is what keeps a field collected under a select and a standalone input answering the same keys the same way, and it is the rule every line editor follows for a pasted newline. The alternative was keeping an input that silently dropped the Enter after text typed quickly.
  - **Alternatives considered**: cutting only a trailing return, which answers the Space-and-Enter case and still drops an Enter followed by more typing; cutting only in the select, which leaves `input` with the bug.

- **Decision**: every row is painted to one width, with blank unstyled cells, rather than the component taking an option to clear its background.
  - **Why**: a dialog is a block of rows, and painting the block is what a host needs whatever it draws beneath; an option would be one more thing to learn and a colour to pick, when the theme owns appearance and the cells beyond the frame have none. On a terminal of its own the renderer drops the trailing blanks, so nothing standalone changes.
  - **Alternatives considered**: widening the frame to the hint line, which changes how every standalone select looks; a background colour, which chooses an appearance the theme should own.

### Non-Goals

- Taking pre-ticks of columns the reader never opened.
- Any control character other than the carriage return gaining a key meaning inside a chunk.
- Widening a frame to its hint line, or a background colour.
- Any change to the published contracts, to `src/`, or to the grid plugin.

## Tasks

- [x] Take every tick, answer a chunked Enter, and paint every row
  - [x] `plugins/dialogs/select.ts`: `selected` from every opened column in request order; the key child answering each keystroke of an event; the painted width passed to the frame and the entry
  - [x] `plugins/dialogs/entry.ts`: `keystrokes`, `entryHint`, and the `box` floor the entry paints to
  - [x] `plugins/dialogs/frame.ts`: `paintedWidth` and every row painted to it, the hint line included
  - [x] `test/dialogs-multi-select.test.ts`, `test/dialogs-plugin.test.ts`, `test/dialogs-embedded.test.ts`, `test/dialogs-keystrokes.test.ts`: every new scenario, the rewritten chunk assertion, and a host drawing `Select` and `Input` over its own rows
  - [x] [Dialogs](../specs/dialogs/) spec and the [plugin guide](../manual/plugins.md): the amended rules, the resolved open question, and a changelog row; this change `complete` in `docs/index.yml` and `docs/index.md`

## References

- Spec: [Dialogs: Multi-Select](../specs/dialogs/index.md#multi-select), [Dialogs: Selection](../specs/dialogs/index.md#selection), [Dialogs: Text Input](../specs/dialogs/index.md#text-input), [Dialogs: Presentation](../specs/dialogs/index.md#presentation), [Dialogs: Embeddable Components](../specs/dialogs/index.md#embeddable-components)
- Related changes: [0036-add-embeddable-dialog-components](./0036-add-embeddable-dialog-components.md), [0037-add-multi-select](./0037-add-multi-select.md)
