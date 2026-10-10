# 0033: Upgrade to Ink 8 and React 19.3

## Summary

Upgrade tx's runtime to Ink 8.0.0 and React 19.3.0, with `@types/react` 19.3.0 and `react-devtools-core` 8.0.0 alongside them. tx injects its own React and Ink into every plugin, so this is a **breaking change for plugins** and ships as a major release. [Plugin System: Generic Context and Dependencies](../specs/plugin-system/index.md#generic-context-and-dependencies) gains the rule that makes that explicit, and [Dialogs: Text Input](../specs/dialogs/index.md#text-input) drops a workaround Ink 8 makes unnecessary.

**Spec:** [Plugin System](../specs/plugin-system/)
**Status:** complete
**Depends On:** 0003, 0017

## Motivation

tx pins Ink 7.1.1 and React 19.2.8. Ink 8 is the current major line; staying on Ink 7 means every later Ink fix and feature arrives only through another, larger upgrade later.

The upgrade is not internal to tx. `coreDependencies` in `src/plugins.ts` hands every plugin the host's own `react` and `ink` modules, and `@fx/tx/plugin` types them as `typeof import("react")` and `typeof import("ink")`. A plugin's components are rendered by the host's Ink, so whatever Ink 8 removes or changes, it removes or changes for every plugin at once. Nothing in the specs said so: the [Plugin System](../specs/plugin-system/) required plugins to use the injected instances, but did not say that changing those instances is a change to the contract plugins are written against.

Ink 8's breaking changes, as its release notes state them:

- Ink 8 requires React 19.3 or newer.
- `<Box>` `minWidth` and `maxWidth` accept numbers only.
- The `stdin`, `stdout`, and `stderr` passed to `render()`, and the streams `useStdin`, `useStdout`, and `useStderr` return, are typed as generic Node streams. TTY-only members such as `stdout.columns` are gone from those types; `useWindowSize` reports the terminal size.
- `useInput` no longer receives control sequences that map to no key — mouse reports, focus in and out, cursor-position reports, and similar terminal replies are discarded.
- Ink's development tools connect over the platform's native `WebSocket` instead of the `ws` package.

The last of these is invisible to plugins. The first four are not.

