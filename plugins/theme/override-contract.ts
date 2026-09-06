/**
 * The published contract of the `@fx/tx/theme-override` key: the shape of a
 * partial override any plugin may contribute to the theme.
 *
 * It is a key of its own rather than part of the theming contract, so it is
 * published at a subpath of its own too. The unit of publication is the key,
 * not the capability: the plugin registering an override has to type what it
 * registers exactly as the plugin reading a capability has to type what it
 * gets, and the registry keeps every entry under one key as a distinct member
 * of one snapshot, so the two values could not share a key without a consumer
 * having to tell them apart by shape.
 *
 * The theme plugin owns both keys, which is why this file declares the
 * override over the theming contract's own vocabulary rather than restating
 * it. Like that contract it declares types alone, so it survives compilation
 * no more than the specifier it is published at carries anything to run.
 */

import type { Appearance, ThemeVariable } from "./contract.ts";

/**
 * A partial override of the default theme, registered under
 * `@fx/tx/theme-override`.
 *
 * A variable is the unit: an unspecified one keeps the default appearance, and
 * a contributed appearance replaces the default rather than merging into it,
 * because an absent field means the attribute is not applied rather than
 * inherited and merging would make an override unable to turn an attribute
 * off.
 */
export type ThemeOverride = Partial<Record<ThemeVariable, Appearance>>;
