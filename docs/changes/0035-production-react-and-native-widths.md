# 0035: Production React and Native Text Widths

## Summary

Build the executables with `NODE_ENV` set to `production`, so tx — and every plugin rendering with the React tx injects — runs React's production build, and rewrite `string-width` as it is bundled so Ink measures text with Bun's native string width. Together they keep a terminal UI that redraws often (a streaming chat) responsive on Bun.

**Spec:** [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** 0033

## Motivation

Since tx injects its React and Ink into every plugin, their speed is every plugin's speed, and a plugin cannot fix either from its side.

**React runs its development build.** React, `react-reconciler`, and `scheduler` choose their build from `process.env.NODE_ENV`, and `Bun.build` inlines it as `"development"` unless told otherwise. `build.ts` sets no value, so the released executable embeds React's development build: its warning texts are in the binary, its error decoder link is not. The development build validates and freezes every element and keeps extra bookkeeping on every render — several times slower for a UI that re-renders many times a second.

**Ink's width measurement is pathologically slow on Bun.** Ink measures text with `string-width` 8.3.0 — every visible row on every frame (`Output` and its width cache are rebuilt per frame), and every changed line again in incremental rendering. For each non-ASCII grapheme, `string-width` tests a `v`-flag `\p{RGI_Emoji}` regular expression, which Bun's engine runs about a thousand times slower than `Bun.stringWidth` (measured: 2000 rows of box-drawing text take 5.8 s with the module as published, a few milliseconds natively). A screen of box-drawing borders costs tens of milliseconds per frame. tx's own code already measures with `Bun.stringWidth`; only Ink and its helpers (`widest-line`, `wrap-ansi`, `cli-truncate`) do not.

Measured with a chat plugin streaming an answer at a model's pace in a 200×60 tmux pane, the delay between a keypress and its echo fell from about 95 ms to about 40 ms median with both changes.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- The standalone build test MUST show that the executable carries React's production build and none of its development warnings.
- A test MUST bundle `string-width` through the build's rewrite and show that it agrees with `Bun.stringWidth` for the options Ink uses, keeps its own rules when ambiguous characters count as wide, and measures a screen of box-drawing rows within a bound the unrewritten module exceeds by an order of magnitude; and that the rewrite refuses a source whose shape it does not recognise.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Architecture: Runtime and Distribution](../specs/architecture/index.md#runtime-and-distribution) owns the behavior and is this change's acceptance criteria. What implementing it requires of this change:

- `build.ts` defines `process.env.NODE_ENV` as `"production"` for both executables.
- A bundler plugin (`build-plugins.ts`, used by `build.ts`) rewrites `string-width` as it is bundled to return `Bun.stringWidth` when ambiguous-width characters count as narrow (the default, and the only mode Ink and its helpers use). The module's own code still runs for `ambiguousIsNarrow: false`, where the two disagree (`é` is 2 cells in that mode for `string-width`, 1 for Bun). The rewrite throws, failing the build, when the source no longer has the shape it relies on.

## Design

### Approach

The `define` changes only the inlined value of `process.env.NODE_ENV` in the executables. The existing `disable-ink-development-mode` plugin keeps handling Ink's own `DEV` switch; the two are independent.

The rewrite follows the existing `disable-ink-development-mode` plugin: it changes the dependency only where it is bundled into the executables, which is where every consumer in the graph (`ink`, `widest-line`, `wrap-ansi`, `cli-truncate`, all on `string-width` ^8) resolves to one module. A Bun `patchedDependencies` patch was rejected: Bun reads that field from the published `package.json` too, so installing `@fx/tx` as a dependency — which plugin authors do for its types — fails on the missing patch file. Running tx from source keeps the unmodified module; the requirement is about the executables.

### Non-Goals

- **Plugin bundles.** The marketplace loader also bundles plugins with `Bun.build`, which inlines `NODE_ENV` as `"development"` there too. A plugin that renders uses the injected React, which this change fixes; changing what a plugin's own code sees for `NODE_ENV` is a separate decision.
- Replacing Ink's measuring or caching it across frames.

## Tasks

- [x] Define `NODE_ENV=production` in the production build; test the executable carries React's production build
- [x] Rewrite `string-width` to Bun's native width for the default options as it is bundled; test agreement, the ambiguous-wide exception, speed, and refusal of an unrecognised source
- [x] Architecture spec requirements and changelog; index entries

## References

- [Change 0033: Upgrade to Ink 8 and React 19.3](./0033-upgrade-to-ink-8-and-react-19-3.md)
- [Bun: `Bun.stringWidth`](https://bun.sh/docs/api/utils#bun-stringwidth)
- [Bun: bundler plugins](https://bun.sh/docs/bundler/plugins)
