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
  UpdateParticipant,
  UpdateParticipation,
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

function namespaceClaimError(identity: PluginIdentity): Error | undefined {
  return namespaceNamePattern.test(identity.name)
    ? undefined
    : new Error(
        `Plugin ${identityName(identity)} cannot claim namespace "${identity.name}"; a namespace name must not be empty, contain whitespace, or begin with "-"`,
      );
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
  const entries: Array<readonly [string, unknown]> = [];
  const participants: UpdateParticipation[] = [];
  const registrations = <T>(key: string): readonly T[] =>
    Object.freeze(
      entries
        .filter(([registeredKey]) => registeredKey === key)
        .map(([, value]) => value as T),
    );
  // Read at call time rather than delivered at initialization: a plugin that
  // reads during its own initialization sees only what was committed before
  // it, which is why a driver reads them when its command runs.
  const updaters = (): readonly UpdateParticipation[] =>
    Object.freeze([...participants]);
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
    let initialization: Promise<void> | undefined;
    let namespace: Command | undefined;
    let violation: Error | undefined;
    const children: PluginDefinition[] = [];
    const stagedEntries: Array<readonly [string, unknown]> = [];
    const staged: UpdateParticipation[] = [];
    /**
     * Remember a registration violation as well as raising it. A plugin that
     * catches the throw must still fail rather than commit what it staged.
     */
    const reject = (error: Error): never => {
      violation ??= error;
      throw violation;
    };
    /** Staging is over once initialization returns, for every contribution. */
    const closed = (contribution: string): Error =>
      new Error(
        `Plugin ${identity.name} cannot ${contribution} after initialization`,
      );
    const ensureStaging = (contribution: string): void => {
      if (
        !staging ||
        (initialization && Bun.peek.status(initialization) !== "pending")
      ) {
        throw closed(contribution);
      }
    };
    const api: PluginAPI = Object.freeze({
      identity,
      env,
      context: { ...processContext, env, plugin: identity },
      dependencies,
      command(build: (namespace: Command) => void) {
        ensureStaging("register commands");
        if (!namespace) {
          const claimError = namespaceClaimError(identity);
          if (claimError) reject(claimError);
          namespace = new dependencies.commander.Command(identity.name);
        }
        const result: unknown = build(namespace);
        if (isThenable(result)) {
          // The builder's own promise stays the plugin's business, but an
          // unobserved rejection would fault the host, so its outcome is
          // swallowed here.
          void Promise.resolve(result).catch(() => {});
          reject(
            new Error(
              `Plugin ${identity.name} must build its namespace synchronously; the builder returned a promise`,
            ),
          );
        }
      },
      plugin(child: PluginDefinition) {
        ensureStaging("contribute plugins");
        children.push(child);
      },
      register<T>(key: string, value: T) {
        ensureStaging("register values");
        stagedEntries.push([key, value]);
      },
      registrations,
      update(participant: UpdateParticipant) {
        ensureStaging("contribute update participants");
        staged.push(Object.freeze({ identity, participant }));
      },
      updaters,
    });

    try {
      const plugin = await definition.load();
      if (typeof plugin !== "function") {
        throw new Error("Plugin definition must load a function");
      }
      const result = plugin(api);
      if (isThenable(result)) {
        initialization = Promise.resolve(result);
        await initialization;
      }
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

      for (const entry of stagedEntries) entries.push(entry);
      for (const participation of staged) participants.push(participation);
      for (const child of children) queue.push(child);
    } catch (error) {
      failures.push(Object.freeze({ identity, message: errorMessage(error) }));
    } finally {
      staging = false;
      initialization = undefined;
      namespace = undefined;
      violation = undefined;
      children.length = 0;
      stagedEntries.length = 0;
      staged.length = 0;
    }
  }

  return Object.freeze({
    namespaces: Object.freeze(namespaces),
    failures: Object.freeze(failures),
  });
}
