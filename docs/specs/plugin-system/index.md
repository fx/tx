# Plugin System

## Overview

The plugin system lets the public `tx` core load personal commands from private or public Git repositories. A marketplace is one Git repository containing one or more plugins. A minimal plugin MUST be able to consist of a single TypeScript file.

The system is not yet implemented. This document defines the initial desired behavior.

## Requirements

### First-Party Plugins

- User-facing features shipped with the core repository MUST use the same `Plugin` function contract and command-registration API as marketplace plugins.
- Bundled first-party plugin source MUST live under `plugins/<name>/` at the repository root.
- The entire module graph rooted at a bundled first-party plugin entry MUST NOT import implementation modules from `src/`.
- Bundled first-party plugins MUST consume core capabilities only through the public `PluginAPI` and its injected dependencies. They MAY import standard Node.js or Bun APIs, and they MAY import types from `tx/plugin`.
- Core modules MAY statically import only a bundled plugin's entry module for bundling and registration; they MUST NOT statically import any other module in that plugin's module graph.
- First-party plugins MUST pass through the same registration, ownership, collision, help, and dispatch logic as marketplace plugins.
- First-party plugins MUST be bundled with the core executable and MUST load before installed marketplace plugins.
- The `marketplace` command tree MUST be registered by a first-party plugin named `marketplace`.
- The command dispatcher MUST NOT contain marketplace-specific command branches.

#### Scenario: Marketplace dogfooding

- **GIVEN** no external marketplaces are installed
- **WHEN** `tx` starts
- **THEN** the bundled `marketplace` plugin registers `marketplace add`, `marketplace list`, and `marketplace remove` through the normal plugin API

#### Scenario: Uniform collision handling

- **GIVEN** an external plugin attempts to register `marketplace add`
- **WHEN** plugins are loaded
- **THEN** normal command-collision handling rejects it and identifies both plugin owners

#### Scenario: Standalone bundled plugin boundary

- **GIVEN** the repository's bundled first-party plugin entries and every module reachable from each entry
- **WHEN** their static imports are inspected
- **THEN** every bundled plugin is rooted under `plugins/<name>/`, no module in its graph imports a `src/` implementation module, any `tx/plugin` import is type-only, and core imports only each plugin entry module for bundling and registration

### Marketplace Management

- `tx marketplace add <repository>` MUST install a marketplace from a Git repository URL or Git-compatible repository reference.
- Adding a marketplace MUST clone it into the `tx` user data directory.
- A marketplace MUST be identified by a stable local name.
- A marketplace name MUST be one safe path component matching `[A-Za-z0-9][A-Za-z0-9._-]*` and MUST NOT be `.` or `..`.
- Add and remove operations MUST verify that the resolved marketplace path remains inside the marketplace storage directory.
- The name SHOULD default from the repository name and MAY be overridden with `--name`.
- Adding a marketplace whose name already exists MUST fail without replacing it.
- `tx marketplace list` MUST show installed marketplace names and sources.
- `tx marketplace remove <name>` MUST remove that checkout and make its plugins unavailable.
- The initial implementation MAY rely on the user's existing Git and SSH configuration for private repository access.

#### Scenario: Add private marketplace

- **GIVEN** the user can clone a private repository through their existing Git configuration
- **WHEN** they run `tx marketplace add git@github.com:me/tx-plugins.git`
- **THEN** the repository is cloned and its valid plugins become available on the next command dispatch

#### Scenario: Duplicate marketplace

- **GIVEN** marketplace `tx-plugins` is installed
- **WHEN** the user adds another marketplace with the same local name
- **THEN** the command fails and the existing checkout is unchanged

#### Scenario: Invalid marketplace name

- **GIVEN** a repository is available
- **WHEN** the user adds it with the exact name `..` or with a name containing a path separator
- **THEN** the command fails without writing outside the marketplace storage directory

#### Scenario: Remove marketplace

- **GIVEN** a command is provided by marketplace `personal`
- **WHEN** the user runs `tx marketplace remove personal`
- **THEN** the marketplace is removed and that command is no longer available

### Marketplace Layout

