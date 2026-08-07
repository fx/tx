# Architecture

## Overview

`tx` is a small, extensible command-line toolbox. The host MUST be written in TypeScript, MUST run on Bun, and SHOULD be distributable as a single executable. Core implementation under `src/` is feature-neutral; user-facing functionality MAY live in public or private plugins.

The generic core and fully plugin-owned marketplace boundary approved in [Change 0003](../../changes/0003-externalize-marketplace-plugin.md) are implemented.

## Requirements

### Core CLI

- The host MUST define exactly two root options — help, spelled `--help` and `-h`, and version, spelled `--version` and `-V` — and MUST recognize them only as the first argument. Both forms of each MUST behave identically.
- When a root option is the first argument, core MUST produce that option's output, ignore every remaining argument, and exit successfully. `tx --version extra` and `tx -h notes` behave exactly as `tx --version` and `tx -h`.
- Any first argument that is not a root option MUST select a plugin namespace. Every argument after that namespace, including options and help requests, MUST be interpreted by the owning plugin.
- Core MUST NOT interpret, reserve, consume, or reorder any argument that follows the plugin namespace.
- Core MUST NOT reserve a top-level word for help; a plugin MAY reserve one inside its own namespace.
- Running `tx` without arguments MUST show root help on standard error and exit non-zero.
- Root help MUST list every claimed plugin namespace with the description its owner supplied.
- A root help request MUST print root help on standard output and exit successfully.
- An unrecognized first argument MUST report a useful error on standard error and exit non-zero.
- Any failure — unrecognized namespace, usage rejected by a plugin, or a command that throws — MUST exit non-zero. Core MUST NOT distinguish usage failures from runtime failures by exit code.
- Help and version requests MUST exit successfully.
- Either version form MUST print the version and exit successfully before plugin initialization, and only when no plugin namespace precedes it.
- A plugin initialization failure MUST be reported on standard error and MUST NOT change the process exit code; the exit code MUST be the result of the dispatched command alone.
- Nesting below a plugin namespace MUST support arbitrary depth and MUST be defined by the owning plugin.
- Every byte a command writes MUST go through the injected process context streams.
- Dispatch MUST NOT terminate the process. Requests to exit — including help, version, and usage errors — MUST resolve to an exit code returned to the composition root.
- Core implementation under `src/` MUST own only generic plugin hosting, generic context and dependency injection, root program construction, namespace claiming, output routing, and exit-code mapping.
- No module under `src/` MUST import, name, or select a default plugin.

#### Scenario: Root help

- **GIVEN** `tx` is installed
- **WHEN** the user runs `tx`
- **THEN** the CLI lists the available plugin namespaces with their descriptions on standard error and exits non-zero

#### Scenario: Nested command

- **GIVEN** the plugin `notes` defines `daily open` inside its namespace
- **WHEN** the user runs `tx notes daily open today`
- **THEN** the plugin's `daily open` command runs and receives `today`

#### Scenario: Options belong to the plugin

- **GIVEN** the plugin `notes` accepts arbitrary options
- **WHEN** the user runs `tx notes --version`
- **THEN** the plugin receives `--version` as its own argument and the CLI does not print the tx version

#### Scenario: Help belongs to the plugin

- **GIVEN** the plugin `notes` defines a `daily` command with its own options
- **WHEN** the user runs `tx notes daily --help`
- **THEN** the plugin prints its own usage, including its options, on standard output and the CLI exits successfully

#### Scenario: Host survives a plugin help request

- **GIVEN** a plugin command prints help or rejects its arguments
- **WHEN** dispatch handles that outcome
- **THEN** the process is not terminated from inside the command, the text appears on the injected streams, and dispatch returns the corresponding exit code

### Runtime and Distribution

- The host MUST target Bun and TypeScript.
- The initial supported platform is Linux x64 with glibc and the Bun baseline CPU target.
- The deterministic production build MUST create the standalone executable at `dist/tx` using `bun-linux-x64-baseline`.
- A compiled executable MAY load trusted plugin source and dependencies from plugin-owned storage.
- The public GitHub Packages package MUST be named `@fx/tx`, expose the `tx` command from `dist/tx`, and use a strict file allowlist.
- GitHub Releases MUST provide the Linux x64 executable and a SHA-256 checksum file suitable for mise's GitHub backend.
- `package.json`, Release Please output, the `v` tag, GitHub Release, compiled `tx --version`, packed package, and published package MUST use one identical version.

#### Scenario: Standalone host

- **GIVEN** a compiled `tx` executable
- **WHEN** the user runs it on supported Linux x64 glibc
- **THEN** the generic host starts without a separately installed Node.js or Bun runtime

#### Scenario: Version without plugins

