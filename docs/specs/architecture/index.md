# Architecture

## Overview

`tx` is a small, extensible command-line toolbox. The host MUST be written in TypeScript, MUST run on Bun, and SHOULD be distributable as a single executable. Core implementation under `src/` is feature-neutral; user-facing functionality MAY live in public or private plugins.

The approved target architecture is partially unimplemented. [Change 0003](../../changes/0003-externalize-marketplace-plugin.md) tracks the remaining boundary changes.

## Requirements

### Core CLI

- Running `tx` without a command MUST show help.
- Running an unknown command MUST fail with a non-zero exit code and show a useful error.
- Core and plugin commands MUST share one command tree.
- Command paths MUST support one or more segments, such as `marketplace add` and `notes daily open`.
- `--help` MUST work at the root and at every command node.
- Core implementation under `src/` MUST own only generic plugin hosting, generic context and dependency injection, command-tree construction, and dispatch.
- No module under `src/` MUST import, name, or select a default plugin.

#### Scenario: Root help

- **GIVEN** `tx` is installed
- **WHEN** the user runs `tx`
- **THEN** the CLI lists the available top-level commands

#### Scenario: Nested command

- **GIVEN** a command is registered at `notes daily open`
- **WHEN** the user runs `tx notes daily open`
- **THEN** that command receives the remaining arguments

### Runtime and Distribution

- The host MUST target Bun and TypeScript.
- The host SHOULD compile to one executable for each supported platform.
- A compiled executable MAY load trusted plugin source and dependencies from plugin-owned storage.
- The initial supported platform MAY be the developer's current platform; additional targets MAY be added later.

#### Scenario: Standalone host

- **GIVEN** a compiled `tx` executable
- **WHEN** the user runs it on a supported platform
- **THEN** the generic host starts without a separately installed Node.js or Bun runtime

### State Ownership

- Mutable feature state MUST live outside the executable.
- Generic core modules MUST NOT own marketplace storage locations, manifests, names, discovery, Git operations, or dependency installation.
- A plugin MAY own mutable state and resolve its own platform-appropriate data paths through standard Node.js or Bun APIs.
- Removing plugin-owned state MAY reset that plugin's installed data without changing the generic host contract.
- The initial architecture MUST NOT require a database.

#### Scenario: Fresh state

- **GIVEN** no marketplace plugin data directory exists
- **WHEN** `tx` starts
- **THEN** the generic host initializes and the marketplace plugin creates its state only when its own behavior requires it

### Composition Root

- A repository composition root outside `src/` MUST supply an ordered list of default plugin definitions to the host.
- Default plugin ordering MUST be explicit at the composition root.
- The composition root MAY import default plugin entries; core implementation under `src/` MUST NOT.
- A default plugin MUST be removable or replaceable without adding feature-specific vocabulary to `src/`.

#### Scenario: Neutral core

- **GIVEN** the default marketplace plugin is removed from repository composition
- **WHEN** the host is built
- **THEN** no module under `src/` requires marketplace code or marketplace-specific public types

### Development Conventions

- Production code MUST be TypeScript.
- Formatting and linting MUST use Biome.
- Tests MUST use Bun's test runner.
- New observable behavior MUST have automated tests.
- Tests MUST maintain 100% statement, function, and line coverage across production source files.
- Coverage exclusions MUST be limited to generated or non-executable files and MUST be documented in configuration.
- Committed tests MUST NOT contain focused or skipped cases without a documented reason.
- TypeScript MUST pass with no type errors.

#### Scenario: Local quality checks

- **GIVEN** a developer has installed locked dependencies
- **WHEN** they run the documented validation command
- **THEN** formatting, linting, type checking, tests, all Bun-supported 100% coverage thresholds, and the production build succeed

### Continuous Integration

- Continuous integration MUST use GitHub Actions.
- CI MUST run for every pull request and every push to the default branch.
- CI MUST install dependencies from the committed Bun lockfile without updating it.
- CI MUST run Biome formatting and lint checks, TypeScript checking, Bun tests with coverage, and the production build.
- CI MUST fail when any command fails or any coverage category falls below 100%.
- Required checks MUST NOT use failure suppression.

#### Scenario: Coverage regression

- **GIVEN** a change reduces any coverage category below 100%
- **WHEN** CI runs
- **THEN** the test job fails and the change cannot satisfy the merge gates

#### Scenario: Formatting regression

- **GIVEN** a committed file does not match Biome formatting
- **WHEN** CI runs
- **THEN** the quality job fails

## Design

### Components

Generic core implementation in `src/` has four responsibilities:

1. Initialize generic plugin definitions and isolate failures.
2. Atomically commit commands and lazy child definitions contributed by each successful plugin.
3. Build one command tree using immutable plugin identities and generic contexts.
4. Dispatch the longest matching command.

The repository composition root lives outside `src/` and supplies ordered default definitions. Feature implementations, including marketplace management, live outside `src/` and depend only on the public plugin contract plus standard runtime APIs.

No general daemon, registry service, sandbox, signing system, or database is part of the initial architecture.

### Project Shape

```text
src/
  cli.ts
  commands.ts
  context.ts
  plugin.ts
  plugins.ts
plugins/
  marketplace/
<repository composition root>
test/
```

The exact filenames MAY change, but the composition and ownership boundaries MUST remain observable in the module graph.

### Quality Commands

The package scripts SHOULD expose one stable local and CI interface:

```text
bun run format
bun run lint
bun run typecheck
bun run test
bun run build
bun run check
```

CI uses non-writing commands and installs with the frozen Bun lockfile.

### Command Resolution

Commands are identified by arrays of path segments. Dispatch selects the longest registered command path matching the start of `argv`; all remaining values are passed to the command handler.

## Constraints

- Plugins are trusted personal code and are not sandboxed.
- Plugin signing, provenance, rollback, and hosted catalogs are out of scope.
- Errors from one plugin MUST be reported cleanly and MUST NOT prevent unrelated committed commands from dispatching.

## Open Questions

- Exact supported operating systems will be decided during implementation.
- The final command-line parser MAY be a small library or a local implementation; it MUST preserve the command behavior in this spec.
- Automatic marketplace updates are out of scope initially.

## References

- [Plugin System](../plugin-system/)
- [Change 0003: Externalize Marketplace Plugin](../../changes/0003-externalize-marketplace-plugin.md)
- [Bun executables](https://bun.sh/docs/bundler/executables)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-02 | Initial desired architecture | [0001-bootstrap-core-cli](../../changes/0001-bootstrap-core-cli.md) |
| 2026-08-02 | Made user-facing core features first-party plugins | [0002-add-plugin-marketplaces](../../changes/0002-add-plugin-marketplaces.md) |
| 2026-08-02 | Required Biome, Bun tests, 100% coverage, and complete CI | [0001-bootstrap-core-cli](../../changes/0001-bootstrap-core-cli.md) |
| 2026-08-02 | Separated bundled feature implementations from generic core runtime infrastructure | [0002-add-plugin-marketplaces](../../changes/0002-add-plugin-marketplaces.md) |
| 2026-08-03 | Made repository composition neutral and limited `src/` to the generic plugin host | [0003-externalize-marketplace-plugin](../../changes/0003-externalize-marketplace-plugin.md) |
