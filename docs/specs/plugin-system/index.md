# Plugin System

## Overview

The plugin system is a generic host for trusted plugins. Core code under `src/` owns plugin identity, contribution staging, initialization, and command dispatch only. Marketplace behavior is owned entirely by the bundled marketplace plugin outside `src/`; that plugin could be copied to another repository and consume only public `@fx/tx/plugin` types plus standard Node.js and Bun APIs.

The approved target architecture is implemented: the core is generic, the marketplace boundary is fully plugin-owned as specified in [Change 0003](../../changes/0003-externalize-marketplace-plugin.md), and the canonical package API is scoped as specified in [Change 0004](../../changes/0004-automate-versioning-and-publishing.md).

The namespace ownership model below — one namespace per plugin, named after its identity, with the plugin owning every argument inside it — is specified but **not yet implemented**. It is planned in [Change 0007](../../changes/0007-delegate-dispatch-to-plugins.md). Until that change lands, a plugin registers arbitrary whitespace-separated command paths and the host interprets help itself.

## Requirements

### Generic Plugin Host

- Every plugin definition MUST have an immutable, marketplace-agnostic identity.
- A plugin definition MAY lazily provide child plugin definitions.
- The host MUST initialize root and child plugin definitions in deterministic FIFO order.
- Commands and child plugin definitions contributed during one plugin initialization MUST be staged atomically.
- If initialization succeeds, the host MUST commit all staged contributions together.
- If initialization fails, the host MUST discard all contributions staged by that plugin, report the failure on standard error against its generic identity, and continue initializing unrelated plugins.
- A failed plugin MUST NOT prevent commands committed by healthy plugins from dispatching.
- A failed plugin MUST NOT change the process exit code; the exit code MUST be the result of the dispatched command alone.
- Because a failed plugin's namespace is never committed, invoking it MUST NOT run any command that plugin staged; the invocation MUST resolve as an unrecognized namespace.
- Namespace collisions MUST reject the later plugin's staged contribution without modifying previously committed namespaces.
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

#### Scenario: Failure exit code isolation

- **GIVEN** one plugin fails to initialize and the invocation resolves to a committed command
- **WHEN** dispatch produces that command's exit code
- **THEN** the host reports the failure on standard error and exits with that exit code, whatever it is

### Public Plugin Contract

- The public package MUST expose the plugin contract through `@fx/tx/plugin`.
- The public contract MUST include generic plugin identity, lazy plugin definitions, initialization context, namespace registration, command context, and React, Ink, command-parser, and version dependencies.
- Public plugin types and initialization context MUST NOT contain marketplace names, paths, manifests, storage services, Git services, dependency installers, or marketplace-specific diagnostics.
- Plugin identity MUST be assigned by the definition's owner and MUST NOT be mutable by the plugin during initialization.
- Initialization context MUST expose only generic host capabilities.
- A plugin that defines no commands MUST NOT claim a namespace.
- A plugin that defines commands MUST claim exactly one, and it MUST be the plugin's own identity name. A plugin MUST NOT choose, alias, or add a second namespace, and a nested plugin's namespace MUST come from its own name rather than its parent chain.
- A plugin MAY define commands, subcommands of arbitrary depth, arguments, options, aliases, and descriptions inside its namespace, and MAY contribute any number of lazy child plugin definitions.
- An identity name claiming a namespace MUST be non-empty after trimming, MUST NOT contain whitespace, and MUST NOT begin with `-`. A name that is not MUST be rejected as a plugin failure rather than trimmed, escaped, or otherwise reshaped.
- The host MUST verify, before committing a contribution, that the staged namespace is still reachable under exactly the plugin's identity name and under no other name. A plugin that renames its namespace, gives it an alias, or otherwise makes it reachable under a second name MUST be rejected as a plugin failure. Supplying the namespace pre-built MUST NOT become a way to reclaim the naming decision the host owns.
- A namespace builder MUST complete before the registration call returns, and a builder that returns a thenable MUST be rejected as a plugin failure. Plugin initialization itself MAY still be asynchronous around the call.
- A staged namespace MUST be treated as final at the moment its builder returns. The host MUST commit what the namespace holds at that point; a plugin MUST NOT rely on mutations made afterwards, and the host is NOT required to detect them. Plugins are trusted in-process code, so a plugin that keeps a reference cannot be prevented from touching it later — the contract states what the host honours, not what a plugin is physically incapable of.
- Whatever the host applies to the committed tree before dispatch MUST cover every command reachable at that moment, however late it was added. No command reachable when dispatch begins may escape it.
- The host MUST give a plugin its namespace already constructed, so defining commands, options, arguments, and help MUST NOT require the plugin to import, install, or construct the command parser.
- A plugin that wants direct parser access MUST obtain it from injected dependencies, so it shares the host's instance.
- The initialization API MUST expose the command context to the plugin, so a command can reach process streams, environment, working directory, and owning identity without the host prescribing a signature for the plugin's own command implementations.
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
  readonly context: CommandContext
  readonly dependencies: CoreDependencies
  command(build: (namespace: Command) => void): void
  plugin(definition: PluginDefinition): void
}

