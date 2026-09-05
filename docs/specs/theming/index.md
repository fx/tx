# Theming

## Overview

Theming is the one place `tx` decides what its terminal output looks like. A theme is a set of named appearance variables — roles such as chrome, content, and the cursor bar — and every surface `tx` draws MUST ask the theme for a role rather than name an appearance itself. The default theme is the greyscale Norton Commander palette [Dialogs](../dialogs/) already renders, so adopting a theme MUST change nothing on screen until something overrides one.

A theme is supplied by a bundled plugin as an internal capability, exactly as [Dialogs](../dialogs/) and [Config](../config/) are. Core carries no theme vocabulary.

## Background

Two surfaces need this at once, for opposite reasons.

[Dialogs](../dialogs/) hard-codes its appearance decisions: a dimmed frame edge, an inverted cursor bar, and a rule that no hue is ever emitted. That rule is right for a dialog and it should stay the default, but it is written today as an absolute prohibition rather than as the theme it actually is, so nothing can be varied without editing the requirement.

[Grid](../grid/) needs the opposite. A grid of rows carrying state — healthy, degraded, failed — wants those distinguishable, and a consumer that cannot ask `tx` for a role ends up naming a hue itself. That is the outcome theming exists to prevent: an appearance decision made in a consumer is one `tx` can never change, restyle, or turn off.

Theming resolves both by moving the decision to one owner. Dialogs stops naming appearances and asks for roles; grid asks for the same roles and gets hueless answers by default.

## Requirements

### Theme Capability

