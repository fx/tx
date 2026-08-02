# 0001: Bootstrap Core CLI

## Summary

Create the initial Bun and TypeScript project, compiled entrypoint, command registry, dispatcher, help output, and test harness defined by the [Architecture spec](../specs/architecture/).

**Spec:** [Architecture](../specs/architecture/)
**Status:** draft
**Depends On:** —

## Motivation

The repository currently contains only a README. The plugin system needs a small, tested core command tree and stable handler context before marketplaces can register external commands.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage.
- The production executable MUST build successfully.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

The Architecture spec owns [core CLI](../specs/architecture/index.md#core-cli), [runtime](../specs/architecture/index.md#runtime-and-distribution), [development](../specs/architecture/index.md#development-conventions), and [CI](../specs/architecture/index.md#continuous-integration) behavior. Those sections' scenarios are this change's acceptance criteria; [local state](../specs/architecture/index.md#local-state) and bundled-plugin behavior are implemented by change 0002. This change additionally owns:

- Establishing the public command-registration and command-context TypeScript interfaces used by later changes.
- Keeping the initial dispatcher independent of plugin loading so change 0002 can register commands through the same path.
- Producing a development executable and a Bun-compiled release executable.
- Establishing Biome, TypeScript, Bun test coverage enforcement, and the stable package-script interface.
- Adding the complete merge-blocking CI workflow during bootstrap.

## Design

### Approach

Create a Bun package with one CLI entrypoint and a command registry keyed by arrays of command segments. The registry accepts commands without knowing whether their owner is first-party or external. Resolve the longest matching command prefix and pass the remaining argv to its handler.

The root help renderer traverses the same registry rather than maintaining a second command list.

### Decisions

- **Decision:** Implement only nested command registration, longest-prefix dispatch, help, and errors.
  - **Why:** These are the minimum capabilities required by the plugin system.
  - **Alternatives considered:** oclif and a broader framework were rejected for the initial build because the required surface is small.
- **Decision:** Use Bun's built-in test runner and executable compiler.
  - **Why:** Bun is the chosen runtime and avoids extra tooling.
- **Decision:** Use Biome for both formatting and linting.
  - **Why:** One fast tool provides consistent local and CI checks.
  - **Alternatives considered:** Separate ESLint and formatter configurations.
- **Decision:** Enforce 100% statement, function, and line coverage from bootstrap.
  - **Why:** The initial codebase is small, so full coverage is practical and prevents untested foundations.
- **Decision:** Add GitHub Actions CI in the bootstrap change.
  - **Why:** Every later change must inherit working merge gates rather than adding quality retroactively.
  - **Implementation:** `.github/workflows/ci.yml` runs the locked install, Biome, type checking, Bun tests with coverage, and production build.

### Non-Goals

- Plugin discovery or marketplace management.
- Aliases, lifecycle hooks, completions, telemetry, configuration merging, or a general flag schema.
- Multi-platform release automation beyond proving compilation works locally.

## Tasks

- [x] Scaffold the Bun and TypeScript package with quality tooling (PR #2)
  - [x] Add package metadata, committed Bun lockfile, TypeScript configuration, and CLI entrypoint
  - [x] Configure Biome formatting and linting
  - [x] Configure Bun test coverage thresholds at 100% for statements, functions, and lines
  - [x] Add `format`, `lint`, `typecheck`, `test`, `build`, and `check` package scripts
- [x] Implement the core command registry and dispatcher (PR #3)
  - [x] Define command, owner, handler, and context types
  - [x] Implement registration, collision errors, longest-prefix matching, and execution
  - [x] Implement root and nested help plus unknown-command errors
- [ ] Build the complete test suite
  - [x] Test registration, nested dispatch, remaining argv, collisions, help, and failures
  - [x] Reach and enforce 100% coverage in every required category
  - [ ] Verify a local standalone executable starts successfully
- [ ] Add merge-blocking GitHub Actions CI in `.github/workflows/ci.yml`
  - [ ] Run on pull requests and pushes to the default branch
  - [ ] Install dependencies from the frozen Bun lockfile
  - [ ] Run Biome checks, TypeScript checking, tests with coverage, and the production build
  - [ ] Ensure failures and coverage regressions fail the workflow without suppression

## Open Questions

- [ ] Which platforms should the first release workflow build after the local executable is proven?

## References

- Spec: [Architecture](../specs/architecture/)
- External: [Bun executables](https://bun.sh/docs/bundler/executables)
