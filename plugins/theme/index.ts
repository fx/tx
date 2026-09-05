import type { Plugin, PluginDefinition } from "@fx/tx/plugin";
import { coloursEnabled } from "./colour.ts";
import {
  type Appearance,
  defaultTheme,
  type ThemeVariable,
  themeVariables,
} from "./variables.ts";

/**
 * The local structural contract the bundled theme provider and its bundled
 * consumers share. It lives beside the provider rather than in
 * `@fx/tx/plugin`: the capability is internal, so core carries no theme
 * vocabulary and nothing here is a public export.
 */

/** A resolved theme, which answers with an appearance and nothing else. It
 * deliberately cannot be asked whether hues were enabled — every appearance it
 * returns already reflects that decision, and a consumer given the flag is a
 * consumer that can branch on it. */
type Theme = {
  appearance(variable: ThemeVariable): Appearance;
};

/** A partial override, registered under `theme-override` by any plugin. */
type ThemeOverride = Partial<Record<ThemeVariable, Appearance>>;

/** The value registered under `theme`. A theme is resolved for the stream a
 * surface draws to rather than handed out ready-made, because colour
 * enablement depends on that stream; only its TTY-ness is read, and it is
 * neither retained nor written to. */
type Theming = {
  theme(
    stream: { readonly isTTY?: boolean },
    options?: { readonly colour?: boolean },
  ): Theme;
};

/** The key the capability is registered under. */
const themeKey = "theme";

/** The key overrides are registered under, distinct from the capability's own.
 * The registry keeps every entry under one key as a distinct member of one
 * snapshot and never merges them, so a shared key would hand every consumer a
 * snapshot mixing a capability with partial overrides and leave it to tell
 * them apart by shape. */
const themeOverrideKey = "theme-override";

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
 * A contributed appearance is frozen as it is laid in, and the record itself
 * when it is done: the defaults arrive frozen, but an override is another
 * plugin's own object, and a theme composed from one it could still change
 * afterwards is a theme that answers differently later for reasons no consumer
 * can see.
 */
function composeOverrides(
  overrides: readonly ThemeOverride[],
): Readonly<Record<ThemeVariable, Appearance>> {
  const composed: Record<ThemeVariable, Appearance> = { ...defaultTheme };
  for (const override of overrides) {
    for (const variable of themeVariables) {
      const appearance = override[variable];
      if (appearance !== undefined) {
        composed[variable] = Object.freeze(appearance);
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
