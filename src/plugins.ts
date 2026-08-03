import * as ink from "ink";
import * as react from "react";
import packageMetadata from "../package.json" with { type: "json" };
import {
  type CommandRegistration,
  type CommandRegistry,
  freezePluginIdentity,
} from "./commands.ts";
import type {
  CommandHandler,
  CoreDependencies,
  PluginAPI,
  PluginDefinition,
  PluginIdentity,
} from "./plugin.ts";

export const coreDependencies: CoreDependencies = Object.freeze({
  tx: Object.freeze({ version: packageMetadata.version }),
  react,
  ink,
  versions: Object.freeze({
    react: packageMetadata.dependencies.react,
    ink: packageMetadata.dependencies.ink,
  }),
});

export interface PluginLoadFailure {
  readonly identity: PluginIdentity;
  readonly message: string;
}

export interface InitializePluginsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly dependencies?: CoreDependencies;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function initializePlugins(
  registry: CommandRegistry,
  definitions: readonly PluginDefinition[] = [],
  options: InitializePluginsOptions = {},
): Promise<readonly PluginLoadFailure[]> {
  const failures: PluginLoadFailure[] = [];
  const queue: Array<PluginDefinition | undefined> = [...definitions];

  for (let index = 0; index < queue.length; index += 1) {
    const definition = queue[index];
    queue[index] = undefined;
    if (!definition) continue;
    let identity: PluginIdentity;
    try {
      identity = freezePluginIdentity(definition.identity);
    } catch (error) {
      failures.push({
        identity: Object.freeze({ name: "<invalid>" }),
        message: errorMessage(error),
      });
      continue;
    }

    let registrations: CommandRegistration[] | undefined = [];
    let children: PluginDefinition[] | undefined = [];
    const api: PluginAPI = Object.freeze({
      identity,
      env: options.env ?? process.env,
      dependencies: options.dependencies ?? coreDependencies,
      command(path: string | readonly string[], handler: CommandHandler) {
        if (!registrations) {
          throw new Error(
            `Plugin ${identity.name} cannot register commands after initialization`,
          );
        }
        registrations.push({ path, owner: identity, handler });
      },
      plugin(child: PluginDefinition) {
        if (!children) {
          throw new Error(
            `Plugin ${identity.name} cannot contribute plugins after initialization`,
          );
        }
        children.push(child);
      },
    });

    try {
      const plugin = await definition.load();
      if (typeof plugin !== "function") {
        throw new Error("Plugin definition must load a function");
      }
      await plugin(api);
      const stagedRegistrations = registrations;
      const stagedChildren = children;
      registrations = undefined;
      children = undefined;
      registry.registerBatch(stagedRegistrations);
      queue.push(...stagedChildren);
    } catch (error) {
      registrations = undefined;
      children = undefined;
      failures.push(Object.freeze({ identity, message: errorMessage(error) }));
    }
  }

  return Object.freeze(failures);
}
