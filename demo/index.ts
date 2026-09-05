/**
 * Shippable demo showcasing every dialogs-plugin feature.
 *
 *   bun run demo              # every scenario, one after another
 *   bun run demo input        # standalone input: blinking caret
 *   bun run demo select       # short list, no sub-dialogs: confirmation flash
 *   bun run demo filter       # long list: start typing and it narrows
 *   bun run demo shownfilter  # long list whose filter is shown before you type
 *   bun run demo fields       # select whose option collects input fields
 *   bun run demo nested       # three-level column browser (Enter/→ in, ←/Esc out)
 *   bun run demo tab          # the same tree with opening bound to Tab
 *   bun run demo leaf         # select whose option opens a text input leaf
 *
 * It runs from a source checkout: it imports the bundled dialogs plugin and the
 * core entry point directly, and neither is in the published package.
 *
 * Dialogs render on stderr, results are printed on stdout, so
 * `bun run demo select > /dev/null` still shows the dialog.
 */

import dialogsPlugin from "../plugins/dialogs/index.ts";
import themePlugin from "../plugins/theme/index.ts";
import { main } from "../src/cli.ts";
import type { CommandContext, PluginDefinition } from "../src/plugin.ts";
import {
  type Dialogs,
  isScenario,
  order,
  present,
  type ScenarioName,
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
        for (const name of names) {
          report(context, name, await present(dialogs, name));
        }
      };
      command((namespace) => {
        namespace
          .description("Showcase every dialogs-plugin feature")
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

/** What the demo runs as: the theme plugin the dialogs plugin resolves its
 * appearances from, the dialogs plugin providing the capability, and the
 * demo's own namespace consuming it. */
const plugins: readonly PluginDefinition[] = [
  themePlugin,
  dialogsPlugin,
  demoPlugin,
];

const argv = import.meta.main ? ["demo", ...Bun.argv.slice(2)] : [];
if (import.meta.main) process.exitCode = await main(argv, plugins);
