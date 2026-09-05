import type { Plugin, PluginDefinition, PluginIdentity } from "@fx/tx/plugin";
import { printGrid } from "./render.ts";
import { requireThemeCapability } from "./theme.ts";
import type { Grid, GridRequest } from "./types.ts";

const identity: PluginIdentity = Object.freeze({ name: "grid" });

/**
 * The grid capability: cells laid out in two dimensions and printed once.
 *
 * It claims no command namespace and adds no command — it exists so that a
 * plugin with rows to show does not have to own column measurement,
 * display-width arithmetic, colour resolution, canvas sizing, or a renderer
 * lifecycle. React and Ink arrive through the host's injected dependencies
 * rather than being imported here: a directly imported reconciler would be a
 * second copy in the same process, rendering against different internal state
 * than the host's.
 */
const definition: PluginDefinition = Object.freeze({
  identity,
  load(): Plugin {
    return ({ dependencies, register, registrations }) => {
      const { react, ink } = dependencies;

      // Frozen, like every value a capability hands out: a consumer holds the
      // same object every other consumer in the process holds.
      const grid: Grid = Object.freeze({
        print(request: GridRequest): void {
          // The theme is resolved while the command runs rather than while
          // this plugin initializes, for the two reasons the registry fixes: a
          // plugin reading during its own initialization sees only what
          // committed before it, and the theme provider is composed ahead of
          // its consumers. It is resolved for the stream being printed to,
          // because colour enablement depends on that stream and on no other.
          const theme = requireThemeCapability(registrations).theme(
            request.stream,
          );
          printGrid(react, ink, theme, request);
        },
      });

      register<Grid>("grid", grid);
    };
  },
});

export default definition;