export type Plugin = (api: PluginAPI) => void | Promise<void>
```

`Command` is the injected parser's command type, re-exported from `@fx/tx/plugin` so a plugin can type its builder without declaring a parser dependency of its own. A plugin MAY call `command` more than once; each call MUST receive that plugin's one namespace, so contributions accumulate rather than replace.

The `void` return on `build` is a contract, not a formality. A language that accepts an asynchronous function wherever a void-returning one is expected will happily let an `async` builder return at its first `await`, leaving the rest of its work to land after the host has moved on — so the host rejects a thenable return rather than trusting the signature.

That check catches the accident, not every possibility: a synchronous builder can still schedule work and return cleanly, and no return-value inspection can see that. The guarantee therefore does not rest on detection. It rests on *when* the host reads the tree — finality at builder return, and a pre-dispatch pass that covers everything reachable by then, whenever it arrived.

The exact structural representation MAY vary, but it MUST preserve the owned contracts above.

#### Scenario: Marketplace-agnostic consumer

- **GIVEN** a plugin imports only public types from `@fx/tx/plugin`
- **WHEN** it initializes under the host
- **THEN** it can identify itself, define its namespace, contribute lazy children, and use injected React, Ink, parser, and version dependencies without a marketplace-specific core API

#### Scenario: Namespace follows identity

- **GIVEN** a marketplace contributes a child plugin whose identity name is `notes`
- **WHEN** the host commits its contribution
- **THEN** its commands are reachable under `tx notes` regardless of which marketplace or parent plugin produced it

#### Scenario: Plugin authored without the parser

- **GIVEN** a plugin defines commands and options using only the namespace the host supplies
- **WHEN** it is built and type-checked as an external consumer
- **THEN** it needs no parser dependency, package manifest, or build step of its own

### Namespace Ownership

What a user can type and what the CLI does with it — argument delegation, help, output routing, and exit codes — is owned by [Architecture: Core CLI](../architecture/index.md#core-cli) and is not restated here. This section owns only how a namespace comes to exist and who holds it.

- A namespace MUST become reachable only when the plugin that claims it is committed.
- Claiming an already committed namespace MUST fail and identify both generic plugin owners.
- A plugin MAY supply a description for its namespace.

#### Scenario: Namespace collision

- **GIVEN** a committed plugin has the identity name `notes`
- **WHEN** a later definition with the same identity name initializes
- **THEN** its staged contributions are rejected with an error naming both generic plugin identities

### Generic Context and Dependencies

Every command MUST be able to reach generic process and identity context through the initialization API, whatever signature the plugin gives its own command implementations. The context MUST NOT expose marketplace-specific fields.

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

- The core MUST expose React, Ink, the command parser, tx version metadata, and dependency version metadata through injected dependencies.
- Plugins using React, Ink, or the command parser MUST obtain the host instances from injected dependencies rather than importing separate runtime copies.
- Core MUST NOT publicly inject marketplace storage, paths, Git, manifests, discovery, installation, or recovery services.
- The context and dependencies MAY gain backward-compatible generic fields later.

#### Scenario: Shared Ink

- **GIVEN** a plugin obtains React and Ink from injected dependencies
- **WHEN** its command renders a TUI
- **THEN** it uses the same React and Ink module instances as the core

#### Scenario: Shared parser

- **GIVEN** a plugin obtains the command parser from injected dependencies and builds a command detached from its namespace
- **WHEN** it attaches that command to its namespace
- **THEN** the host recognizes it as its own parser's command and dispatches it like any other

### Marketplace Plugin Ownership

- The default marketplace plugin MUST own marketplace storage, data paths, local names, repository-local `.tx/config.json`, discovery, ordering, dynamic imports, Git operations, Bun dependency installation, diagnostics and recovery mapping, and `marketplace add`, `marketplace list`, and `marketplace remove` behavior.
- `.tx/config.json` MUST contain the marketplace `plugins` array, MAY contain additional repository configuration, and MUST resolve plugin entries relative to the repository root.
- Installed marketplaces that predate `.tx/config.json` MUST remain loadable through the legacy root `tx.marketplace.json` manifest; when both files exist, `.tx/config.json` MUST take precedence.
- `marketplace add` MUST accept Git clone sources and expand bare GitHub `owner/repository` shorthand to its HTTPS clone source.
- Automatically loading `.tx/config.json` from the current working repository is out of scope.
- The marketplace plugin MUST translate each configured plugin entry into a lazy generic child plugin definition with an immutable generic identity.
- The marketplace plugin MUST define deterministic marketplace-name and manifest-entry ordering before contributing child definitions to the FIFO host.
- Marketplace discovery, import, or initialization failures MUST be mapped by the marketplace plugin into marketplace-aware diagnostics while preserving generic host failure isolation.
- Removing a broken marketplace MUST remain possible because the marketplace management commands are committed independently of discovered child failures.
- Each configured plugin entry MAY declare an optional `package` field containing a repository-relative path to the exact `package.json` selected for that plugin.
- Without `package`, the selected candidate MUST be `package.json` in the directory containing the plugin's real, fully resolved entry path. A nested entry MUST NOT search parent directories or fall back to the marketplace root.
- An explicit `package` value MUST be a non-empty string, MUST be repository-relative, MUST remain within the real marketplace checkout, and MUST name `package.json` exactly. Absolute paths, lexical escapes, directories, other filenames, and symbolic links resolving outside the checkout MUST be rejected.
- A syntactically valid, repository-contained explicit `package` path whose file is genuinely absent MUST skip dependency installation. Before classifying it as absent, the deepest existing ancestor MUST resolve within the real checkout so a symbolic-link escape cannot become a skip.
- Every selected package candidate that exists MUST resolve to a contained regular file. Existing manifests MUST be canonicalized by real path, installed at most once, and installed sequentially in the order of the first configured plugin selecting each manifest.
- The marketplace manifest, every plugin entry, and every selected package candidate MUST be validated before the first installation starts. Each installation MUST run with the selected real manifest's containing directory as its working directory.
- Marketplace addition MUST remove staging and publish no checkout when validation or trusted dependency installation fails.
- In a compiled executable, the marketplace plugin MUST invoke Bun dependency installation through the running executable (`process.execPath`) with `BUN_BE_BUN=1` so installation does not depend on a separate `bun` executable on `PATH`.

The marketplace plugin owns the detailed marketplace command, manifest, path-safety, installation, and recovery contracts. Core consumes only the generic child definitions it contributes.

#### Scenario: Broken marketplace recovery

- **GIVEN** an installed marketplace child fails to import
- **WHEN** initialization completes
- **THEN** the marketplace plugin reports marketplace-aware recovery information while its management commands and healthy children remain available

#### Scenario: Default root package

- **GIVEN** a plugin entry resolves to a file in the marketplace root and no `package` override is declared
- **WHEN** the marketplace is prepared
- **THEN** the root `package.json` is selected if present

#### Scenario: Nested default does not search upward

- **GIVEN** a plugin entry resolves under `plugins/notes/`, no `package` override is declared, and only the marketplace-root `package.json` exists
- **WHEN** the marketplace is prepared
- **THEN** dependency installation is skipped for that plugin without searching upward or falling back to the root manifest

#### Scenario: Exact explicit override

- **GIVEN** a nested plugin declares a repository-relative `package` path to a contained regular `package.json`
- **WHEN** the marketplace is prepared
- **THEN** dependencies are installed from that manifest's directory

#### Scenario: Missing explicit override

- **GIVEN** a plugin declares a syntactically valid repository-contained path ending in `package.json` and that file is genuinely absent
- **WHEN** the marketplace is prepared
- **THEN** dependency installation is skipped for that plugin

#### Scenario: Invalid explicit override

- **GIVEN** a plugin's `package` value has the wrong type, is empty or absolute, escapes the marketplace, names a directory or a filename other than `package.json`, or resolves through a symbolic link outside the marketplace
- **WHEN** the marketplace manifest is validated
- **THEN** preparation is rejected before any dependency installation starts

#### Scenario: Deduplicated first-occurrence order

- **GIVEN** multiple plugins select package manifests and more than one selection resolves to the same real manifest
- **WHEN** the marketplace is prepared
- **THEN** each real manifest is installed once, sequentially, in the order of the first plugin that selected it

#### Scenario: Validate before install

- **GIVEN** an earlier plugin selects a valid package manifest and a later plugin has an invalid entry or package selection
- **WHEN** the marketplace is prepared
- **THEN** validation fails before the earlier plugin's dependency installation can run

#### Scenario: Failed trusted lifecycle

- **GIVEN** a selected manifest's trusted dependency installation or lifecycle script fails in marketplace staging
- **WHEN** marketplace addition aborts
- **THEN** the staging checkout is removed, no installed checkout is published, and the failure is reported through marketplace-owned diagnostics

#### Scenario: Compiled self-install

- **GIVEN** the compiled `tx` executable is running without a separate Bun executable on `PATH`
- **WHEN** a selected per-plugin manifest requires dependency installation
- **THEN** installation runs through the current executable in Bun mode from the selected manifest's directory and the marketplace can load

### Composition and Boundaries

- The repository composition root outside `src/` MUST provide the ordered default plugin definitions to the generic host.
- No module under `src/` MAY import, identify by name, or otherwise select a default plugin.
- No module under `src/` MAY import a marketplace plugin implementation module.
- A default plugin's complete module graph MUST NOT import core implementation modules under `src/`.
- Default plugins MAY import public `@fx/tx/plugin` types type-only and MAY use standard Node.js and Bun APIs directly.
- Plugin-owned nonliteral dynamic imports of plugin entry paths MUST be allowed.
- Boundary enforcement MUST continue to forbid any static or dynamic import from a plugin into core implementation and any import from core implementation into a default plugin.
- Copying the marketplace plugin to another repository MUST NOT require private core modules, repository-local aliases, or injected marketplace services.

#### Scenario: Externalizable marketplace plugin

- **GIVEN** the marketplace plugin's complete module graph
- **WHEN** its imports and runtime dependencies are inspected
- **THEN** it relies only on public `@fx/tx/plugin` types, standard Node.js and Bun APIs, and its own modules, including its owned nonliteral dynamic imports

## Design

### Ownership Boundary

The host accepts an ordered sequence of default definitions from a neutral composition root. Initialization uses a FIFO work queue. Each plugin receives a transaction-like staging API for commands and child definitions; successful initialization commits the stage, while failure drops it.

The marketplace plugin is an ordinary default plugin and a producer of lazy child definitions. It performs filesystem discovery and dynamic import only when those definitions load. The host has no marketplace vocabulary and reports failures in generic identity terms; the marketplace plugin owns translation into user-facing marketplace diagnostics.

### Package API

`@fx/tx/plugin` is the only core contract available to a portable plugin. Imports from that path SHOULD be type-only unless a future public runtime API is explicitly specified. React, Ink, the command parser, and versions remain dependency-injected runtime values.

The parser is deliberately exposed twice. A plugin that only wants a subcommand receives its namespace already built and never names the parser; a plugin that wants to compose commands, share option definitions, or reuse parser helpers takes the host's instance from injected dependencies. Neither path requires the plugin to install the parser itself.

## Constraints

- Plugin sandboxing, signing, provenance, rollback, catalogs, and automatic updates are out of scope.
- One installed checkout represents a marketplace's current version.
- Dependency environment isolation between plugins is not required.
- Generic lifecycle hooks beyond initialization and command dispatch are out of scope.

## Open Questions

- A future plugin API MAY add generic lifecycle hooks beyond initialization and dispatch after concrete plugins require them.
- Core dependency additions SHOULD be demand-driven and backward-compatible.
- A convention for plugins that expose a single action at their namespace root, rather than subcommands, could be specified if plugins repeatedly hand-roll one.

## References

- [Architecture](../architecture/)
- [Change 0003: Externalize Marketplace Plugin](../../changes/0003-externalize-marketplace-plugin.md)
- [Change 0004: Automate Versioning and Publishing](../../changes/0004-automate-versioning-and-publishing.md)
- [Change 0005: Install Per-Plugin Dependencies](../../changes/0005-install-per-plugin-dependencies.md)
- [Change 0006: Isolate Plugin Failure Exit Codes](../../changes/0006-isolate-plugin-failure-exit-codes.md)
- [Change 0007: Delegate Dispatch to Plugins](../../changes/0007-delegate-dispatch-to-plugins.md)
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
| 2026-08-03 | Renamed the canonical public plugin type contract to `@fx/tx/plugin` | [0004-automate-versioning-and-publishing](../../changes/0004-automate-versioning-and-publishing.md) |
| 2026-08-04 | Added safe, ordered, deduplicated per-plugin dependency manifest installation | [0005-install-per-plugin-dependencies](../../changes/0005-install-per-plugin-dependencies.md) |
| 2026-08-04 | Extended plugin failure isolation to the process exit code | [0006-isolate-plugin-failure-exit-codes](../../changes/0006-isolate-plugin-failure-exit-codes.md) |
| 2026-08-05 | Gave each plugin one identity-named namespace it fully owns, replaced path registration with a host-supplied command builder, and injected the command parser | [0007-delegate-dispatch-to-plugins](../../changes/0007-delegate-dispatch-to-plugins.md) |