- A marketplace MUST contain `tx.marketplace.json` at its root.
- The manifest MUST contain a non-empty `plugins` array.
- Each plugin entry MUST declare a unique `name` and an `entry` path relative to the repository root.
- Multiple plugin entries MAY point to files in different directories.
- Unknown manifest fields SHOULD be ignored for forward compatibility.
- Invalid manifests or missing entry files MUST make marketplace installation fail with a useful error.

Example:

```json
{
  "plugins": [
    { "name": "notes", "entry": "plugins/notes.ts" },
    { "name": "work", "entry": "plugins/work/index.ts" }
  ]
}
```

#### Scenario: Multiple plugins

- **GIVEN** a marketplace manifest lists two valid plugin entries
- **WHEN** the marketplace is added
- **THEN** commands from both plugins are registered

### Plugin Module Contract

- A plugin entry MUST export a default plugin function.
- The core MUST call the function with a plugin API object.
- The plugin function MAY register any number of commands.
- A minimal plugin MUST NOT require a package manifest, build step, or additional source file.
- Plugin initialization MAY be asynchronous.

The public contract is:

```ts
export type CommandHandler = (
  args: string[],
  context: CommandContext,
) => void | Promise<void>

export interface PluginAPI {
  command(path: string | string[], handler: CommandHandler): void
  dependencies: CoreDependencies
}

export type Plugin = (api: PluginAPI) => void | Promise<void>
```

A minimal plugin is:

```ts
import type {Plugin} from 'tx/plugin'

const plugin: Plugin = ({command}) => {
  command('hello', async (args, context) => {
    context.stdout.write(`Hello ${args[0] ?? 'world'}\n`)
  })
}

export default plugin
```

#### Scenario: Single-file plugin

- **GIVEN** a marketplace lists one TypeScript file exporting a valid plugin function
- **WHEN** `tx` loads installed plugins
- **THEN** the function runs and its registered commands appear in root help

#### Scenario: Invalid export

- **GIVEN** a plugin entry does not export a function
- **WHEN** `tx` loads it
- **THEN** `tx` reports the marketplace and plugin name and exits non-zero

### Command Registration

- A plugin MAY register a top-level command such as `notes`.
- A plugin MAY register nested commands such as `notes daily open`.
- A string command path MUST be split on whitespace; an array path MUST use each array value as one segment.
- Command paths MUST contain at least one segment, and every segment MUST be non-empty after trimming.
- Registering a command path already owned by another first-party or marketplace plugin MUST fail and identify both owners.
- Plugin commands MUST appear in normal root and nested help output.

#### Scenario: Nested registration

- **GIVEN** a plugin registers `['notes', 'daily', 'open']`
- **WHEN** the user runs `tx notes daily open today`
- **THEN** the registered handler receives `['today']`

#### Scenario: Collision

- **GIVEN** two plugins register `notes list`
- **WHEN** plugins are loaded
- **THEN** loading fails with an error naming the command and both plugins

### Command Context

Each handler MUST receive a context containing:

```ts
export interface CommandContext {
  cwd: string
  env: Record<string, string | undefined>
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
  marketplace: string
  plugin: string
}
```

The context MAY gain additional backward-compatible fields later. First-party plugins receive `context.marketplace` as `core`; the bundled marketplace plugin receives `context.plugin` as `marketplace`.

### Injected Core Dependencies

- The core MUST expose a versioned set of shared dependencies through `api.dependencies`.
- The initial dependency set MUST include the core's React and Ink instances.
- Plugins using the core renderer dependencies MUST obtain them from this object rather than importing separate copies.
- A dependency not supplied by the core MAY be installed inside the marketplace repository and imported normally by the plugin.
- The core MUST expose its own version and the injected dependency versions.

Initial shape:

```ts
export interface CoreDependencies {
  tx: {version: string}
  react: typeof import('react')
  ink: typeof import('ink')
  versions: {
    react: string
    ink: string
  }
}
```

Example:

```ts
import type {Plugin} from 'tx/plugin'

const plugin: Plugin = ({command, dependencies}) => {
  const {react, ink} = dependencies

  command('dashboard', async () => {
    const App = () => react.createElement(ink.Text, null, 'Hello from Ink')
    const instance = ink.render(react.createElement(App))
    await instance.waitUntilExit()
  })
}

export default plugin
```

