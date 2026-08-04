# 0005: Install Per-Plugin Dependencies

## Summary

Install marketplace dependencies from the package manifest selected for each configured plugin rather than from one marketplace-root manifest. This approved contract records the required safety distinction for missing explicit overrides.

**Spec:** [Plugin System](../specs/plugin-system/)
**Status:** complete
**Depends On:** 0004

## Approval Gate

**Approved:** 2026-08-04

The user explicitly approved the full contract and the distinction that an explicit `package` override which is a syntactically valid, repository-contained path to an absent `package.json` skips dependency installation, while a wrong-type, empty, absolute, escaping, directory, wrong-filename, or externally resolving path remains an error.

Completion still requires every task and acceptance scenario below.

## Motivation

The marketplace plugin currently validates all configured entries and then runs one dependency installation from the marketplace root only when the root `package.json` exists. A marketplace containing independently located plugins cannot install each plugin from its own package boundary, and a nested plugin can accidentally depend on a root-level installation model that does not match its entry location.

This change establishes deterministic per-plugin package selection while retaining the existing trusted-code model, atomic staging cleanup, compiled-executable installation path, and marketplace-only ownership boundary.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable package-selection, validation, ordering, deduplication, skip, failure, cleanup, and standalone behavior MUST have automated tests.
- The compiled-executable dependency-install path MUST be exercised without relying on a separate Bun executable on `PATH`.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

The approved standing behavior and acceptance scenarios are owned by [Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership), while [Composition and Boundaries](../specs/plugin-system/index.md#composition-and-boundaries) owns the architectural boundary. The implementation PR must satisfy those authoritative sections and the delivery tasks below; this change record does not duplicate their normative contract.

## Acceptance Scenarios

The authoritative acceptance scenarios are now owned by [Plugin System: Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership).

## Design

### Approach

Extend the marketplace-owned manifest entry model with the optional `package` path. During preparation, resolve the real checkout, parse the selected marketplace manifest, resolve every entry, derive or resolve each package candidate, and classify each candidate as installable or intentionally absent. Reject the complete plan before side effects if any manifest, entry, or package candidate is invalid.

Build an ordered installation plan keyed by each existing manifest's real path. Iterate plugins in manifest order, retain the first occurrence of each real manifest, and invoke the existing Bun runner from that manifest's directory. Keep this planning and execution inside the marketplace plugin's storage/preparation implementation; generic plugin definitions and public plugin types remain unchanged.

The implementation PR is intentionally cross-cutting but atomic: it updates marketplace implementation and tests, the plugin-system specification, the plugin authoring manual, this change's approval/status/task state, and the exact `.gitignore` entry together.

### Decisions

- **Decision:** The default candidate is `dirname(real resolved entryPath)/package.json`.
  - **Why:** Package ownership follows the actual plugin module location and remains stable across contained entry symlinks.
  - **Alternatives considered:** Searching upward or falling back to the marketplace root was rejected because nested entries would acquire implicit dependencies from unrelated package boundaries.
- **Decision:** `package` points to the exact `package.json`, not a directory.
  - **Why:** Exact file paths make selection and validation unambiguous.
  - **Alternatives considered:** Directory overrides were rejected because they introduce filename inference and a second path form.
- **Decision:** A valid contained explicit override to an absent file skips installation, but malformed or unsafe overrides fail validation.
  - **Why:** This is the user's selected absence policy without allowing security errors or authoring mistakes to masquerade as optional dependencies.
  - **Alternatives considered:** Rejecting every missing override was not selected; skipping every invalid override was rejected as unsafe. The user explicitly approved this decision on 2026-08-04.
- **Decision:** Installations are deduplicated by real manifest path in first plugin occurrence order.
  - **Why:** Aliases and contained symlinks cannot trigger duplicate lifecycle execution, while manifest order remains deterministic.
  - **Alternatives considered:** Deduplicating lexical paths would miss aliases; sorting manifests would discard author-controlled first-use order.
- **Decision:** Resolve the complete plan before running any installation.
  - **Why:** An invalid later entry cannot leave earlier dependency side effects in an otherwise rejected staging checkout.
- **Decision:** The marketplace plugin exclusively owns the feature.
  - **Why:** Package manifests are marketplace orchestration vocabulary and do not belong in the generic host or public plugin contract.

### Non-Goals

- Searching parent directories for package manifests or falling back from nested entries to the marketplace root.
- Installing dependencies after marketplace installation, lazily at plugin load time, or separately for every plugin when manifests are shared.
- Introducing workspaces, lockfile policy, package-manager selection, dependency version solving, isolated dependency environments, or parallel installation.
- Sandboxing or disabling trusted dependency lifecycle scripts.
- Adding package-selection fields to generic host types, command context, or the public `@fx/tx/plugin` API.
- Changing marketplace command syntax, storage layout, discovery ordering, plugin initialization ordering, or failure isolation.
- Modifying completed historical change documents.
- Splitting this contract across multiple implementation PRs.

## Tasks

- [x] Implement and document per-plugin dependency manifests in one PR after explicit approval (PR #16)
  - [x] Record approval, set this change to `in-progress`, and preserve the one-PR scope.
  - [x] Extend marketplace-owned manifest validation and preparation with default and explicit package selection, strict containment/type/file validation, intentional missing-file skips, real-path deduplication, first-occurrence ordering, and validation-before-install.
  - [x] Preserve marketplace staging cleanup, trusted lifecycle execution, marketplace diagnostics, compiled standalone Bun re-entry, and generic core/public API boundaries.
  - [x] Add Bun unit, integration, failure, ordering, symlink-safety, staging-cleanup, and standalone executable coverage for every acceptance scenario while preserving required coverage.
  - [x] Update the active plugin-system specification and plugin manual, add the exact `.claude/worktrees/` ignore entry, and leave completed historical change documents unchanged.
  - [x] Run `bun run check` and all targeted standalone and boundary tests, then mark this change complete with the implementing PR number only after every gate passes.

## Open Questions

- [x] **Approved 2026-08-04:** The user approved the explicit missing-override safety distinction and the complete contract above for implementation in one PR.

## References

- Spec: [Plugin System](../specs/plugin-system/)
- Testing conventions: [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions)
- Depends on: [0004 Automate Versioning and Publishing](./0004-automate-versioning-and-publishing.md)
- Architectural predecessor: [0003 Externalize Marketplace Plugin](./0003-externalize-marketplace-plugin.md)
- Practical guidance to update during implementation: [Plugin Manual](../manual/plugins.md)
