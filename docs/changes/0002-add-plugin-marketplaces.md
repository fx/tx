# 0002: Add Plugin Marketplaces

## Summary

Add the shared plugin runtime, a standalone bundled first-party marketplace plugin, Git-backed external marketplaces, TypeScript plugin loading, dependency installation, and injected core dependencies as defined by the [Plugin System spec](../specs/plugin-system/).

**Spec:** [Plugin System](../specs/plugin-system/)
**Status:** complete
**Depends On:** 0001

## Motivation

The public core becomes useful when private repositories can add personal commands without modifying or rebuilding it. One repository must be able to expose multiple single-file or multi-file plugins. Marketplace management itself dogfoods that system as a bundled first-party plugin whose implementation remains independent of core implementation modules.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage.
- The production executable MUST build successfully.
- Git and dependency-install tests SHOULD use temporary local repositories rather than network services.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

The [Plugin System requirements](../specs/plugin-system/index.md#requirements) own marketplace commands, manifest validation, plugin contracts, the standalone bundled-plugin boundary, command registration, injected dependencies, installation, loading, and their scenarios. The [Architecture local-state scenario](../specs/architecture/index.md#local-state) is also an acceptance criterion for this change. This change additionally owns:

- Relocating the bundled marketplace implementation from `src/` to `plugins/marketplace/` while preserving its statically bundled entry registration.
- Loading the bundled marketplace module through the same scoped plugin initializer used for external plugins.
- Exporting the public plugin TypeScript types from a stable `tx/plugin` package path.
- Keeping incomplete marketplace clones outside the installed marketplace directory until validation and dependency installation succeed.

## Design

### Approach

Implement one plugin initializer that accepts a plugin function plus owner metadata and invokes it with a scoped registration API. Use it first for the statically bundled `plugins/marketplace/` entry, then for dynamically imported marketplace entries. The marketplace plugin implements `marketplace add`, `list`, and `remove` through normal command registration rather than dispatcher branches.

Keep the bundled marketplace plugin's complete module graph outside `src/`. Expose the core capabilities it needs through `PluginAPI` dependencies, and keep only generic plugin runtime and loading infrastructure in `src/`. Core registration statically imports the bundled plugin entry and no feature-owned implementation module behind it.

Store each external marketplace as one checkout below the user data directory. At startup, enumerate marketplace directories, validate each root manifest, and load each declared TypeScript entrypoint through the shared initializer.

The scoped API records marketplace and plugin ownership for every command. It injects the core's React and Ink module instances and marketplace capabilities through the dependency object. Marketplace-local package dependencies are installed with Bun from the repository root when `package.json` exists.

### Decisions

- **Decision:** Implement marketplace management as a standalone bundled first-party plugin under `plugins/marketplace/`.
  - **Why:** The core proves its public plugin API without making the feature's implementation part of the core runtime.
  - **Alternatives considered:** Dispatcher-owned marketplace commands or a bundled plugin implemented inside `src/`.
- **Decision:** Inject required core capabilities through `PluginAPI` and prohibit the bundled plugin's module graph from importing `src/`.
  - **Why:** The same public boundary remains usable by bundled and external plugins while `src/` stays generic.
  - **Alternatives considered:** Allowing first-party plugins privileged imports of core implementation modules.
- **Decision:** Use one required `tx.marketplace.json` file per repository.
  - **Why:** Explicit plugin entries are simpler than filesystem conventions or recursive discovery.
  - **Alternatives considered:** One repository per plugin and implicit file scanning.
- **Decision:** Clone repositories rather than introduce a catalog or package registry.
  - **Why:** Existing Git/SSH access already handles the private-repository use case.
- **Decision:** Treat installed marketplace directories as the source of truth.
  - **Why:** The first version does not need a registry database or lockfile.
- **Decision:** Inject React and Ink directly through the plugin API.
  - **Why:** Plugins can reuse the core's instances without coupling to core internals.

### Non-Goals

- Marketplace update, version solving, rollback, signing, checksums, provenance, sandboxing, or a hosted catalog.
- Per-plugin dependency environments within one marketplace.
- Plugin aliases, lifecycle hooks, permissions, or structured flag declarations.
- Automatic execution of project-local marketplace configuration.

## Tasks

- [x] Implement the shared plugin API and loader (PR #6)
  - [x] Export plugin, command handler, context, and injected-dependency types
  - [x] Initialize statically bundled and dynamically imported plugin functions through one path
  - [x] Scope command registrations to marketplace and plugin owners
  - [x] Inject the core's React, Ink, and version metadata
- [x] Implement marketplace management as a first-party plugin (PR #7)
  - [x] Resolve the platform user data directory
  - [x] Register `marketplace add`, `list`, and `remove` through `PluginAPI`
  - [x] Clone into temporary storage and finalize only after successful installation
  - [x] Ensure the dispatcher contains no marketplace-specific branch
- [x] Implement external marketplace manifests and dependencies (PR #8)
  - [x] Define and validate `tx.marketplace.json`
  - [x] Validate safe single-component marketplace names, unique plugin names, contained paths, and repository-relative entrypoints
  - [x] Run Bun dependency installation only when `package.json` exists
  - [x] Dynamically import TypeScript plugin entries in deterministic order
- [x] Enforce the standalone bundled marketplace plugin boundary (PR #9)
  - [x] Move the bundled marketplace entry and all feature-owned command and management modules from `src/` into `plugins/marketplace/`, leaving only generic plugin runtime and loading infrastructure in `src/`
  - [x] Replace imports of core implementation modules with injected `PluginAPI` capabilities; keep any `tx/plugin` imports type-only and use standard Node.js or Bun APIs directly where needed
  - [x] Update core bundling and first-party registration to statically import only `plugins/marketplace/`'s entry module
  - [x] Add an automated module-graph boundary test covering every bundled plugin entry and rejecting plugin-to-`src/` imports, runtime `tx/plugin` imports, and core imports of bundled implementation modules beyond each entry
  - [x] Update affected unit and integration tests while preserving all standing type, coverage, and build gates
- [x] Add end-to-end plugin-system verification (PR #10)
  - [x] Verify the bundled marketplace plugin uses the same registration and collision behavior as external plugins
  - [x] Test a local Git marketplace containing multiple plugins
  - [x] Test a single-file plugin, nested commands, shared Ink, and marketplace dependencies
  - [x] Test unsafe names, empty command segments, invalid manifests, missing entries, invalid exports, command collisions, failed clone/install cleanup, and removal
  - [x] Test that a broken marketplace is reported without blocking first-party removal or healthy plugins
  - [x] Verify bundled and installed plugins load when running the compiled executable

## Open Questions

- [x] React 19.2.8 and Ink 7.1.1 are the initial pinned core versions (PR #6).

## References

- Spec: [Plugin System](../specs/plugin-system/)
- Related changes: [0001-bootstrap-core-cli](./0001-bootstrap-core-cli.md)
- External: [Bun install](https://bun.sh/docs/pm/cli/install)
