# 0042: Harden Quality and Dependencies

**Spec:** [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** —

## Summary

Refresh the runtime and vulnerable dependencies, make package-consumer validation independent of the global cache, and bring the landing site into the quality gates.

## Motivation

The runtime and locked dependencies need security updates. The packed consumer test assumes globally cached package manifests, the site is not validated on pull requests, and Bun 1.4 reports previously uncovered production lines.

## Requirements

### Testing Requirements

This change must satisfy the standing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions).

- Tests use Bun; observable behavior has automated tests.
- Production source maintains 100% statement, function and line coverage without broadening exclusions.
- Type checking, Biome and `bun run check` pass.
- Every first-party executable is linted, type checked and covered by tests.

Weakening these rules to land the change is a defect in the change.

### Quality and dependencies

The [Architecture](../specs/architecture/index.md) owns the runtime, development and CI requirements. This change updates the pinned toolchain and vulnerable dependencies, tests the real packed consumer without a global cache, and adds a pull-request site gate and component tests. Package auditing cannot assess `@fx/ui`: GitHub Packages returns 404 for its audit endpoint, so the site audit skips it.

## Tasks

- [x] Harden dependencies and complete the quality gates.
  - [x] Upgrade Bun, compatible dependencies and vulnerable transitive dependencies; align workflows and review guidance.
  - [x] Make the packed consumer test independent of global cache state.
  - [x] Add site pull-request validation, component tests and source coverage.
  - [x] Restore root 100% coverage on Bun 1.4.4 and pass `bun run check`.

## Design

The consumer fixture installs the actual packed archive with local dependency copies from the frozen install and an empty cache. The site runs its own coverage and TypeScript checks because its browser build has separate dependencies.
