# 0044: Consolidate Marketplace and Terminal Helpers

## Summary

Reuse marketplace semantic version parsing and ordering, and share terminal test fixtures across dialog and grid suites.

**Spec:** [Plugin System](../specs/plugin-system/), [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** 0042, 0043

## Motivation

Release selection duplicated the marketplace's semantic version grammar and ordering. Dialog and grid tests repeated stream capture, polling, and frame parsing.

## Requirements

Release selection retains optional `v` prefixes, stable-only candidates, prerelease precedence, invalid-version rejection, and exact ordering of arbitrarily large numeric components. Shared fixtures preserve the existing terminal test behavior without introducing production dependencies between plugins. Production coverage remains at 100%; `bun run check` must pass.

## Tasks

- [x] Reuse the marketplace semantic version parser and comparator for release tags.
- [x] Consolidate terminal capture, polling, and frame helpers used by dialog and grid tests.
- [x] Run the repository checks and site checks.

## References

- [Plugin System](../specs/plugin-system/)
- [Architecture](../specs/architecture/)