#### Scenario: Shared Ink

- **GIVEN** a plugin obtains React and Ink from `api.dependencies`
- **WHEN** its command renders a TUI
- **THEN** it uses the same React and Ink module instances as the core

### Marketplace Dependencies

- A marketplace MAY contain a `package.json` and Bun lockfile.
- When a marketplace declares dependencies, adding it MUST install them before loading plugins.
- Dependency installation MUST run from the marketplace root.
- A marketplace without `package.json` MUST skip dependency installation.
- Plugin-specific dependency isolation inside one marketplace is not required initially.

#### Scenario: Marketplace dependency

- **GIVEN** a marketplace declares an npm dependency used by a plugin
- **WHEN** the marketplace is added
- **THEN** the dependency is installed and the plugin can import it

### Loading Lifecycle

- First-party and marketplace plugin modules MUST be initialized by one shared loader.
- Bundled first-party plugins MUST load before installed marketplaces.
- Installed marketplaces MUST be discovered when `tx` starts.
- Marketplace manifests and plugin entry modules MUST be attempted before dispatch.
- A failure in an installed marketplace plugin MUST be reported but MUST NOT prevent first-party commands or plugins from other marketplaces from dispatching.
- A plugin that fails to load MUST register no commands for that run.
- The first-party marketplace plugin MUST remain usable to remove a broken marketplace.
- Marketplace plugins MUST load in marketplace-name order and manifest order for deterministic diagnostics.
- Command collisions MUST fail the later conflicting plugin rather than disable already registered first-party commands.
- Plugins are trusted code and execute with the same process permissions as `tx`.

#### Scenario: Remove a broken marketplace

- **GIVEN** an installed marketplace contains a plugin that no longer loads
- **WHEN** `tx` starts
- **THEN** it reports that plugin failure while keeping `tx marketplace remove <name>` available

## Design

### Stored Layout

```text
<tx-data>/
  marketplaces/
    personal/
      repository checkout
```

A separate generated registry or database is not required initially; installed marketplace directories are the source of truth.

### Installation Flow

1. Determine the local marketplace name.
2. Clone the repository into a temporary sibling directory.
3. Read and validate `tx.marketplace.json`.
4. Install dependencies when `package.json` exists.
5. Move the completed checkout into the marketplaces directory.
6. Remove the temporary directory if any step fails.

### Package API

The public core package SHOULD expose plugin types through `tx/plugin`. Runtime plugins MUST receive core capabilities through the `PluginAPI` argument rather than importing core implementation modules. A shared loader accepts either a statically imported bundled-plugin entry function or a dynamically imported marketplace plugin function, assigns its owner, and invokes the same `PluginAPI` contract.

## Constraints

- Plugins are trusted personal code; sandboxing is out of scope.
- Marketplace signing, checksums, provenance, version solving, catalogs, and automatic updates are out of scope.
- One installed checkout represents the marketplace's current version.
- The first version MAY support only Git clone and remove; update MAY be added later.

## Open Questions

- `tx marketplace update` is intentionally deferred.
- A future plugin API MAY add command descriptions, structured flags, aliases, or lifecycle hooks after concrete plugins require them.
- Core dependency additions SHOULD be demand-driven and backward-compatible.

## References

- [Architecture](../architecture/)
- [Bun package manager](https://bun.sh/docs/pm/cli/install)
- [Bun runtime modules](https://bun.sh/docs/runtime/modules)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-02 | Initial desired plugin system | [0002-add-plugin-marketplaces](../../changes/0002-add-plugin-marketplaces.md) |
| 2026-08-02 | Made marketplace management a first-party plugin | [0002-add-plugin-marketplaces](../../changes/0002-add-plugin-marketplaces.md) |
| 2026-08-02 | Added broken-plugin recovery and stricter name and command validation | [0002-add-plugin-marketplaces](../../changes/0002-add-plugin-marketplaces.md) |
| 2026-08-02 | Required bundled first-party plugins to remain standalone from core implementation modules | [0002-add-plugin-marketplaces](../../changes/0002-add-plugin-marketplaces.md) |
