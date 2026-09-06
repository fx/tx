import type { Plugin, PluginDefinition } from "@fx/tx/plugin";
import { coloursEnabled } from "./colour.ts";
import type { Appearance, ThemeVariable, Theming } from "./contract.ts";
import type { ThemeOverride } from "./override-contract.ts";
import { defaultTheme, themeVariables } from "./variables.ts";

/**
 * The provider is checked against the contracts it publishes rather than
 * against a shape declared here: both are imported type-only from beside this
 * file, so the value registered under a key and the type a consumer imports
 * from that same specifier cannot drift apart.
 */

/** The key the capability is registered under, which is also the specifier its
 * contract is published at — one string rather than two that have to be kept
 * agreeing, and one a package other than this one could not claim. */
const themeKey = "@fx/tx/theme";

/** The key overrides are registered under, distinct from the capability's own
 * and published at a subpath of its own. The registry keeps every entry under
 * one key as a distinct member of one snapshot and never merges them, so a
 * shared key would hand every consumer a snapshot mixing a capability with
 * partial overrides and leave it to tell them apart by shape. */
const themeOverrideKey = "@fx/tx/theme-override";

/**
 * The defaults with every override laid over them, in the registry's commit
 * order, so a later override of the same variable wins and an unspecified
 * variable keeps the default appearance.
 *
 * A variable is the unit of override: a contributed appearance replaces the
 * default rather than merging into it, because an absent field means the
 * attribute is not applied rather than inherited, and merging would make an
 * override unable to turn an attribute off.
 *
 * What the theme keeps is an immutable snapshot: a contributed appearance is
 * copied and the copy frozen, and the record is frozen once it is composed.
 * The defaults already arrive frozen, but an override is another plugin's own
 * object, and a theme still holding that object would answer differently later
 * for reasons no consumer could see. Taking a snapshot leaves the contributor
 * free to do whatever it likes with its own object afterwards — reuse it,
 * mutate it, hand it somewhere else — without the composed theme changing, and
 * without this plugin reaching into data it does not own to freeze it.
 */
function composeOverrides(
  overrides: readonly ThemeOverride[],
): Readonly<Record<ThemeVariable, Appearance>> {
  const composed: Record<ThemeVariable, Appearance> = { ...defaultTheme };
  for (const override of overrides) {
    for (const variable of themeVariables) {
      const appearance = override[variable];
      if (appearance !== undefined) {
        composed[variable] = Object.freeze({ ...appearance });
      }
    }
  }
  return Object.freeze(composed);
}

/** The appearance as the surface may have it: the hue drops out where hues are
 * disabled, while dim, bold, and inverse survive, so a surface keeps its
 * structure when it loses its colour.
 *
 * The composed appearance is handed back by reference where it survives whole,
 * which is safe precisely because every appearance the theme holds is frozen —
 * that is what buys a read with no allocation behind it. The hueless one it
 * builds instead is frozen for the same reason, so no consumer is ever handed
 * an appearance it could change. */
function withColour(appearance: Appearance, colour: boolean): Appearance {
  if (colour || appearance.hue === undefined) return appearance;
  const hueless: {
    dim?: boolean;
    bold?: boolean;
    inverse?: boolean;
  } = {};
  if (appearance.dim !== undefined) hueless.dim = appearance.dim;
  if (appearance.bold !== undefined) hueless.bold = appearance.bold;
  if (appearance.inverse !== undefined) hueless.inverse = appearance.inverse;
  return Object.freeze(hueless);
}

const definition: PluginDefinition = Object.freeze({
  identity: Object.freeze({ name: "theme" }),
  load(): Plugin {
    return ({ env, register, registrations }) => {
      // Frozen, like every value this capability hands out: a consumer holds
      // the same object every other consumer in the process holds.
      const theming: Theming = Object.freeze({
        theme(stream, options) {
          // Read here rather than during initialization. The registry shows a
          // plugin only what committed before it, and the provider is composed
          // ahead of its consumers, so composing at initialization would
          // silently drop every override contributed after it. Resolution
          // happens while a command runs, when everything has committed.
          const composed = composeOverrides(
            registrations<ThemeOverride>(themeOverrideKey),
          );
          // The stream's TTY-ness is passed as something to ask rather than
          // something already read, because it is the lowest of the five
          // colour inputs and an input below the one that decides is not read
          // at all. Nothing here retains the stream: the closure lives no
          // longer than this call.
          const colour = coloursEnabled({
            env,
            isTTY: () => stream.isTTY,
            request: options?.colour,
          });
          return Object.freeze({
            appearance: (variable: ThemeVariable) =>
              withColour(composed[variable], colour),
          });
        },
      });

      register<Theming>(themeKey, theming);
    };
  },
});

export default definition;
