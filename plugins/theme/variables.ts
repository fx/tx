/**
 * What each theme variable looks like before anything overrides it.
 *
 * The vocabulary itself — what an appearance may say and what the variables
 * are — is the published contract's, imported type-only from beside this file.
 * This module supplies only the values behind it, which are deliberately not
 * published: a consumer that can name a variable still resolves one through
 * the capability rather than by reading a table.
 *
 * Nothing here draws, reads a stream, or knows a renderer. A variable names
 * what a piece of text *is*; the appearance it resolves to is the only place
 * `tx` decides what that looks like.
 */

import type { Appearance, ThemeVariable } from "./contract.ts";

/**
 * The default appearance of every variable.
 *
 * The table is typed against the contract's variable union rather than the
 * union being derived from these keys, because the union is what is published
 * and a published contract cannot depend on a runtime value's shape. The check
 * runs in both directions: a variable named in the contract without an entry
 * here is a missing property, and an entry here that the contract does not
 * name is an excess one, so adding a variable to either alone fails to
 * compile.
 *
 * It is the greyscale Norton Commander presentation the dialogs plugin drew
 * before theming existed — chrome, muted, and marker dimmed, cursor inverted,
 * strong bold, and everything else the terminal's own foreground — so adopting
 * a theme changes nothing on screen. No entry names a hue, which is what makes
 * "tx emits no colour" a property of one theme rather than a prohibition
 * written into a layout module.
 */
const defaultAppearances = {
  chrome: { dim: true },
  content: {},
  cursor: { inverse: true },
  marker: { dim: true },
  muted: { dim: true },
  strong: { bold: true },
  positive: {},
  caution: {},
  danger: {},
} as const satisfies Readonly<Record<ThemeVariable, Appearance>>;

/** Every variable, which is what composition and exhaustiveness walk. */
export const themeVariables = Object.freeze(
  Object.keys(defaultAppearances),
) as readonly ThemeVariable[];

// Each appearance is frozen as well as the record holding them. `readonly` is
// a compile-time claim only, and the provider hands these very objects to its
// consumers rather than copies of them, so a consumer that mutated one would
// change what every later read in the process resolves to.
for (const appearance of Object.values(defaultAppearances)) {
  Object.freeze(appearance);
}

/** The default appearance of every variable, frozen through: neither the
 * record nor any appearance in it can be changed by anything holding one. */
export const defaultTheme: Readonly<Record<ThemeVariable, Appearance>> =
  Object.freeze(defaultAppearances);