The input change also affects tx itself. The dialogs provider's text entry dropped any chunk shaped like a `CSI` body — `[25~` — because Ink 7 delivered unrecognized sequences to `useInput` with their escape stripped. Under Ink 8 such a sequence never reaches the handler, so the shape test can no longer catch anything it was written for; all it still does is swallow the same text when a user types or pastes it.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- The dialogs tests MUST show, through real Ink input handling on injected streams, that complete `CSI` and `SS3` sequences mapping to no key leave a text entry unchanged, and that text shaped like a sequence's payload appends.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Plugin System: Generic Context and Dependencies](../specs/plugin-system/index.md#generic-context-and-dependencies) and [Dialogs: Text Input](../specs/dialogs/index.md#text-input) own the behavior and are this change's acceptance criteria.

What implementing them requires of this change:

- **Exact pins.** `ink` 8.0.0, `react` 19.3.0, `@types/react` 19.3.0, and `react-devtools-core` 8.0.0, pinned exactly in `package.json` with the lockfile updated. `dependencies.versions` reports the new `react` and `ink` pins without code changes, because it reads them from `package.json`.
- **A major release.** The change lands as a conventional breaking commit, so Release Please cuts a new major version, and its commit carries a `BREAKING CHANGE:` footer listing the plugin-facing changes above.
- **The public contract stays put.** `CommandContext` keeps its `NodeJS.ReadStream` and `NodeJS.WriteStream` stream types. Ink 8 widening its own stream types narrows nothing tx hands a plugin.
- **No workaround Ink 8 makes dead.** The dialogs provider passes its stream adapters to `render()` without casting them to TTY streams, and text entry no longer tests input against a `CSI` shape.

## Design

### Approach

Bump the four dependencies together — Ink 8 declares `react` and `@types/react` `>=19.3.0` as peers, so they must move as a pair, and `react-devtools-core` moves to the major matching Ink's. Nothing in tx's own rendering uses an API Ink 8 removed: no component sets a string `minWidth` or `maxWidth`, and the grid reads the terminal width from the stream it prints to rather than from an Ink hook.

`plugins/dialogs/index.ts` gives Ink `PassThrough` and `Writable` adapters around the injected streams. Ink 7 typed `render()`'s streams as TTY streams, so the adapters were cast through `unknown`; Ink 8 types them as generic Node streams, which the adapters already are, so the casts go.

`plugins/dialogs/entry.ts` drops `unresolvedControlSequence`. Ink 8 discards every complete `CSI` or `SS3` sequence that maps to no key before any input handler runs, while `useInput` reports the ones that do with empty input. A string matching the old pattern can therefore reach the handler only as typed or pasted text, which the dialogs spec now requires to append.

### Decisions

- **Decision:** Treat a change to the injected React or Ink public API as a breaking change to the plugin contract, and say so in the [Plugin System](../specs/plugin-system/) spec.
  - **Why:** A plugin cannot opt out of the host's instances — the spec requires it to use them — so it has no way to stay on the old API while tx moves. Calling the upgrade anything less than breaking would let Release Please publish it as a minor version that plugins written for the previous one fail under.
  - **Alternatives considered:** Injecting both the old and the new Ink side by side was rejected: Ink 8 requires a newer React than Ink 7 was released against, so it would mean two Reacts as well, and dialogs and grids rendered for a plugin would come from whichever pair it chose — a second contract to keep working for a transition no plugin asked for.

- **Decision:** Remove the text entry's control-sequence shape test rather than keep it as a second line of defence.
  - **Why:** Under Ink 8 it cannot fire for a terminal sequence; its only remaining effect is to drop literal text a user typed. Keeping it would preserve a known false positive to guard against nothing.
  - **Alternatives considered:** Extending it to `SS3`, as was once considered and rejected, was rejected again for the same reason — Ink 8 already drops unresolved `SS3` sequences, so it would only swallow more typed text.

- **Decision:** Keep `require("node:stream")` in `plugins/dialogs/index.ts`.
  - **Why:** The note in `REVIEW.md` is about Bun's coverage, not Ink. A static `import { PassThrough, Writable } from "node:stream"` under Ink 8 still leaves the file's function coverage at 97.44%, so the reason it records still holds.

### Non-Goals

- Changing `CommandContext` or any other part of `@fx/tx/plugin` beyond what the injected libraries' own types change.
- Fixing, testing against, or notifying any plugin outside this repository.
- Using Ink 8's new features — `usePaste`, `useAnimation`, `useWindowSize`, or the kitty keyboard protocol — in the bundled plugins.
- Handling a control sequence that arrives incomplete and is flushed as text after Ink's escape timeout; its payload may still append, exactly as under Ink 7.
- Any change to `CHANGELOG.md`, which Release Please owns.

## Tasks

- [x] Pin `ink` 8.0.0, `react` 19.3.0, `@types/react` 19.3.0, and `react-devtools-core` 8.0.0 and update `bun.lock`
- [x] Pass the dialogs stream adapters to `render()` without casts
- [x] Remove the text entry's control-sequence shape test
  - [x] Cover unresolved `CSI` and `SS3` sequences leaving the value unchanged under real Ink input handling
  - [x] Cover text shaped like a sequence's payload appending
- [x] Specify the breaking-change rule in [Plugin System](../specs/plugin-system/) and the text input rule in [Dialogs](../specs/dialogs/), with changelog rows
- [x] Amend the wording the change makes wrong
  - [x] `docs/manual/plugins.md`: the text input paragraph, and a note for plugin authors listing Ink 8's breaking changes
  - [x] `REVIEW.md`: the text input checklist entry
- [x] Verify 100% coverage, `bun run check`, and the built executable

## References

- Spec: [Plugin System](../specs/plugin-system/), [Dialogs](../specs/dialogs/)
- Related changes: [0003-externalize-marketplace-plugin](./0003-externalize-marketplace-plugin.md), [0017-add-dialog-text-input-and-composition](./0017-add-dialog-text-input-and-composition.md)
- External: [Ink releases](https://github.com/vadimdemedes/ink/releases), [React versions](https://react.dev/versions)
