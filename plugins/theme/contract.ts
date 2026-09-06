/**
 * The published theming contract: everything a plugin needs to type the value
 * it reads from the `@fx/tx/theme` registry key, and nothing else.
 *
 * It is published at that same specifier, so the string a consumer passes to
 * the read and the string it imports this file from are one string rather than
 * two that have to be kept agreeing. A consumer that imported this instead of
 * restating it learns about a contract that moved when it builds rather than
 * when its command reaches for a member that is no longer there.
 *
 * It declares types alone — no imports, no statements, nothing that survives
 * compilation — which is what lets it be published under a `types` condition
 * with no runtime condition beside it, and what lets the boundary test check
 * the types-only rule mechanically rather than by review. The capability's
 * value comes from the registry and must keep coming from there.
 *
 * Publishing the vocabulary does not publish the default appearances behind
 * it: a consumer that can name a variable still cannot resolve one without the
 * capability. Nothing here draws, reads a stream, or knows a renderer.
 */

/** The hues a theme may name: the eight ANSI colours plus `gray`. Background
 * hues, 256-colour, and truecolour are deliberately absent — a palette wide
 * enough to be precise is a palette wide enough to be inconsistent. */
export type Hue =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray";

/**
 * What one variable looks like.
 *
 * An appearance asserts only what it carries: an absent `dim`, `bold`, or
 * `inverse` means that attribute is not applied, and an absent `hue` means no
 * hue is emitted. An absent field is never unresolved and never inherited,
 * which is what lets the default theme resolve every variable while naming no
 * hue at all.
 */
export type Appearance = {
  readonly dim?: boolean;
  readonly bold?: boolean;
  readonly inverse?: boolean;
  readonly hue?: Hue;
};

/**
 * The semantic roles a surface may name. A caller names what a piece of text
 * *is*; the theme decides what that looks like.
 *
 * This union is the one source of truth for what a variable is. The provider's
 * default appearance table is typed against it rather than the other way
 * about, so a variable named here without a default, or given a default
 * without being named here, fails to compile.
 *
 * Adding one is backward compatible; removing or repurposing one is a breaking
 * change to every surface naming it and, now that this is published, to every
 * consumer outside the repository as well.
 */
export type ThemeVariable =
  /** Everything a surface draws around its content: frame edges, corners,
   * titles, dividers, key hints, prompts, and overflow counts. */
  | "chrome"
  /** A surface's own text: an option label, a grid cell, entered text. */
  | "content"
  /** The bar marking the active row. */
  | "cursor"
  /** A glyph annotating a row rather than belonging to it, such as the one
   * saying a row leads somewhere. */
  | "marker"
  /** Content de-emphasized relative to `content`, and nothing more. */
  | "muted"
  /** Content emphasized relative to `content`, and nothing more. */
  | "strong"
  /** Content whose state is good. */
  | "positive"
  /** Content whose state needs attention. */
  | "caution"
  /** Content whose state is bad. */
  | "danger";

/** A resolved theme, which answers with an appearance and nothing else. It
 * deliberately cannot be asked whether hues were enabled — every appearance it
 * returns already reflects that decision, and a consumer given the flag is a
 * consumer that can branch on it. */
export type Theme = {
  appearance(variable: ThemeVariable): Appearance;
};

/** The value registered under `@fx/tx/theme`. A theme is resolved for the
 * stream a surface draws to rather than handed out ready-made, because colour
 * enablement depends on that stream; only its TTY-ness is read, and it is
 * neither retained nor written to. */
export type Theming = {
  theme(
    stream: { readonly isTTY?: boolean },
    options?: { readonly colour?: boolean },
  ): Theme;
};
