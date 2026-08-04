# 0006: Isolate Plugin Failure Exit Codes

## Summary

Report a plugin initialization failure as a standard-error diagnostic only, so it never changes the exit code of a command the CLI dispatched successfully. A command owned only by a failed plugin was never registered and therefore still fails as an unknown command with exit code `2`.

**Spec:** [Plugin System](../specs/plugin-system/)
**Status:** complete
**Depends On:** 0005

## Approval Gate

**Approved:** 2026-08-04

The user selected the unconditional "never escalate" contract over the strict and opt-in alternatives. An opt-in strict mode such as `TX_STRICT_PLUGINS`, escalation limited to the help path, and any new exit code value were explicitly excluded from this change.

Completion still requires every task and acceptance scenario below.

## Motivation

`main` currently rewrites a successful dispatch's exit code from `0` to `1` whenever any plugin failed to initialize. One unrelated broken marketplace therefore poisons every healthy command, `tx --help`, and even `tx marketplace remove <broken>` — the very recovery command the plugin-system specification promises stays available.

Callers that wrap `tx` and act on its exit status cannot distinguish "your command failed" from "some unrelated plugin is broken". Failure isolation already holds for dispatch, but not for the process result, so the guarantee stops exactly where scripted consumers need it. The stderr diagnostics already carry the failure signal in full, including the failing plugin's identity and message.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable exit-code behavior MUST have automated tests, and every flipped exit-code assertion MUST retain its paired standard-error diagnostic assertion.
- Standalone-executable parity MUST be exercised without relying on a separate Bun executable on `PATH`.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

The normative failure-isolation contract is owned by [Plugin System: Generic Plugin Host](../specs/plugin-system/index.md#generic-plugin-host). The derived CLI exit-code statement is owned by [Architecture: Core CLI](../specs/architecture/index.md#core-cli). This change record does not duplicate their normative wording.

## Acceptance Scenarios

The authoritative acceptance scenarios are owned by [Plugin System: Generic Plugin Host](../specs/plugin-system/index.md#generic-plugin-host) — the existing "Failure isolation" scenario and the "Failure exit code isolation" scenario added by this change.

## Design

### Approach

`main` returns `dispatch`'s exit code verbatim. The failure list is consumed only by the existing standard-error diagnostic loop, whose wording, ordering, and stream stay unchanged. `EXIT_FAILURE` becomes unused in `src/cli.ts` and its import is dropped; the constant remains exported from `src/commands.ts` because handler failures still return it.

No change is required in `src/commands.ts`, `src/plugins.ts`, `src/context.ts`, `src/plugin.ts`, root `cli.ts`, or `plugins/marketplace/*`. The "failed plugin owned my command" case needs no code either: the failed plugin's staged contribution was discarded, so the command path was never registered and `dispatch` already returns `EXIT_USAGE`.

### Decisions

- **Decision:** A plugin initialization failure never changes the exit code.
  - **Why:** The exit code answers "did my command work"; the stderr diagnostic answers "is a plugin broken". Conflating them breaks recovery commands and scripted use.
  - **Alternatives considered:** Escalating only on the help path was rejected as an arbitrary special case. An opt-in strict mode was deferred as demand-driven.
- **Decision:** Unknown-command coverage of a failed plugin's commands is left to `dispatch`.
  - **Why:** It is already correct — the staged contribution was discarded, so the path is unregistered and dispatch returns `EXIT_USAGE` (`2`).
  - **Alternatives considered:** A dedicated "plugin failed to provide this command" path was rejected as duplicated dispatch logic for no observable gain.
- **Decision:** `EXIT_FAILURE` stays exported from `src/commands.ts`.
  - **Why:** Handler failures still return it; only `src/cli.ts` stops importing it.

### Non-Goals

- An opt-in strict mode such as `TX_STRICT_PLUGINS` or any equivalent flag or config key.
- Escalating the exit code on the help path, or for any subset of invocations.
- Introducing a new exit code value or changing `EXIT_SUCCESS`, `EXIT_FAILURE`, or `EXIT_USAGE`.
- Changing the wording, ordering, or stream of the `Error loading plugin …` diagnostics.
- Changing plugin initialization order, staging atomicity, or collision handling.
- Changing marketplace behavior, storage, or diagnostics.
- Modifying completed historical change documents.
- Splitting this contract across multiple implementation PRs.

## Tasks

- [x] Isolate plugin initialization failures from the dispatched exit code in one PR
  - [x] Record approval, set this change to `in-progress`, and register it in `docs/index.yml` and `docs/index.md`.
  - [x] Return the dispatcher's exit code verbatim from `main` and drop the now-unused `EXIT_FAILURE` import in `src/cli.ts`.
  - [x] Flip every test that encodes the old escalation, keep the unknown-command, handler-failure, and marketplace-add failure guards unchanged, and add healthy-command, broken-marketplace removal, help-path, and standalone-executable coverage.
  - [x] Update the plugin-system and architecture specifications with the normative bullets, the new acceptance scenario, and both changelog rows.
  - [x] Rewrite the plugin manual's exit-code sentence.
  - [x] Run `bun run check`, then mark this change complete with the implementing PR number and sync both indexes.

## Open Questions

- [ ] An opt-in strict mode (for example `TX_STRICT_PLUGINS=1`) that makes any plugin initialization failure non-zero MAY be specified later if a concrete consumer requires it, per the demand-driven rule in [Plugin System: Open Questions](../specs/plugin-system/index.md#open-questions).

## References

- Spec: [Plugin System](../specs/plugin-system/)
- Spec: [Architecture: Core CLI](../specs/architecture/index.md#core-cli)
- Testing conventions: [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions)
- Depends on: [0005 Install Per-Plugin Dependencies](./0005-install-per-plugin-dependencies.md)
- Practical guidance updated by this change: [Plugin Manual](../manual/plugins.md)
