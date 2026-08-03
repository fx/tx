# 0003: Externalize Marketplace Plugin

## Summary

Reduce `src/` to a generic plugin host and move all marketplace ownership and orchestration into an externalizable default plugin supplied by a neutral repository composition root.

**Spec:** [Plugin System](../specs/plugin-system/)
**Status:** complete
**Depends On:** 0002

## Motivation

Change 0002 established a standalone marketplace command plugin but left marketplace discovery, storage services, ownership types, and loading orchestration in core. That boundary prevents the plugin from being copied into another repository and makes generic host APIs carry marketplace vocabulary. This change completes the approved separation without reopening or changing the completed status of change 0002.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- New host, marketplace, composition, recovery, compiled-executable, and boundary behavior MUST have automated tests.
- The production executable MUST build and its marketplace dependency-install path MUST be exercised without relying on a separate Bun executable on `PATH`.
- Boundary tests MUST prove marketplace externalizability and MUST allow plugin-owned nonliteral dynamic imports while rejecting imports into core implementation.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

The [Generic Plugin Host](../specs/plugin-system/index.md#generic-plugin-host), [Public Plugin Contract](../specs/plugin-system/index.md#public-plugin-contract), [Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership), [Composition and Boundaries](../specs/plugin-system/index.md#composition-and-boundaries), and [Architecture Composition Root](../specs/architecture/index.md#composition-root) sections own observable behavior and scenarios. This change owns the migration and sequencing needed to make those contracts true:

- Marketplace-specific public DI, public types, and command-context fields MUST be removed from core rather than retained as compatibility aliases.
- All behavior currently owned by `src/marketplaces.ts` MUST move to the marketplace plugin or be deleted when superseded; no marketplace facade MAY remain under `src/`.
- The neutral composition root MUST supply ordered default plugin definitions before the generic host initializes them.
- Existing installed marketplace state and manifest format MUST remain usable; this change MUST NOT require a user-data migration.
- The marketplace plugin's compiled dependency installer MUST execute `process.execPath` with `BUN_BE_BUN=1`.
- Change 0002 remains historical and complete; change 0003 supersedes only its architectural ownership boundary.

## Design

### Approach

Introduce a marketplace-agnostic lazy plugin-definition contract with immutable identity and generic initialization context. The host processes an explicit FIFO queue. Each initialization receives a private stage for commands and child definitions; it commits the complete stage on success and drops it on failure. Generic host diagnostics identify the failed definition, while plugins retain ownership of domain-specific recovery messages.

Move marketplace data paths, storage, safe names, `tx.marketplace.json` validation, directory discovery, manifest ordering, dynamic entry imports, Git operations, Bun installation, diagnostics, recovery mapping, and add/list/remove commands into `plugins/marketplace/`. Marketplace discovery contributes lazy child definitions rather than asking core to understand marketplaces.

Move default selection to a repository entry/composition module outside `src/`. That module imports default plugin entries, determines their order, and passes definitions into the host. Modules under `src/` neither import those entries nor contain their names.

Generalize CLI, plugin initialization, contexts, commands, and public exports around plugin identity only. Keep React, Ink, tx version, and dependency versions injected by core. Delete marketplace-specific core dependencies and context fields.

Amend boundary verification to inspect static and dynamic module edges semantically: plugin-owned nonliteral imports of discovered entry paths are valid, but any plugin import resolving into `src/` and any `src/` import resolving into a default plugin are invalid. Add a portability fixture that copies the marketplace plugin outside the repository-specific module graph and type-checks or executes it against only public `tx/plugin` types and standard Node.js/Bun APIs.

### Decisions

- **Decision:** Lazy child definitions are host-generic and are staged with commands.
  - **Why:** Marketplace discovery can express deferred imports without giving core marketplace concepts, and failed parents cannot leak partial children.
- **Decision:** Initialization order is FIFO over the ordered roots and subsequently committed children.
  - **Why:** Ordering is deterministic without embedding marketplace sorting policy in core.
- **Decision:** Marketplace-aware diagnostics are mapped by the marketplace plugin.
  - **Why:** Core failure isolation stays generic while users retain actionable recovery guidance.
- **Decision:** Default composition lives outside `src/`.
  - **Why:** Core cannot accidentally select or name repository features.
- **Decision:** Compiled dependency installation re-enters `process.execPath` with `BUN_BE_BUN=1`.
  - **Why:** A standalone binary can perform Bun package-manager work without a separate executable on `PATH`.
- **Decision:** Nonliteral dynamic imports are permitted only as plugin-owned loading behavior.
  - **Why:** Runtime-discovered entry paths are required, while imports across the core implementation boundary remain forbidden.

### Non-Goals

- Changing marketplace commands, `tx.marketplace.json`, installed storage layout, or user-visible ordering semantics beyond preserving them under the new owner.
- Adding marketplace update, catalogs, signing, provenance, checksums, rollback, sandboxing, permissions, or version solving.
- Adding lifecycle hooks, aliases, structured flags, or a general service container.
- Preserving marketplace-specific core APIs as deprecated aliases.
- Splitting implementation across multiple PRs; this change has one atomic top-level implementation task.

## Tasks

- [x] Externalize marketplace ownership and make core a generic lazy child-plugin host in one implementation PR (PR #11)
  - [x] Add immutable marketplace-agnostic plugin identity, generic initialization context, lazy child definitions, atomic command/child staging, deterministic FIFO initialization, failure isolation, and generic dispatch contracts.
  - [x] Add a neutral repository composition root outside `src/` that supplies ordered default plugin definitions; remove all default-plugin imports and names from modules under `src/`.
  - [x] Move or delete every behavior in `src/marketplaces.ts`, leaving no marketplace storage, path, manifest, discovery, ordering, import, Git, installation, diagnostics, recovery, or command behavior in core.
  - [x] Move marketplace discovery, deterministic ordering, nonliteral dynamic imports, child-definition creation, and marketplace-aware failure/recovery orchestration into `plugins/marketplace/`.
  - [x] Generalize CLI, plugin initialization, contexts, commands, and public `tx/plugin` types; remove marketplace-specific public DI/types/context while retaining React, Ink, tx version, and dependency-version DI.
  - [x] Make compiled marketplace dependency installation invoke `process.execPath` with `BUN_BE_BUN=1`, including cleanup and diagnostic mapping on failure.
  - [x] Update unit, integration, end-to-end, and compiled-executable tests for atomic staging, FIFO child initialization, isolation, recovery, add/list/remove, discovery/import failures, and self-installation.
  - [x] Update module-boundary tests to allow plugin-owned nonliteral dynamic imports while forbidding plugin-to-core and core-to-default-plugin implementation imports.
  - [x] Add an externalizability fixture proving the marketplace plugin can be copied out and consume only public `tx/plugin` types plus standard Node.js/Bun APIs.
  - [x] Preserve 100% statement, function, and line coverage and pass formatting, linting, type checking, the full Bun test suite, boundary checks, and production build.

## Open Questions

None. The user approved this architecture and its one-PR implementation boundary.

## References

- Specs: [Architecture](../specs/architecture/) and [Plugin System](../specs/plugin-system/)
- Depends on: [0002 Add Plugin Marketplaces](./0002-add-plugin-marketplaces.md)
- External: [Bun package manager](https://bun.sh/docs/pm/cli/install)