- The bundled theme plugin MUST register one theming capability under the opaque registry key `theme` and MUST NOT claim a command namespace.
- The capability MUST resolve a theme for a surface from the stream that surface draws to, because [Colour Enablement](#colour-enablement) depends on that stream. It MUST take the stream as an argument and MUST NOT retain it, expose it, expose the terminal, or expose a renderer.
- A consumer MUST read the capability while its command runs rather than during its own initialization, because registry reads during initialization see only earlier providers.
- A resolved theme MUST answer with an appearance alone. It MUST NOT expose whether hues were enabled, because [Colour Enablement](#colour-enablement) requires every appearance it returns to reflect that decision already, and a consumer given the flag is a consumer that can branch on it.
- The contract MUST remain a local structural type shared by bundled plugins; nothing about theming MUST enter `src/` or the public `@fx/tx/plugin` contract.
- Exactly one theme provider MUST be composed. A consumer reading the `theme` key that finds no capability, or finds more than one, MUST fail with an error naming how many it found, exactly as `requireConfigCapability` in `plugins/marketplace/configured.ts` already does for the [Config](../config/) capability. There is deliberately no fallback: the theme plugin is bundled and composed by default, so its absence is a misconfiguration rather than a supported mode, and a fallback would oblige every consumer to carry its own copy of the default theme — the duplication this capability exists to remove. [Why There Is No Fallback](#why-there-is-no-fallback) states the reasoning in full.

The initial shape is conceptual:

```ts
type Appearance = {
  readonly dim?: boolean
  readonly bold?: boolean
  readonly inverse?: boolean
  readonly hue?: Hue
}

type Hue =
  | "black" | "red" | "green" | "yellow"
  | "blue" | "magenta" | "cyan" | "white"
  | "gray"

type ThemeVariable =
  | "chrome" | "content" | "cursor" | "marker"
  | "muted" | "strong"
  | "positive" | "caution" | "danger"

type Theme = {
  appearance(variable: ThemeVariable): Appearance
}

// A partial override, registered under `theme-override` by any plugin.
type ThemeOverride = Partial<Record<ThemeVariable, Appearance>>

// The value registered under `theme`. `stream` is the surface being drawn to;
// only its TTY-ness is read, and it is not retained.
type Theming = {
  theme(stream: { readonly isTTY?: boolean }, options?: { readonly colour?: boolean }): Theme
}
```

#### Scenario: Capability used by a command

- **GIVEN** a bundled theme provider has initialized successfully
- **WHEN** a consumer reads the `theme` key while its command runs and resolves a theme for the stream it draws to
- **THEN** it receives exactly one theming capability and can resolve an appearance for every variable

#### Scenario: Absent capability fails

- **GIVEN** no theme provider is composed
- **WHEN** a consumer reads the `theme` key while its command runs
- **THEN** it fails with an error saying no theme capability was found, and draws nothing

#### Scenario: Duplicate providers fail

- **GIVEN** two theme providers are composed
- **WHEN** a consumer reads the `theme` key while its command runs
- **THEN** it fails with an error saying two were found, rather than silently taking either one

### Theme Variables

The variables are semantic roles, not appearances. A caller names what a piece of text *is*; the theme decides what it looks like.

- The theme MUST define every variable, so no consumer has to handle an unresolved one.
- `chrome` MUST name every part a surface draws around its content: frame edges, corners, titles, dividers, key hints, prompts, and overflow counts.
- `content` MUST name a surface's own text: an option label, a grid cell, and text the user has entered.
- `cursor` MUST name the bar marking the active row.
- `marker` MUST name a glyph that annotates a row rather than belonging to it, such as the one saying a row leads somewhere.
- `muted` and `strong` MUST name content de-emphasized and emphasized relative to `content`, carrying no further meaning.
- `positive`, `caution`, and `danger` MUST name content whose state is good, needs attention, and is bad, and MUST NOT be given any meaning beyond that.
- The variable set MAY grow with a backward-compatible addition; removing or repurposing one MUST be treated as a breaking change to every surface that names it.

#### Scenario: A caller names a role, not an appearance

- **GIVEN** a surface draws a row it considers failed
- **WHEN** it resolves the `danger` variable
- **THEN** it receives an appearance and never chooses a hue, a dim, or an inversion itself

### Default Theme

- The default theme MUST be the greyscale presentation [Dialogs: Presentation](../dialogs/index.md#presentation) describes: `chrome`, `muted`, and `marker` dimmed, `content` and `positive` and `caution` and `danger` in the terminal's default foreground, `strong` bold, and `cursor` inverted.
- The default theme MUST resolve no hue for any variable, so a `tx` that overrides nothing MUST emit only the terminal's default foreground and background, their dimmed and bold forms, and their inversion.
- Adopting theming MUST NOT change what any existing surface renders. A dialog drawn against the default theme MUST produce the bytes it produced before theming existed.

#### Scenario: Default rendering is unchanged

- **GIVEN** no plugin has overridden a theme variable
- **WHEN** a select dialog renders
- **THEN** its frame, title, hints, and cursor bar appear exactly as they did before theming, and no hue is emitted

### Plugin Overrides

Overriding is supported because a surface will occasionally need it, not because varying the look is encouraged. A plugin that overrides nothing gets a coherent `tx`; a plugin that overrides freely gets one that no longer looks like itself.

- A plugin MAY contribute an override for any subset of the variables during initialization, and MUST NOT be required to supply a complete theme.
- An override MUST be registered under the opaque registry key `theme-override`, which is distinct from the `theme` key the capability itself is registered under. The two carry different values — a theming capability and a partial override — and the [Generic Registry](../plugin-system/index.md#generic-registry) keeps every entry under one key as a distinct member of one snapshot, so a single key could not hold both without a consumer having to tell them apart by shape.
- Overrides MUST be composed when a theme is resolved for a surface, which happens while a command runs. They MUST NOT be composed during the theme provider's own initialization: the registry shows a plugin only what committed before it, so an override contributed by a later plugin is invisible at that point and composing then would silently drop it.
- An unspecified variable MUST keep the default theme's appearance, so a one-variable override is a one-variable change.
- Overrides MUST be composed over the default theme in the registry's deterministic commit order, and a later override of the same variable MUST win.
- An override contributed by a plugin that fails initialization MUST NOT be applied, under the atomic-staging rules the [Generic Registry](../plugin-system/index.md#generic-registry) owns.
- Overriding SHOULD be avoided. A surface that can express itself with the default variables SHOULD do so, and a consumer SHOULD NOT override a variable merely to distinguish itself from another surface.

#### Scenario: An override contributed after the theme provider still applies

- **GIVEN** a plugin composed after the theme plugin registers an override
- **WHEN** a surface resolves a theme while a command runs
- **THEN** the override is applied, because composition happens at resolution rather than at the theme provider's initialization

#### Scenario: A partial override leaves the rest alone

- **GIVEN** a plugin overrides only `danger`
- **WHEN** a surface renders
- **THEN** `danger` uses the override and every other variable renders exactly as the default theme does

#### Scenario: A failed plugin's override is absent

- **GIVEN** a plugin contributes an override and then fails initialization
- **WHEN** a surface renders
- **THEN** the override is absent and healthy plugins' overrides still apply

### Colour Enablement

Whether hues reach a surface is one rule, applied by one owner — not a flag each consumer re-derives. It is resolved per surface rather than per process, because the answer depends on the stream being drawn to and two surfaces in one invocation can differ: a dialog draws to standard error while a printed grid draws to whatever stream its consumer supplies, and one of those can be a terminal while the other is a pipe.

- The theme MUST resolve whether hues are emitted, and every appearance it returns MUST already reflect that decision, so a consumer never tests for colour itself.
- The five inputs MUST be consulted in one fixed order, and the first that decides MUST settle the question with the rest unread. No pair of inputs may be left to interact, because a rule stated as a set of independent conditions leaves every conflicting pair — `TERM=dumb` beside `FORCE_COLOR=1`, an explicit request beside `NO_COLOR` — without an answer. Highest first:
  1. The caller's own request, where the invoking command made one: `false` MUST disable hues and `true` MUST enable them. It is the most specific statement of intent there is, and a command that offers the flag has already decided the flag wins.
  2. `NO_COLOR` present in the environment with any value, including an empty one, MUST disable hues.
  3. `FORCE_COLOR` MUST decide in both directions: `0` or `false` MUST disable hues even on a TTY, and any other value MUST enable them even off one. A `FORCE_COLOR` that is absent, empty, or only whitespace decides nothing and MUST be passed over, leaving the question to the inputs below it.
  4. `TERM` being `dumb` MUST disable hues.
  5. The stream being drawn to not being a TTY MUST disable hues.
- Where no input decides, hues MUST be enabled.
- Two consequences of that order are worth stating outright, because both are cases an implementation will be asked about: `NO_COLOR` beats `FORCE_COLOR`, and `FORCE_COLOR=1` beats `TERM=dumb` and beats a redirected stream, which is what makes it a way of forcing colour rather than a hint.
- With hues disabled, a theme MUST still resolve dim, bold, and inverse, so a surface keeps its structure when it loses its colour.

#### Scenario: NO_COLOR wins

- **GIVEN** `NO_COLOR` is set to an empty string and `FORCE_COLOR` is set to `1`
- **WHEN** a surface renders
- **THEN** no hue is emitted and dim, bold, and inverse still apply

#### Scenario: Forced colour off a terminal

- **GIVEN** output is redirected to a file and `FORCE_COLOR` is set to `1`
- **WHEN** a surface renders
- **THEN** hues are emitted, so capturing colour deliberately stays possible

#### Scenario: Redirected output drops colour

- **GIVEN** output is redirected and no colour variable is set
- **WHEN** a surface renders
- **THEN** no hue is emitted and the visible text is the text a terminal would show

#### Scenario: Forced colour beats a dumb terminal

- **GIVEN** `TERM` is `dumb` and `FORCE_COLOR` is set to `1`
- **WHEN** a surface renders
- **THEN** hues are emitted, because `FORCE_COLOR` is consulted before `TERM`

#### Scenario: An explicit request beats the environment

- **GIVEN** the invoking command was asked for colour and `NO_COLOR` is set
- **WHEN** a surface renders
- **THEN** hues are emitted, because the caller's own request is consulted first

## Design

### Ownership

The theme plugin owns the variable set, the default appearances, the composition of overrides, and the colour-enablement decision. It owns nothing about drawing: it never writes to a stream, never retains one, and never touches a renderer, React, or Ink. The only thing it reads from the stream it is handed is whether that stream is a terminal, which is what keeps it testable as a pure resolution of environment plus TTY-ness plus overrides.

Consumers own the mapping from their own content to a variable. Only the consumer knows that a particular row is failed; only the theme knows what failed should look like.

### Why Roles Rather Than a Palette

A palette exposed to consumers is a palette consumers embed. Naming `red` in a plugin makes the hue a fact about that plugin, and a later decision to restyle `tx`, to support a light terminal, or to drop hue entirely then has to be made once per consumer. Naming `danger` leaves every one of those decisions with the theme.

It is also what makes the greyscale default honest rather than a restriction. The dialogs rule that no hue is emitted becomes a property of one theme rather than a prohibition written into a layout module, and it can stay the default indefinitely without freezing every other surface to it.

### Why There Is No Fallback

A consumer that falls back to the default theme when the capability is absent has to know the default theme, and knowing it means carrying it: every variable, every default appearance, and the colour-enablement order that decides which of them survive. That is the duplication theming was introduced to delete, reintroduced once per consumer and guaranteed to drift from the theme plugin the first time a variable's default changes. The alternative — reaching into the theme plugin for its defaults — is the cross-plugin import [Composition and Boundaries](../plugin-system/index.md#composition-and-boundaries) forbids, and lifting the defaults into `src/` would put theme vocabulary in core, which is the one thing this specification says core does not carry.

Requiring exactly one provider removes the choice. The theme plugin is bundled and composed by default, so a `tx` without it is misconfigured rather than degraded, and a misconfiguration should say so at the point it is discovered. Requiring exactly one also catches the opposite mistake for free: two composed providers would otherwise be silently the first, which is the kind of ambiguity a consumer can neither see nor report.

### Why the Default Must Be Byte-Identical

Theming is a refactor of where an appearance decision is made, not a restyle. If adopting it changed a single rendered byte, every dialogs presentation test would have to be re-baselined at the same moment the indirection was introduced, and a real regression would be indistinguishable from an intended restyle. Holding the default byte-identical keeps the existing tests as the proof that the indirection is faithful.

## Constraints

- A user-selectable theme, a theme name, a configuration key, and any persistence of a theme choice are out of scope.
- Background hues, 256-colour and truecolour palettes, underline, italic, strikethrough, and blink are out of scope; the appearance vocabulary is dim, bold, inverse, and one of the eight named ANSI hues — `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, and `white` — plus `gray`, nine in all.
- Terminal capability detection beyond `TERM` being `dumb` is out of scope; `tx` does not probe terminfo.
- Per-surface variable sets, theme inheritance, cascading scopes, and any selector language are out of scope. There is one variable set and one composed set of overrides per process; the only thing resolved per surface is [Colour Enablement](#colour-enablement), and it varies only because the stream does.
- Runtime theme switching, live reloading, and re-rendering on a theme change are out of scope.
- A public theme type export is out of scope while the only consumers are bundled plugins.
- Glyph choice is not a theme variable. The glyphs [Dialogs: Presentation](../dialogs/index.md#presentation) fixes remain part of that contract.

## Open Questions

- Whether a user SHOULD be able to select or adjust a theme through the [Config](../config/) capability is undecided. It is the obvious eventual want, and nothing here forecloses it, but no bundled consumer needs it yet.
- Whether a reduced-motion or high-contrast preference SHOULD be resolved alongside colour enablement, given both are environment-derived accessibility decisions, is undecided.
- Whether `strong` and `muted` earn their place once a second surface exists, or whether they collapse into `content`, is undecided; the grid is the first consumer that will say.
- Whether the theme SHOULD resolve an appearance for a variable a caller names but the set does not define, rather than failing to compile, is undecided; a structural type currently makes an unknown variable a type error, which is the stricter and cheaper answer.

## References

- [Dialogs](../dialogs/)
- [Grid](../grid/)
- [Plugin System](../plugin-system/)
- [Config](../config/)
- [NO_COLOR](https://no-color.org/)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-09-05 | Initial theme variables, default greyscale theme, plugin overrides, and colour enablement | [0026-add-theme-variables](../../changes/0026-add-theme-variables.md) |
