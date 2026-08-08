import type { Plugin, PluginDefinition, PluginIdentity } from "@fx/tx/plugin";

import { ExecutableUpdater, type ExecutableUpdaterOptions } from "./updater.ts";

export type { ExecutableUpdaterOptions } from "./updater.ts";

/**
 * The bundled plugin that owns the running `tx` executable. It contributes one
 * update participant and defines no commands, so it claims no namespace: what
 * it owns is reached through `tx update` rather than through a command of its
 * own.
 *
 * Unlike the marketplace plugin this one is deliberately not externalizable —
 * it names this project's repository and its published asset names, because it
 * is about this executable.
 */
export function createExecutablePlugin(
  options: ExecutableUpdaterOptions = {},
): PluginDefinition {
  const identity: PluginIdentity = Object.freeze({ name: "executable" });
  return Object.freeze({
    identity,
    load(): Plugin {
      return ({ dependencies, env, update }) => {
        // The running version comes from the injected dependencies, so the
        // participant never reads a package manifest.
        update(
          new ExecutableUpdater(dependencies.tx.version, {
            ...options,
            env: options.env ?? env,
          }),
        );
      };
    },
  });
}

const executablePlugin = createExecutablePlugin();
export default executablePlugin;
