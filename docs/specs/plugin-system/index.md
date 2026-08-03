# Plugin System

## Overview

The plugin system is a generic host for trusted plugins. Core code under `src/` owns plugin identity, contribution staging, initialization, and command dispatch only. Marketplace behavior is owned entirely by the bundled marketplace plugin outside `src/`; that plugin could be copied to another repository and consume only public `tx/plugin` types plus standard Node.js and Bun APIs.

The requirements below describe the approved target architecture. [Change 0003](../../changes/0003-externalize-marketplace-plugin.md) tracks the implementation gap.

## Requirements

### Generic Plugin Host

- Every plugin definition MUST have an immutable, marketplace-agnostic identity.
- A plugin definition MAY lazily provide child plugin definitions.
- The host MUST initialize root and child plugin definitions in deterministic FIFO order.
- Commands and child plugin definitions contributed during one plugin initialization MUST be staged atomically.
- If initialization succeeds, the host MUST commit all staged contributions together.
- If initialization fails, the host MUST discard all contributions staged by that plugin, report the failure against its generic identity, and continue initializing unrelated plugins.
- A failed plugin MUST NOT prevent commands committed by healthy plugins from dispatching.
- Command collisions MUST reject the later plugin's staged contribution without modifying previously committed commands.
- Plugins are trusted code and execute with the same process permissions as `tx`.

#### Scenario: Atomic initialization

- **GIVEN** a plugin stages commands and child definitions
- **WHEN** its initialization throws
- **THEN** none of those commands or child definitions become visible

#### Scenario: Deterministic child initialization

- **GIVEN** plugins contribute lazy child definitions in a known order
- **WHEN** the host initializes the plugin graph
- **THEN** definitions are initialized in deterministic FIFO order

#### Scenario: Failure isolation

- **GIVEN** one plugin fails and another plugin initializes successfully
- **WHEN** command dispatch begins
- **THEN** the healthy plugin's commands remain available and the failed plugin's diagnostic identifies only its generic plugin identity

### Public Plugin Contract

- The public package MUST expose the plugin contract through `tx/plugin`.
- The public contract MUST include generic plugin identity, lazy plugin definitions, initialization context, command registration, command context, and React, Ink, and version dependencies.
- Public plugin types and initialization context MUST NOT contain marketplace names, paths, manifests, storage services, Git services, dependency installers, or marketplace-specific diagnostics.
- Plugin identity MUST be assigned by the definition's owner and MUST NOT be mutable by the plugin during initialization.
- Initialization context MUST expose only generic host capabilities.
- A plugin MAY register any number of top-level or nested commands and MAY contribute any number of lazy child plugin definitions.
- Plugin initialization MAY be asynchronous.
- A minimal plugin MUST NOT require a package manifest, build step, or additional source file.

Conceptual public shape:

```ts
export interface PluginIdentity {
  readonly name: string
  readonly parent?: PluginIdentity
}

export interface PluginDefinition {
  readonly identity: PluginIdentity
  load(): Plugin | Promise<Plugin>
}

export interface PluginAPI {
  readonly identity: PluginIdentity
  readonly env: Readonly<Record<string, string | undefined>>
  readonly dependencies: CoreDependencies
  command(path: string | readonly string[], handler: CommandHandler): void
  plugin(definition: PluginDefinition): void
}

export type Plugin = (api: PluginAPI) => void | Promise<void>
```

The exact structural representation MAY vary, but it MUST preserve the owned contracts above.

#### Scenario: Marketplace-agnostic consumer

- **GIVEN** a plugin imports only public types from `tx/plugin`
- **WHEN** it initializes under the host
- **THEN** it can identify itself, register commands, contribute lazy children, and use injected React, Ink, and version dependencies without a marketplace-specific core API

### Command Registration and Dispatch

- Core and plugin commands MUST share one command tree.
- A string command path MUST be split on whitespace; an array path MUST use each array value as one segment.
- Command paths MUST contain at least one segment, and every segment MUST be non-empty after trimming.
- Registering an already owned command path MUST fail and identify both generic plugin owners.
- Dispatch MUST select the longest registered command path matching the start of the argument vector.
- The selected handler MUST receive remaining arguments and a generic command context.
- Root and nested help MUST include committed plugin commands.

#### Scenario: Nested registration

- **GIVEN** a plugin registers `['notes', 'daily', 'open']`
- **WHEN** the user runs `tx notes daily open today`
- **THEN** the registered handler receives `['today']`

#### Scenario: Collision

- **GIVEN** two plugins register `notes list`
- **WHEN** the later plugin initializes
- **THEN** its staged contributions are rejected with an error naming both generic plugin identities

### Generic Context and Dependencies

Each command handler MUST receive generic process and identity context. The context MUST NOT expose marketplace-specific fields.

```ts
export interface CommandContext {
  cwd: string
  env: Record<string, string | undefined>
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
  plugin: PluginIdentity
}
```

- The core MUST expose React, Ink, tx version metadata, and dependency version metadata through injected dependencies.
- Plugins using React or Ink MUST obtain the host instances from injected dependencies rather than importing separate runtime copies.
- Core MUST NOT publicly inject marketplace storage, paths, Git, manifests, discovery, installation, or recovery services.
- The context and dependencies MAY gain backward-compatible generic fields later.

#### Scenario: Shared Ink

- **GIVEN** a plugin obtains React and Ink from injected dependencies
- **WHEN** its command renders a TUI
- **THEN** it uses the same React and Ink module instances as the core

