/**
 * The one theming capability this plugin draws its appearances from.
 *
 * The vocabulary it is typed by is imported from `@fx/tx/theme` — the same
 * string the read below passes — rather than restated here. A restated copy
 * compiles whatever the theme plugin does, so a contract that moved would be
 * discovered when a printed grid reached for an appearance rather than when
 * this plugin was built. The import is a published specifier rather than a
 * relative path into `../theme/`, so nothing about it puts two bundled plugins
 * in one runtime module graph: it is erased entirely.
 */

import type { Theming } from "@fx/tx/theme";

/**
 * The one theming capability, or a failure naming how many were found.
 *
 * There is deliberately no fallback, for the reason the dialogs plugin states
 * and this one shares: a consumer that fell back would have to carry a copy of
 * the default theme, which is the duplication theming exists to remove. The
 * theme plugin is bundled and composed by default, so its absence is a
 * misconfiguration rather than a supported mode, and requiring exactly one
 * catches two composed providers at the same time.
 */
export function requireThemeCapability(
  registrations: <T>(key: string) => readonly T[],
): Theming {
  const themes = registrations<Theming>("@fx/tx/theme");
  if (themes.length !== 1) {
    throw new Error(
      `Expected exactly one theme capability, but found ${themes.length}`,
    );
  }
  return themes[0] as Theming;
}
