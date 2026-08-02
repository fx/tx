# 0002: Add Plugin Marketplaces

## Summary

Add the shared plugin runtime, a bundled first-party marketplace plugin, Git-backed external marketplaces, TypeScript plugin loading, dependency installation, and injected core dependencies as defined by the [Plugin System spec](../specs/plugin-system/).

**Spec:** [Plugin System](../specs/plugin-system/)
**Status:** draft
**Depends On:** 0001

## Motivation

The public core becomes useful when private repositories can add personal commands without modifying or rebuilding it. One repository must be able to expose multiple single-file or multi-file plugins. Marketplace management itself dogfoods that system as a bundled first-party plugin.

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

The [Plugin System requirements](../specs/plugin-system/index.md#requirements) own marketplace commands, manifest validation, plugin contracts, command registration, injected dependencies, installation, loading, and their scenarios. The [Architecture local-state scenario](../specs/architecture/index.md#local-state) is also an acceptance criterion for this change. This change additionally owns:

- Loading the bundled marketplace module through the same scoped plugin initializer used for external plugins.
- Exporting the public plugin TypeScript types from a stable `tx/plugin` package path.
- Keeping incomplete marketplace clones outside the installed marketplace directory until validation and dependency installation succeed.

## Design

### Approach

Implement one plugin initializer that accepts a plugin function plus owner metadata and invokes it with a scoped registration API. Use it first for the statically bundled marketplace plugin, then for dynamically imported marketplace entries. The marketplace plugin implements `marketplace add`, `list`, and `remove` through normal command registration rather than dispatcher branches.

Store each external marketplace as one checkout below the user data directory. At startup, enumerate marketplace directories, validate each root manifest, and load each declared TypeScript entrypoint through the shared initializer.

The scoped API records marketplace and plugin ownership for every command. It injects the core's React and Ink module instances through the dependency object. Marketplace-local package dependencies are installed with Bun from the repository root when `package.json` exists.

### Decisions

- **Decision:** Implement marketplace management as a bundled first-party plugin.
  - **Why:** The core proves its own plugin API and avoids privileged feature-command paths.
  - **Alternatives considered:** Dispatcher-owned marketplace commands.
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
- [ ] Implement marketplace management as a first-party plugin
  - [ ] Resolve the platform user data directory
  - [ ] Register `marketplace add`, `list`, and `remove` through `PluginAPI`
  - [ ] Clone into temporary storage and finalize only after successful installation
  - [ ] Ensure the dispatcher contains no marketplace-specific branch
- [ ] Implement external marketplace manifests and dependencies
  - [ ] Define and validate `tx.marketplace.json`
  - [ ] Validate safe single-component marketplace names, unique plugin names, contained paths, and repository-relative entrypoints
  - [ ] Run Bun dependency installation only when `package.json` exists
  - [ ] Dynamically import TypeScript plugin entries in deterministic order
- [ ] Add end-to-end plugin-system verification
  - [ ] Verify the bundled marketplace plugin uses the same registration and collision behavior as external plugins
  - [ ] Test a local Git marketplace containing multiple plugins
  - [ ] Test a single-file plugin, nested commands, shared Ink, and marketplace dependencies
  - [ ] Test unsafe names, empty command segments, invalid manifests, missing entries, invalid exports, command collisions, failed clone/install cleanup, and removal
  - [ ] Test that a broken marketplace is reported without blocking first-party removal or healthy plugins
  - [ ] Verify bundled and installed plugins load when running the compiled executable

## Open Questions

- [x] React 19.2.8 and Ink 7.1.1 are the initial pinned core versions (PR #6).

## References

- Spec: [Plugin System](../specs/plugin-system/)
- Related changes: [0001-bootstrap-core-cli](./0001-bootstrap-core-cli.md)
- External: [Bun install](https://bun.sh/docs/pm/cli/install)
