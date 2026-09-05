# 0026: Add Theme Variables

## Summary

Introduce a bundled theme plugin supplying named appearance variables, make the existing greyscale Norton Commander look its default theme, and move every appearance decision the dialogs plugin makes today behind it. Nothing on screen changes.

**Spec:** [Theming](../specs/theming/)
**Status:** draft
**Depends On:** —

## Motivation

Appearance decisions are currently spread across the surface that draws them. `frame.ts` decides that chrome is dimmed. `columns.ts` decides that the cursor bar is the terminal's inversion. [Dialogs: Presentation](../specs/dialogs/index.md#presentation) writes "MUST NOT emit any hue" as an absolute prohibition, which is the right default expressed as a law.

That was fine while dialogs were the only thing `tx` drew. [Change 0028](./0028-add-the-grid-plugin.md) adds a second surface whose rows carry state, and a state a reader cannot distinguish is a row they have to read twice. Without a theme the grid has two options, and both are bad: name a hue in the grid plugin, which puts an appearance decision somewhere `tx` can never revisit, or make the consumer name one, which puts it somewhere `tx` cannot even see.

A theme resolves it by moving the decision to one owner and leaving the current answer in place as the default.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Development Conventions](../specs/architecture/index.md#development-conventions)). CI enforces these through `bun run check`:

- Production code MUST be TypeScript, and formatting and linting MUST use Biome.
- Tests MUST use Bun's test runner, and new observable behavior MUST have automated tests.
- Tests MUST maintain 100% statement, function, and line coverage across production source files.
- Committed tests MUST NOT contain focused or skipped cases without a documented reason.
- TypeScript MUST pass with no type errors.
- `test/plugin-boundary.test.ts` MUST keep passing; the theme plugin is bundled and its module graph MUST stay out of `src/`.

Colour resolution MUST be tested as a pure function of the caller's request plus environment plus TTY state rather than through a rendered surface, for the same reason column geometry is: [Theming: Colour Enablement](../specs/theming/index.md#colour-enablement) fixes one order over five inputs, and an order is a table of cases that belongs in a table of assertions.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional requirements

[Theming](../specs/theming/) owns the capability shape, the variable set, the default appearances, the override rules, and the colour-enablement precedence, together with all of their scenarios. Those are this change's acceptance criteria and are not restated here. What implementing them requires of this change:

- A new bundled plugin under `plugins/theme/`, composed in `cli.ts` before the plugins that consume it. Ordering is not required for correctness — consumers read at command time, when everything has committed — but composing a provider before its consumers is what the ordered defaults in `cli.ts` are for.
- The dialogs plugin stops naming appearances. `frame.ts` and `columns.ts` currently carry `dim` and `inverse` as booleans on their segment and cell types; those become theme variables resolved at the point the segment is turned into an element, so the geometry modules keep having no opinion about appearance.
- The dialogs plugin reads the `theme` key while a dialog runs, following the pattern `requireConfigCapability` in `plugins/marketplace/configured.ts` establishes, including its failure: finding no theme capability, or more than one, throws an error naming the count rather than falling back. [Theming: Theme Capability](../specs/theming/index.md#theme-capability) requires exactly one provider, and [Theming: Why There Is No Fallback](../specs/theming/index.md#why-there-is-no-fallback) says why a per-consumer default would be the duplication theming exists to remove.
- The capability resolves a theme from the stream a surface draws to rather than handing one out ready-made, because the colour decision depends on that stream. Dialogs pass their injected standard-error stream; a printed grid passes whatever stream its consumer supplied. Only the stream's TTY-ness is read; the capability never writes to it or keeps it.
- Overrides are read from the separate `theme-override` key and composed at resolution time. [Theming: Plugin Overrides](../specs/theming/index.md#plugin-overrides) owns both rules, and both exist because of what the registry does: one key holds every entry distinctly, and initialization-time reads cannot see a later plugin's contribution.

#### Scenario: Existing dialogs output is unchanged

- **GIVEN** the theme plugin is composed and nothing overrides a variable
- **WHEN** the existing dialogs rendering tests run
- **THEN** every one of them passes without being re-baselined

### Migration

- Every appearance currently hard-coded in `plugins/dialogs/` MUST be moved behind a variable in this change rather than left behind as a second way to decide the same thing. A surface with one decision behind the theme and another beside it is worse than one with neither.
- [Dialogs: Presentation](../specs/dialogs/index.md#presentation)'s greyscale rule has already been rewritten to delegate to [Theming](../specs/theming/). This change makes the code match that wording.

## Design

### Approach

`plugins/theme/` holds three things and no rendering. `variables.ts` names the variables and the default appearance of each. `colour.ts` resolves whether hues are emitted from an injected environment, an injected TTY flag, and the caller's own request — pure, no globals, no stream. `index.ts` registers the capability under `theme`; the capability it registers reads the `theme-override` snapshot and composes it over the defaults each time a surface resolves a theme, which is while a command runs and therefore after every override has committed.

The theme returns an appearance, not a rendered element and not a set of renderer props. Keeping the appearance renderer-agnostic is what lets `frame.ts` stay the only module in the dialogs plugin that knows what Ink calls a dim.

The existing `FrameSegment` and `ColumnCell` types carry `dim` and `inverse` booleans. Those become a variable name, and `createFrame` resolves the name when it builds the element. Geometry modules therefore lose an appearance concept rather than gaining one.

### Decisions

- **Decision**: a bundled plugin and an internal capability, not an injected core dependency.
  - **Why**: it is exactly the shape [Dialogs](../specs/dialogs/) and [Config](../specs/config/) already have, and [Composition and Boundaries](../specs/plugin-system/index.md#composition-and-boundaries) requires `src/` to stay feature-neutral. A theme vocabulary in `CoreDependencies` would be feature vocabulary in core.
  - **Alternatives considered**: a `theme` field on `CoreDependencies` (puts appearance vocabulary in core); a module the dialogs plugin imports directly (couples two bundled plugins in the module graph, which `test/plugin-boundary.test.ts` exists to prevent).
- **Decision**: overrides register under their own `theme-override` key, and are composed when a theme is resolved rather than when the theme plugin initializes.
  - **Why**: two things forced both halves. The [Generic Registry](../specs/plugin-system/index.md#generic-registry) keeps every entry under one key as a distinct member of one snapshot and never merges or deduplicates them, so a shared `theme` key would hand every consumer a snapshot mixing the capability with partial overrides and leave it to tell them apart by shape. And a plugin reading during its own initialization sees only what committed before it, so a theme plugin that composed at initialization would silently drop every override contributed by a plugin composed after it — which is most of them, since the provider is composed first. Composing at resolution time, while a command runs, sees every committed override, and the registry still supplies the FIFO order and the discarding of a failed plugin's registrations for free.
  - **Alternatives considered**: the same `theme` key for both (the snapshot-mixing problem above); composing once at initialization (drops later overrides); a mutation method on the capability (a plugin mutating another plugin's committed value).
- **Decision**: the default theme must be byte-identical, and the existing dialogs tests are the proof.
  - **Why**: this is a refactor of where a decision is made. If a rendered byte moved, every presentation test would be re-baselined in the same commit that introduced the indirection, and a genuine regression would be indistinguishable from an intended restyle.
  - **Alternatives considered**: restyling opportunistically while the code is open — rejected for exactly that reason.
- **Decision**: colour is resolved per surface, against the stream being drawn to.
  - **Why**: dialogs draw to stderr and a printed grid draws to a consumer-supplied stream, and those can differ in TTY-ness within one invocation — a piped grid alongside an interactive dialog is a normal thing to want.
  - **Alternatives considered**: one process-wide decision made at initialization (wrong whenever the two streams differ, and it would have to guess which stream to test).

### Non-Goals

- A user-selectable theme, a theme name, a config key, or persistence — [Theming: Open Questions](../specs/theming/index.md#open-questions) records this as the obvious next want and this change deliberately does not answer it.
- Restyling anything. No hue is introduced by this change; the default theme resolves none.
- Background hues, 256-colour or truecolour, underline, italic, or blink.
- Making glyphs themeable. [Dialogs: Presentation](../specs/dialogs/index.md#presentation) fixes the glyph contract and it stays fixed.
- Reduced-motion resolution, which [Theming: Open Questions](../specs/theming/index.md#open-questions) leaves undecided.

## Tasks

- [ ] Add the theme plugin
  - [ ] `plugins/theme/variables.ts` with the variable set and the default appearance of each
  - [ ] `plugins/theme/colour.ts` resolving hue enablement from injected environment, TTY state, and caller request
  - [ ] `plugins/theme/index.ts` registering the `theme` capability, which resolves a theme from a supplied stream and composes the `theme-override` snapshot over the defaults in commit order at that point
  - [ ] Compose the theme plugin in `cli.ts` ahead of its consumers
  - [ ] Table-driven tests walking the five-input precedence order in both directions, including the pairs it exists to settle: `NO_COLOR` against `FORCE_COLOR`, `FORCE_COLOR=1` against `TERM=dumb` and against a redirected stream, an explicit caller request against every environment input, and blank or whitespace `FORCE_COLOR` deciding nothing
  - [ ] Tests for partial overrides, override ordering, a failed provider's override being absent, and an override contributed by a plugin composed after the theme plugin still applying
- [ ] Move the dialogs plugin behind the theme
  - [ ] Replace the `dim` and `inverse` booleans on `FrameSegment` and `ColumnCell` with theme variables
  - [ ] Resolve variables where elements are built, so geometry modules carry no appearance concept
  - [ ] Read the `theme` capability at dialog time, requiring exactly one provider and failing with an error naming the count when none or several are found
  - [ ] Tests for both failures: no theme provider composed, and two composed
  - [ ] Confirm every existing dialogs rendering test passes unmodified

## Open Questions

- [ ] Whether `strong` and `muted` earn their place before the grid exists to use them, or whether this change should ship the smaller variable set and add them in [Change 0028](./0028-add-the-grid-plugin.md) — shipping them now risks two variables no surface names.
- [x] Whether the dialogs plugin should require exactly one theme provider, as `requireConfigCapability` requires exactly one config, rather than falling back. **Resolved: it requires exactly one, and the fallback is gone.** A consumer finding no theme capability, or more than one, fails with an error naming the count. The fallback could not be had honestly: a consumer that falls back knows the default theme, so it carries a copy of it, which is the duplication theming exists to remove — and the alternatives are a cross-plugin import or theme vocabulary in `src/`, both of which the boundaries forbid. The theme plugin is bundled and composed by default, so its absence is a misconfiguration rather than a supported mode, and requiring exactly one settles the two-provider case this question raised at the same time. [Theming: Theme Capability](../specs/theming/index.md#theme-capability) and [Theming: Why There Is No Fallback](../specs/theming/index.md#why-there-is-no-fallback) now carry the rule and its reasoning.

## References

- Spec: [Theming](../specs/theming/)
- Related changes: [0028-add-the-grid-plugin](./0028-add-the-grid-plugin.md), [0016-add-plugin-capabilities-and-dialogs](./0016-add-plugin-capabilities-and-dialogs.md), [0021-restyle-dialogs-as-norton-commander](./0021-restyle-dialogs-as-norton-commander.md)