- **GIVEN** plugin discovery or initialization would fail
- **WHEN** the user runs `tx --version`
- **THEN** the CLI prints the package version and exits successfully before plugin initialization

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
- A run whose changed files are limited to documentation — paths under `docs/` and files named `*.md` — MUST report success without installing dependencies or running those commands. Every other run MUST run them in full, including a run that changes documentation alongside anything else.
- Documentation-only detection MUST fail safe. When the changed files cannot be determined — no base commit to compare against, an unknown base, or an empty diff — the run MUST execute the full suite rather than skip it.
- Skipping MUST NOT change what reports. The required `CI` check MUST still be produced for a documentation-only run, because a required check that never reports blocks the pull request instead of exempting it.
- CI MUST fail when any command fails or any coverage category falls below 100%.
- Required checks MUST NOT use failure suppression.
- CI MUST also support explicit `workflow_dispatch` without changing the required `CI` job name.
- Release Please MUST use the manifest/node release type and conventional commits; release PRs MUST be merged manually.
- Release orchestration MUST run after successful push-to-`main` CI, dispatch CI for each Release Please PR head, and verify the dispatched run uses the exact head SHA.
- A release created by Release Please MUST be built, checked, packaged, published to GitHub Packages, and uploaded to the existing GitHub Release in the same workflow invocation.
- Release automation MUST use `GITHUB_TOKEN`, MUST NOT rely on token-created tag or release events to trigger publication, and MUST NOT use `pull_request_target` or weaken required CI.
- Publishing MUST be idempotent: an existing package version MUST NOT be overwritten, while release assets MAY be replaced safely on retry.

#### Scenario: Release PR CI

- **GIVEN** Release Please creates or updates a release PR with `GITHUB_TOKEN`
- **WHEN** release orchestration processes that PR
- **THEN** it explicitly dispatches CI and waits for a successful `workflow_dispatch` run at the exact PR head SHA

#### Scenario: Documentation-only pull request

- **GIVEN** a pull request changes only paths under `docs/` and files named `*.md`
- **WHEN** CI runs
- **THEN** the required `CI` check reports success without installing dependencies or running the quality commands

#### Scenario: Documentation alongside source

- **GIVEN** a pull request changes a documentation file and a source file
- **WHEN** CI runs
- **THEN** the full suite runs, exactly as it would without the documentation change

#### Scenario: Undeterminable diff

- **GIVEN** CI cannot determine which files changed
- **WHEN** it decides whether to skip
- **THEN** it runs the full suite

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
3. Build one root program in which each plugin owns a namespace named after its identity.
4. Resolve the first argument to a namespace, delegate the rest to its owner, and map the outcome to an exit code.

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

Resolution is one level deep. The first argument names a plugin namespace; everything after it is the owning plugin's input, parsed by the plugin's own command definitions. Core never inspects that remainder, which is why an option means whatever the plugin says it means — including options core itself defines at the root.

Because a plugin's commands, options, and help are declared rather than hand-parsed, root help, namespace help, and per-command help are all generated from the same declarations, and no plugin has to hand-write a usage string.

## Constraints

- Plugins are trusted personal code and are not sandboxed.
- Plugin signing, provenance, rollback, and hosted catalogs are out of scope.
- Errors from one plugin MUST be reported cleanly and MUST NOT prevent unrelated committed commands from dispatching.

## Open Questions

- Additional supported operating systems and architectures may be decided in a future change.
- Plugin initialization is eager: on every invocation that reaches dispatch, every installed plugin loads to contribute its namespace and description. Making it lazy is worth revisiting if startup cost comes to justify the added caching contract.
- Automatic marketplace updates are out of scope initially.

## References

- [Plugin System](../plugin-system/)
- [Change 0003: Externalize Marketplace Plugin](../../changes/0003-externalize-marketplace-plugin.md)
- [Change 0007: Delegate Dispatch to Plugins](../../changes/0007-delegate-dispatch-to-plugins.md)
- [Change 0009: Skip Quality Commands for Documentation](../../changes/0009-skip-quality-commands-for-documentation.md)
- [Bun executables](https://bun.sh/docs/bundler/executables)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-02 | Initial desired architecture | [0001-bootstrap-core-cli](../../changes/0001-bootstrap-core-cli.md) |
| 2026-08-02 | Made user-facing core features first-party plugins | [0002-add-plugin-marketplaces](../../changes/0002-add-plugin-marketplaces.md) |
| 2026-08-02 | Required Biome, Bun tests, 100% coverage, and complete CI | [0001-bootstrap-core-cli](../../changes/0001-bootstrap-core-cli.md) |
| 2026-08-02 | Separated bundled feature implementations from generic core runtime infrastructure | [0002-add-plugin-marketplaces](../../changes/0002-add-plugin-marketplaces.md) |
| 2026-08-03 | Made repository composition neutral and limited `src/` to the generic plugin host | [0003-externalize-marketplace-plugin](../../changes/0003-externalize-marketplace-plugin.md) |
| 2026-08-03 | Defined scoped package publishing, Linux x64 release assets, version invariants, manual Release Please approvals, and exact-head dispatched CI | [0004-automate-versioning-and-publishing](../../changes/0004-automate-versioning-and-publishing.md) |
| 2026-08-04 | Limited plugin initialization failures to standard-error diagnostics without changing dispatched exit codes | [0006-isolate-plugin-failure-exit-codes](../../changes/0006-isolate-plugin-failure-exit-codes.md) |
| 2026-08-05 | Delegated everything after the plugin namespace to its owner, settled the parser question, and collapsed usage and runtime failures onto one exit code | [0007-delegate-dispatch-to-plugins](../../changes/0007-delegate-dispatch-to-plugins.md) |
| 2026-08-06 | Exempted documentation-only runs from the CI quality commands while still reporting the required check | [0009-skip-quality-commands-for-documentation](../../changes/0009-skip-quality-commands-for-documentation.md) |
