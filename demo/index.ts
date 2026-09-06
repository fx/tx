/**
 * Shippable demo showcasing every dialogs-plugin and grid-plugin feature:
 * the dialogs it asks with, and the layouts it prints.
 *
 *   bun run demo              # every scenario, one after another
 *   bun run demo input        # standalone input: blinking caret
 *   bun run demo select       # short list, no sub-dialogs: confirmation flash
 *   bun run demo filter       # long list: start typing and it narrows
 *   bun run demo shownfilter  # long list whose filter is shown before you type
 *   bun run demo cells        # a table: aligned cells under the headers naming them
 *   bun run demo fields       # select whose option collects input fields
 *   bun run demo nested       # three-level column browser (Enter/→ in, ←/Esc out)
 *   bun run demo tab          # the same tree with opening bound to Tab
 *   bun run demo leaf         # select whose option opens a text input leaf
 *   bun run demo grid         # printed table: aligned columns and a summary
 *   bun run demo flow         # printed flow: short items filling the width
 *   bun run demo rows         # interactive grid: pick a row, then an action
 *
 * It runs from a source checkout: it imports the bundled dialogs and grid
 * plugins and the core entry point directly, and none of them is in the
 * published package.
 *
 * Dialogs render on stderr, results and printed grids go to stdout, so
 * `bun run demo select > /dev/null` still shows the dialog and
 * `bun run demo grid | cat` prints the same bytes a terminal gets.
 */

import type { Grid } from "@fx/tx/grid";
import dialogsPlugin from "../plugins/dialogs/index.ts";
import gridPlugin from "../plugins/grid/index.ts";
import themePlugin from "../plugins/theme/index.ts";
import { main } from "../src/cli.ts";
import type { CommandContext, PluginDefinition } from "../src/plugin.ts";
import {
  type Dialogs,
  isScenario,
  order,
  present,
  type ScenarioName,
  scenarios,
  usage,
} from "./scenarios.ts";

function report(context: CommandContext, name: string, result: unknown): void {
  context.stdout.write(`${name}: ${JSON.stringify(result) ?? "cancelled"}\n`);
}

type CommandLike = {
  error(message: string, options?: { exitCode?: number; code?: string }): never;
};

export const demoPlugin: PluginDefinition = {
  identity: { name: "demo" },
  load:
    () =>
    ({ command, context, registrations }) => {
      const run = async (names: readonly ScenarioName[]) => {
        const [dialogs] = registrations<Dialogs>("dialogs");
        if (!dialogs) throw new Error("dialogs capability missing");
        const [grid] = registrations<Grid>("@fx/tx/grid");
        if (!grid) throw new Error("grid capability missing");
        // A printed grid goes to the same stream the answers do, which is what
        // makes `bun run demo grid | cat` the piped case the grid promises to
        // print identically.
        const surfaces = { dialogs, grid, stream: context.stdout };
        for (const name of names) {
          const result = await present(surfaces, name);
          // A printed grid is its own output: a line reporting what it
          // returned would be noise underneath it. A driven one answers a
          // question, so it is reported like every other dialog.
          if (scenarios[name].kind !== "grid") report(context, name, result);
        }
      };
      command((namespace) => {
        namespace
          .description("Showcase every dialogs-plugin and grid-plugin feature")
          .argument("[scenario]", `one of: ${order.join(", ")}`)
          .addHelpText("after", `\n${usage}\n`)
          .action(
            async (
              scenario: string | undefined,
              _flags: Record<string, unknown>,
              cmd: CommandLike,
            ) => {
              if (scenario === undefined) {
                await run(order);
                return;
              }
              if (!isScenario(scenario)) {
                cmd.error(
                  `unknown scenario: "${scenario}"\n\n${usage}\n\none of: ${order.join(", ")}`,
                  {
                    exitCode: 1,
                    code: "commander.invalidArgument",
                  },
                );
              }
              await run([scenario]);
            },
          );
      });
    },
};

/** What the demo runs as: the theme plugin the drawing surfaces resolve their
 * appearances from, the dialogs and grid plugins providing the capabilities,
 * and the demo's own namespace consuming them. */
const plugins: readonly PluginDefinition[] = [
  themePlugin,
  dialogsPlugin,
  gridPlugin,
  demoPlugin,
];

const argv = import.meta.main ? ["demo", ...Bun.argv.slice(2)] : [];
if (import.meta.main) process.exitCode = await main(argv, plugins);
