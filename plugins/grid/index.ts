import type { Plugin, PluginDefinition, PluginIdentity } from "@fx/tx/plugin";
import type {
  Grid,
  GridRequest,
  GridSelection,
  GridSelectRequest,
} from "./contract.ts";
import { requireDialogsCapability } from "./dialogs.ts";
import { printGrid } from "./render.ts";
import { selection, selectRequest } from "./select.ts";
import { requireThemeCapability } from "./theme.ts";

/**
 * The provider is checked against the contract it publishes rather than
 * against a shape declared here: it is imported type-only from beside this
 * file, so the value registered under the key and the type a consumer imports
 * from that same specifier cannot drift apart.
 */

const identity: PluginIdentity = Object.freeze({ name: "grid" });

/** The key the capability is registered under, which is also the specifier its
 * contract is published at — one string rather than two that have to be kept
 * agreeing, and one a package other than this one could not claim. The plugin
 * keeps its own bare identity name: that names the plugin, and a capability
 * provider claiming no command namespace has nothing to collide over. */
const gridKey = "@fx/tx/grid";

/**
 * The grid capability: cells laid out in two dimensions, printed once or
 * driven.
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

        /**
         * Presents the rows as a select and answers with the row and the
         * action the reader chose.
         *
         * The dialogs capability is read while the command runs, for the same
         * two reasons the theme is: a plugin reading during its own
         * initialization sees only what committed before it, and the provider
         * is composed ahead of its consumers. It resolves its own theme for
         * the stream it draws on, so nothing about an appearance is decided
         * here.
         *
         * Every rejection a malformed request earns — a grid with no rows,
         * rows carrying no cells at all, and the non-interactive streams a
         * dialog cannot run on — is the select's, raised before any terminal
         * state changes. There is one owner of each of those rules and it is
         * not this one. What the composition takes off the table rather than
         * passing through is a ragged set of rows and a header list longer
         * than a row: both are padded to the grid's own column count, so
         * neither can reach the select as a column it would have to reject.
         *
         * Handing the terminal on needs nothing here either: the dialog
         * restores it and unmounts its renderer before it settles, so a
         * consumer that starts a process the moment this resolves finds the
         * terminal as it was.
         */
        async select<T, A>(
          request: GridSelectRequest<T, A>,
        ): Promise<GridSelection<T, A> | undefined> {
          const dialogs = requireDialogsCapability(registrations);
          const chosen = await dialogs.select(selectRequest(request));
          return chosen === undefined
            ? undefined
            : selection(request, chosen.value);
        },
      });

      register<Grid>(gridKey, grid);
    };
  },
});

export default definition;
