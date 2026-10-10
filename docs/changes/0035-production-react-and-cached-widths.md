# 0035: Production React and Cached Text Widths

## Summary

Build the executables with `NODE_ENV` set to `production`, so tx — and every plugin rendering with the React tx injects — runs React's production build, and rewrite `string-width` as it is bundled so it measures each distinct grapheme cluster once instead of on every call. Together they keep a terminal UI that redraws often (a streaming chat) responsive on Bun, without changing a single measured width.

**Spec:** [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** 0033

## Motivation

Since tx injects its React and Ink into every plugin, their speed is every plugin's speed, and a plugin cannot fix either from its side.

**React runs its development build.** React, `react-reconciler`, and `scheduler` choose their build from `process.env.NODE_ENV`, and `Bun.build` inlines it as `"development"` unless told otherwise. `build.ts` sets no value, so the released executable embeds React's development build: its warning texts are in the binary, its error decoder link is not. The development build validates and freezes every element and keeps extra bookkeeping on every render — several times slower for a UI that re-renders many times a second.

**Ink's width measurement is pathologically slow on Bun.** Ink and its helpers (`widest-line`, `wrap-ansi`, `cli-truncate`) measure text with `string-width` — every visible row on every frame (Ink's `Output` and its width cache are rebuilt per frame), and every changed line again in incremental rendering. The dependency graph resolves three copies: `string-width` 8.3.0 at the root, and 8.2.2 under `cli-truncate` and under `widest-line`. For each non-ASCII grapheme cluster, each copy tests a `v`-flag `\p{RGI_Emoji}` regular expression that Bun runs about a thousand times slower than other engines: 2000 rows of box-drawing text take about 6 s. The same few clusters — box drawing, letters, punctuation — are measured over and over.

`Bun.stringWidth` is fast but not a substitute: it disagrees with `string-width` in hundreds of places (standalone combining marks, emoji with modifiers or marks, Indic and Thai vowel signs, Yijing symbols, decomposed Hangul jamo, ambiguous characters when they count as wide), so delegating to it would change Ink's layout.

Measured with a chat plugin streaming an answer at a model's pace in a 200×60 tmux pane, the delay between a keypress and its echo falls from about 95 ms to about 40 ms median with both changes.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- The standalone build test MUST show, for both executables the production build creates, that each carries React's production build and none of its development warnings, and that each carries the cached-width rewrite of `string-width`.
- A test MUST bundle every `string-width` copy the dependency graph resolves through the build's rewrite and show that it returns exactly the unrewritten module's widths across a broad corpus under every option combination, that it measures a screen of box-drawing rows within a bound the unrewritten module exceeds by an order of magnitude, and that the rewrite refuses a source whose shape it does not recognise.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Architecture: Runtime and Distribution](../specs/architecture/index.md#runtime-and-distribution) owns the behavior and is this change's acceptance criteria. What implementing it requires of this change:

- `build.ts` defines `process.env.NODE_ENV` as `"production"` for both executables.
- A bundler plugin (`build-plugins.ts`, used by `build.ts`) rewrites every bundled `string-width` copy: the module's own function is kept, renamed, and a new default export performs the same preparation (ANSI stripping, the printable-ASCII fast path) and sums a width per grapheme cluster, asking the module's own function about each cluster it has not measured yet and caching the answer per `ambiguousIsNarrow` value. The cache is bounded (4096 entries) and starts over when full. The rewrite throws, failing the build, when the source no longer has the shape it relies on.

## Design

### Approach

The rewrite is exact by construction: `string-width` sums independent per-cluster widths, and each depends only on the cluster and `ambiguousIsNarrow`, so caching per cluster changes no result. It follows the existing `disable-ink-development-mode` plugin, changing the dependency only where it is bundled into the executables. Its loader filter matches every `string-width/index.js`, so all three resolved copies are rewritten; the shape check holds for 8.2.2 and 8.3.0 alike.

Two alternatives were rejected:

- **A Bun `patchedDependencies` patch.** Bun reads that field from the published `package.json` too, so installing `@fx/tx` as a dependency — which plugin authors do for its types — fails on the missing patch file (`test/plugin-consumer.test.ts` caught it).
- **Delegating to `Bun.stringWidth`.** Faster still, but it changes widths (see Motivation).

Running tx from source keeps the unmodified modules; the requirement is about the executables.

### Non-Goals

- **Plugin bundles.** The marketplace loader also bundles plugins with `Bun.build`, which inlines `NODE_ENV` as `"development"` there too. A plugin that renders uses the injected React, which this change fixes; changing what a plugin's own code sees for `NODE_ENV` is a separate decision.
- Replacing Ink's measuring, or caching whole strings across frames.

## Tasks

- [x] Define `NODE_ENV=production` in the production build; test both executables carry React's production build and the cached-width rewrite
- [x] Rewrite every bundled `string-width` to cache per-cluster widths; test exactness against each resolved copy, speed, and refusal of an unrecognised source
- [x] Architecture spec requirements and changelog; index entries

## References

- [Change 0033: Upgrade to Ink 8 and React 19.3](./0033-upgrade-to-ink-8-and-react-19-3.md)
- [Bun: bundler plugins](https://bun.sh/docs/bundler/plugins)
