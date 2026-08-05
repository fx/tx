import type { Command } from "commander";
import * as commander from "commander";
import * as ink from "ink";
import * as react from "react";
import packageMetadata from "../package.json" with { type: "json" };
import {
  freezePluginIdentity,
  identityName,
  type PluginNamespace,
} from "./commands.ts";
import { type CommandProcessContext, createProcessContext } from "./context.ts";
import type {
  CoreDependencies,
  PluginAPI,
  PluginDefinition,
  PluginIdentity,
} from "./plugin.ts";

export const coreDependencies: CoreDependencies = Object.freeze({
  tx: Object.freeze({ version: packageMetadata.version }),
  react,
  ink,
  commander,
  versions: Object.freeze({
    react: packageMetadata.dependencies.react,
    ink: packageMetadata.dependencies.ink,
    commander: packageMetadata.dependencies.commander,
  }),
});

export interface PluginLoadFailure {
  readonly identity: PluginIdentity;
  readonly message: string;
}

export interface InitializePluginsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly context?: CommandProcessContext;
  readonly dependencies?: CoreDependencies;
}

export interface InitializedPlugins {
  readonly namespaces: readonly PluginNamespace[];
  readonly failures: readonly PluginLoadFailure[];
}

/** Non-empty, whitespace-free, and never confusable with an option. */
const namespaceNamePattern = /^[^\s-]\S*$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isThenable(value: unknown): boolean {
  return (
    typeof (value as { then?: unknown } | null | undefined)?.then === "function"
  );
}

function claimNamespace(
  identity: PluginIdentity,
  dependencies: CoreDependencies,
): Command {
  if (!namespaceNamePattern.test(identity.name)) {
    throw new Error(
      `Plugin ${identityName(identity)} cannot claim namespace "${identity.name}"; a namespace name must not be empty, contain whitespace, or begin with "-"`,
    );
  }
  return new dependencies.commander.Command(identity.name);
}

/**
 * Verify the plugin left its namespace reachable under exactly its identity
 * name. Handing the plugin a live command object would otherwise let it
 * reclaim the naming decision the host owns.
 */
function verifyNamespaceName(namespace: Command, identity: PluginIdentity) {
  if (namespace.name() !== identity.name) {
    throw new Error(
      `Plugin ${identityName(identity)} renamed its namespace to "${namespace.name()}"; a namespace must stay reachable as "${identity.name}"`,
    );
  }
  const aliases = namespace.aliases();
  if (aliases.length > 0) {
    throw new Error(
      `Plugin ${identityName(identity)} aliased its namespace as ${aliases.map((alias) => `"${alias}"`).join(", ")}; a namespace must stay reachable only as "${identity.name}"`,
    );
  }
}

export async function initializePlugins(
  definitions: readonly PluginDefinition[] = [],
  options: InitializePluginsOptions = {},
): Promise<InitializedPlugins> {
  const processContext = options.context ?? createProcessContext();
  // One environment for both `PluginAPI.env` and the command context, so an
  // injected environment cannot reach one and miss the other.
  const env = (options.env ?? processContext.env) as Record<
    string,
    string | undefined
  >;
  const dependencies = options.dependencies ?? coreDependencies;
  const namespaces: PluginNamespace[] = [];
  const claimed = new Map<string, PluginNamespace>();
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

    let staging = true;
    let namespace: Command | undefined;
    let violation: Error | undefined;
    const children: PluginDefinition[] = [];
    const api: PluginAPI = Object.freeze({
      identity,
      env,
      context: { ...processContext, env, plugin: identity },
      dependencies,
      command(build: (namespace: Command) => void) {
        if (!staging) {
          throw new Error(
            `Plugin ${identity.name} cannot register commands after initialization`,
          );
        }
        namespace ??= claimNamespace(identity, dependencies);
        const result: unknown = build(namespace);
        if (isThenable(result)) {
          // The builder's own promise stays the plugin's business, but an
          // unobserved rejection would fault the host, so its outcome is
          // swallowed here. The violation is remembered as well as thrown,
          // so catching the throw cannot commit the contribution anyway.
          void Promise.resolve(result).catch(() => {});
          violation ??= new Error(
            `Plugin ${identity.name} must build its namespace synchronously; the builder returned a promise`,
          );
          throw violation;
        }
      },
      plugin(child: PluginDefinition) {
        if (!staging) {
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
      staging = false;
      if (violation) throw violation;

      if (namespace) {
        verifyNamespaceName(namespace, identity);
        const owner = claimed.get(identity.name);
        if (owner) {
          throw new Error(
            `Namespace "${identity.name}" is already claimed by ${identityName(owner.identity)}; cannot claim it for ${identityName(identity)}`,
          );
        }
        const contribution = Object.freeze({ identity, command: namespace });
        claimed.set(identity.name, contribution);
        namespaces.push(contribution);
      }

      queue.push(...children);
    } catch (error) {
      staging = false;
      failures.push(Object.freeze({ identity, message: errorMessage(error) }));
    }
  }

  return Object.freeze({
    namespaces: Object.freeze(namespaces),
    failures: Object.freeze(failures),
  });
}
