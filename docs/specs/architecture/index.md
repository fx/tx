# Architecture

## Overview

`tx` is a small, extensible command-line toolbox. The core MUST be written in TypeScript, MUST run on Bun, and SHOULD be distributable as a single executable. The core repository is public; personal functionality MAY live in private plugin repositories.

The system is not yet implemented. This document defines the initial desired architecture.

## Requirements

### Core CLI

- Running `tx` without a command MUST show help.
- Running an unknown command MUST fail with a non-zero exit code and show a useful error.
- Core and plugin commands MUST share one command tree.
- User-facing feature commands supplied by the core repository SHOULD be implemented as bundled first-party plugins under `plugins/` rather than privileged dispatcher branches or feature implementations in `src/`.
- Command paths MUST support one or more segments, such as `marketplace add` and `notes daily open`.
- `--help` MUST work at the root and at every command node.

#### Scenario: Root help

- **GIVEN** `tx` is installed
- **WHEN** the user runs `tx`
- **THEN** the CLI lists the available top-level commands

#### Scenario: Nested command

- **GIVEN** a command is registered at `notes daily open`
- **WHEN** the user runs `tx notes daily open`
- **THEN** that command receives the remaining arguments

### Runtime and Distribution

- The core MUST target Bun and TypeScript.
- The core SHOULD compile to one executable for each supported platform.
- A compiled core MAY load plugin source and dependencies from the user data directory.
- The initial supported platform MAY be the developer's current platform; additional targets MAY be added later.

#### Scenario: Standalone core

- **GIVEN** a compiled `tx` executable
- **WHEN** the user runs it on a supported platform
- **THEN** the core starts without a separately installed Node.js runtime

### Local State

- Mutable state MUST live outside the executable.
- The user data directory MUST contain marketplace checkouts and generated plugin metadata.
- Removing the user data directory MAY reset all installed marketplaces and plugins.
- The initial implementation MUST NOT require a database.

#### Scenario: Fresh state

- **GIVEN** no `tx` user data directory exists
- **WHEN** the user first runs `tx`
- **THEN** the directory is created as needed and bundled first-party plugins remain usable

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
- The bootstrap change MUST include the complete CI workflow; CI setup MUST NOT be deferred to a later change.

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

The generic core runtime in `src/` has four small responsibilities:

1. Parse the command path and select the longest registered match.
2. Load bundled first-party and installed marketplace plugins through the same plugin contract.
3. Let those plugins register commands in one command tree.
4. Execute the selected command with a shared context.

Bundled feature implementations live under the repository-root `plugins/` directory, outside `src/`. Marketplace management is one such bundled first-party plugin. The core may know its entry module for bundling and registration, but the dispatcher and generic runtime contain no marketplace-specific implementation.

No general hook framework, daemon, registry service, sandbox, signing system, or database is part of the initial architecture.

### Proposed Project Shape

```text
src/
  cli.ts
  commands.ts
  context.ts
  plugin.ts
  plugins.ts
plugins/
  marketplace/
    index.ts
test/
```

This layout is implementation guidance and MAY change while preserving the observable requirements.

### Quality Commands

The package scripts SHOULD expose one stable local and CI interface:

```text
bun run format       # write Biome formatting fixes
bun run lint         # check Biome formatting and lint rules
bun run typecheck    # TypeScript validation without emit
bun run test         # Bun tests with 100% coverage enforcement
bun run build        # compile the production executable
bun run check        # lint, typecheck, test, and build
```

CI uses the non-writing commands and installs with the frozen Bun lockfile.

### Command Resolution

Commands are identified by arrays of path segments. Dispatch selects the longest registered command path matching the start of `argv`; all remaining values are passed to the command handler.

For example, with commands `notes` and `notes daily open`, the input below selects the latter:

```text
tx notes daily open today --json
```

The handler receives `today --json`.

## Constraints

- The first version assumes plugins are trusted personal code.
- The first version does not sandbox plugins.
- The first version does not provide plugin signing, provenance, rollback, or a hosted marketplace catalog.
- Errors from a plugin MUST be reported cleanly and MUST produce a non-zero exit code.

## Open Questions

- Exact supported operating systems will be decided during implementation.
- The final command-line parser MAY be a small library or a local implementation; it MUST preserve the command behavior in this spec.
- Automatic marketplace updates are out of scope initially.

## References

- [Plugin System](../plugin-system/)
- [Bun executables](https://bun.sh/docs/bundler/executables)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-02 | Initial desired architecture | [0001-bootstrap-core-cli](../../changes/0001-bootstrap-core-cli.md) |
| 2026-08-02 | Made user-facing core features first-party plugins | [0002-add-plugin-marketplaces](../../changes/0002-add-plugin-marketplaces.md) |
| 2026-08-02 | Required Biome, Bun tests, 100% coverage, and complete CI | [0001-bootstrap-core-cli](../../changes/0001-bootstrap-core-cli.md) |
| 2026-08-02 | Separated bundled feature implementations from generic core runtime infrastructure | [0002-add-plugin-marketplaces](../../changes/0002-add-plugin-marketplaces.md) |
