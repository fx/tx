/// <reference types="node" />

import type { Command } from "commander";
import type { CommandContext } from "./context.ts";

export type { Command } from "commander";
export type { CommandContext } from "./context.ts";

export interface PluginIdentity {
  readonly name: string;
  readonly parent?: PluginIdentity;
}

export interface CoreDependencies {
  readonly tx: {
    readonly version: string;
  };
  readonly react: typeof import("react");
  readonly ink: typeof import("ink");
  readonly commander: typeof import("commander");
  readonly versions: {
    readonly react: string;
    readonly ink: string;
    readonly commander: string;
  };
}

export interface PluginDefinition {
  readonly identity: PluginIdentity;
  load(): Plugin | Promise<Plugin>;
}

/**
 * One thing a participant found. Every label is opaque to the host and to
 * whoever drives the participants; an absent `available` means there is
 * nothing to apply, and a `failure` means this one thing is unusable while
 * the participant's other items remain reportable.
 */
export interface UpdateItem {
  readonly name: string;
  readonly current: string;
  readonly available?: string;
  readonly detail?: string;
  readonly failure?: string;
}

/** The outcome of applying one item. Returning it means the participant
 * handled the item; `applied` separates having changed something from having
 * deliberately changed nothing. Throwing means it did not handle the item. */
export interface UpdateResult {
  readonly applied: boolean;
  readonly version?: string;
  readonly detail?: string;
}

export interface UpdateParticipant {
  gather(): Promise<readonly UpdateItem[]> | readonly UpdateItem[];
  apply(item: UpdateItem): Promise<UpdateResult> | UpdateResult;
}

/** A committed participant carrying the identity of the plugin that
 * contributed it, so a driver can report its failure without it naming
 * itself. */
export interface UpdateParticipation {
  readonly identity: PluginIdentity;
  readonly participant: UpdateParticipant;
}

export interface PluginAPI {
  readonly identity: PluginIdentity;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly context: CommandContext;
  readonly dependencies: CoreDependencies;
  command(build: (namespace: Command) => void): void;
  plugin(definition: PluginDefinition): void;
  register<T>(key: string, value: T): void;
  registrations<T>(key: string): readonly T[];
  update(participant: UpdateParticipant): void;
  /** What is committed at the moment of the call, in commit order. */
  updaters(): readonly UpdateParticipation[];
}

export type Plugin = (api: PluginAPI) => void | Promise<void>;
