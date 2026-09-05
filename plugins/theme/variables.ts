/**
 * The theme's vocabulary: what an appearance may say, what the variables are,
 * and what each of them looks like before anything overrides it.
 *
 * Nothing here draws, reads a stream, or knows a renderer. A variable names
 * what a piece of text *is*; the appearance it resolves to is the only place
 * `tx` decides what that looks like.
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
 * The default theme, and the one source of truth for what a variable is: the
 * variable union below is derived from these keys, so a variable cannot be
 * named without a default appearance or given one without being named.
 *
 * It is the greyscale Norton Commander presentation the dialogs plugin drew
 * before theming existed — chrome, muted, and marker dimmed, cursor inverted,
 * strong bold, and everything else the terminal's own foreground — so adopting
 * a theme changes nothing on screen. No entry names a hue, which is what makes
 * "tx emits no colour" a property of one theme rather than a prohibition
 * written into a layout module.
 */
const defaultAppearances = {
  /** Everything a surface draws around its content: frame edges, corners,
   * titles, dividers, key hints, prompts, and overflow counts. */
  chrome: { dim: true },
  /** A surface's own text: an option label, a grid cell, entered text. */
  content: {},
  /** The bar marking the active row. */
  cursor: { inverse: true },
  /** A glyph annotating a row rather than belonging to it, such as the one
   * saying a row leads somewhere. */
  marker: { dim: true },
  /** Content de-emphasized relative to `content`, and nothing more. */
  muted: { dim: true },
  /** Content emphasized relative to `content`, and nothing more. */
  strong: { bold: true },
  /** Content whose state is good. */
  positive: {},
  /** Content whose state needs attention. */
  caution: {},
  /** Content whose state is bad. */
  danger: {},
} as const satisfies Readonly<Record<string, Appearance>>;

/** The semantic roles a surface may name. Adding one is backward compatible;
 * removing or repurposing one is a breaking change to every surface naming
 * it. */
export type ThemeVariable = keyof typeof defaultAppearances;

/** Every variable, which is what composition and exhaustiveness walk. */
export const themeVariables = Object.freeze(
  Object.keys(defaultAppearances),
) as readonly ThemeVariable[];

/** The default appearance of every variable. */
export const defaultTheme: Readonly<Record<ThemeVariable, Appearance>> =
  Object.freeze(defaultAppearances);
