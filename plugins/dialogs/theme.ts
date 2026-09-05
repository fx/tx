/**
 * The theming contract as the dialogs plugin sees it.
 *
 * It is a local structural type rather than an import from the theme plugin:
 * the capability is internal, so core carries no theme vocabulary, and two
 * bundled plugins may not share a module graph. The provider reaches this one
 * through the registry, exactly as the marketplace plugin reaches the config
 * capability.
 */

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

/** What one variable looks like. An absent field means the attribute is not
 * applied — never that it is unresolved or inherited. */
export type Appearance = {
  readonly dim?: boolean;
  readonly bold?: boolean;
  readonly inverse?: boolean;
  readonly hue?: Hue;
};

/** The semantic roles a surface may name. A dialog names only `chrome`,
 * `content`, and `cursor`; the rest are part of the one shared vocabulary and
 * are named by other surfaces. */
export type ThemeVariable =
  | "chrome"
  | "content"
  | "cursor"
  | "marker"
  | "muted"
  | "strong"
  | "positive"
  | "caution"
  | "danger";

/** A theme resolved for one stream. It answers with an appearance and never
 * says whether hues were enabled: that decision is already inside every
 * appearance it returns. */
export type Theme = {
  appearance(variable: ThemeVariable): Appearance;
};

/** The capability registered under `theme`. A theme is resolved for the stream
 * the surface draws to, because colour enablement depends on it. */
export type Theming = {
  theme(
    stream: { readonly isTTY?: boolean },
    options?: { readonly colour?: boolean },
  ): Theme;
};

/**
 * The one theming capability, or a failure naming how many were found.
 *
 * There is deliberately no fallback. A consumer that fell back would have to
 * know the default theme, which means carrying a copy of it — the duplication
 * theming exists to remove — and the alternatives are a cross-plugin import or
 * theme vocabulary in core, both of which the boundaries forbid. The theme
 * plugin is bundled and composed by default, so its absence is a
 * misconfiguration rather than a supported mode, and requiring exactly one
 * catches two composed providers at the same time.
 */
export function requireThemeCapability(
  registrations: <T>(key: string) => readonly T[],
): Theming {
  const themes = registrations<Theming>("theme");
  if (themes.length !== 1) {
    throw new Error(
      `Expected exactly one theme capability, but found ${themes.length}`,
    );
  }
  return themes[0] as Theming;
}