### Marketplace Plugin Ownership

- The default marketplace plugin MUST own marketplace storage, data paths, local names, `tx.marketplace.json`, discovery, ordering, dynamic imports, Git operations, Bun dependency installation, diagnostics and recovery mapping, and `marketplace add`, `marketplace list`, and `marketplace remove` behavior.
- The marketplace plugin MUST translate each discovered manifest entry into a lazy generic child plugin definition with an immutable generic identity.
- The marketplace plugin MUST define deterministic marketplace-name and manifest-entry ordering before contributing child definitions to the FIFO host.
- Marketplace discovery, import, or initialization failures MUST be mapped by the marketplace plugin into marketplace-aware diagnostics while preserving generic host failure isolation.
- Removing a broken marketplace MUST remain possible because the marketplace management commands are committed independently of discovered child failures.
- A marketplace MAY contain a `package.json`; when present, the marketplace plugin MUST install its dependencies from the marketplace root before plugin loading.
- In a compiled executable, the marketplace plugin MUST invoke Bun dependency installation through the running executable (`process.execPath`) with `BUN_BE_BUN=1` so installation does not depend on a separate `bun` executable on `PATH`.
- A marketplace without `package.json` MUST skip dependency installation.

The marketplace plugin owns the detailed marketplace command, manifest, path-safety, installation, and recovery contracts. Core consumes only the generic child definitions it contributes.

#### Scenario: Broken marketplace recovery

- **GIVEN** an installed marketplace child fails to import
- **WHEN** initialization completes
- **THEN** the marketplace plugin reports marketplace-aware recovery information while its management commands and healthy children remain available

#### Scenario: Compiled self-install

- **GIVEN** the compiled `tx` executable is running without a separate Bun executable on `PATH`
- **WHEN** a marketplace with `package.json` is added
- **THEN** dependency installation runs through the current executable in Bun mode and the marketplace can load

### Composition and Boundaries

- The repository composition root outside `src/` MUST provide the ordered default plugin definitions to the generic host.
- No module under `src/` MAY import, identify by name, or otherwise select a default plugin.
- No module under `src/` MAY import a marketplace plugin implementation module.
- A default plugin's complete module graph MUST NOT import core implementation modules under `src/`.
- Default plugins MAY import public `tx/plugin` types type-only and MAY use standard Node.js and Bun APIs directly.
- Plugin-owned nonliteral dynamic imports of plugin entry paths MUST be allowed.
- Boundary enforcement MUST continue to forbid any static or dynamic import from a plugin into core implementation and any import from core implementation into a default plugin.
- Copying the marketplace plugin to another repository MUST NOT require private core modules, repository-local aliases, or injected marketplace services.

#### Scenario: Externalizable marketplace plugin

- **GIVEN** the marketplace plugin's complete module graph
- **WHEN** its imports and runtime dependencies are inspected
- **THEN** it relies only on public `tx/plugin` types, standard Node.js and Bun APIs, and its own modules, including its owned nonliteral dynamic imports

## Design

### Ownership Boundary

The host accepts an ordered sequence of default definitions from a neutral composition root. Initialization uses a FIFO work queue. Each plugin receives a transaction-like staging API for commands and child definitions; successful initialization commits the stage, while failure drops it.

The marketplace plugin is an ordinary default plugin and a producer of lazy child definitions. It performs filesystem discovery and dynamic import only when those definitions load. The host has no marketplace vocabulary and reports failures in generic identity terms; the marketplace plugin owns translation into user-facing marketplace diagnostics.

### Package API

`tx/plugin` is the only core contract available to a portable plugin. Imports from that path SHOULD be type-only unless a future public runtime API is explicitly specified. React, Ink, and versions remain dependency-injected runtime values.

## Constraints

- Plugin sandboxing, signing, provenance, rollback, catalogs, and automatic updates are out of scope.
- One installed checkout represents a marketplace's current version.
- Per-plugin dependency environments within one marketplace are not required.
- Generic lifecycle hooks beyond initialization and command dispatch are out of scope.

## Open Questions

- A future plugin API MAY add command descriptions, structured flags, aliases, or additional generic lifecycle hooks after concrete plugins require them.
- Core dependency additions SHOULD be demand-driven and backward-compatible.

## References

- [Architecture](../architecture/)
- [Change 0003: Externalize Marketplace Plugin](../../changes/0003-externalize-marketplace-plugin.md)
- [Bun package manager](https://bun.sh/docs/pm/cli/install)
- [Bun runtime modules](https://bun.sh/docs/runtime/modules)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-02 | Initial desired plugin system | [0002-add-plugin-marketplaces](../../changes/0002-add-plugin-marketplaces.md) |
| 2026-08-02 | Made marketplace management a first-party plugin | [0002-add-plugin-marketplaces](../../changes/0002-add-plugin-marketplaces.md) |
| 2026-08-02 | Added broken-plugin recovery and stricter name and command validation | [0002-add-plugin-marketplaces](../../changes/0002-add-plugin-marketplaces.md) |
| 2026-08-02 | Required bundled first-party plugins to remain standalone from core implementation modules | [0002-add-plugin-marketplaces](../../changes/0002-add-plugin-marketplaces.md) |
| 2026-08-03 | Assigned all marketplace orchestration to an externalizable default plugin and reduced core to a generic transactional plugin host | [0003-externalize-marketplace-plugin](../../changes/0003-externalize-marketplace-plugin.md) |
