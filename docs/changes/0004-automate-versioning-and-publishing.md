# 0004: Automate Versioning and Publishing

## Summary

Publish `@fx/tx` to GitHub Packages and a checksummed Linux x64 standalone executable to GitHub Releases through one Release Please-controlled workflow.

**Spec:** [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** 0003

## Approval

The user approved this contract on 2026-08-03, including the package scope, canonical `@fx/tx/plugin` API, Linux x64 baseline/glibc platform, MIT license, Release Please v4, manually merged release PRs, explicit CI dispatch, and same-invocation publication.

## Requirements

- The public package MUST be named `@fx/tx`; the CLI command remains `tx`, and the canonical public plugin type path is `@fx/tx/plugin`.
- GitHub Packages and GitHub Releases MUST carry the same version as `package.json`, the `v` tag, Release Please output, and the compiled binary.
- The first release supports Linux x64 with glibc and Bun's baseline CPU target only.
- The package MUST contain the compiled `dist/tx`, the public plugin type source and its required local type dependency, README, LICENSE, and package metadata only.
- The executable MUST run without Node.js or Bun installed. `tx --version` MUST return before plugin initialization.
- Release Please v4 MUST use the manifest/node strategy. Release PRs MUST be merged manually and MUST never be auto-merged.
- CI MUST retain its required `CI` job and run for pull requests, pushes to `main`, and explicit dispatches.
- Release orchestration MUST dispatch CI for every Release Please PR head and verify a `workflow_dispatch` run at that exact head SHA.
- Publication MUST use `GITHUB_TOKEN` with `packages: write` in the release workflow invocation that creates the release; it MUST NOT depend on tag or release events starting another workflow.
- Package publication MUST be idempotent by refusing to overwrite an existing version. Release assets MAY be safely replaced on retry.
- The primary install path is `mise use -g github:fx/tx`. GitHub Packages installation requires a classic PAT with `read:packages`, including for public packages.

## Scenarios

### Release PR validation

- **GIVEN** Release Please creates or updates a release PR
- **WHEN** release orchestration receives its branch and head SHA
- **THEN** it dispatches `ci.yml` for that branch and fails unless an exact-head `workflow_dispatch` run is observed and succeeds

### Same-run publication

- **GIVEN** a release PR is manually merged and Release Please creates a GitHub Release
- **WHEN** the release workflow continues
- **THEN** it checks out the release SHA, validates every version invariant, publishes the absent package version, and uploads the exact checksummed executable without relying on another event

### Installed executable

- **GIVEN** the packed package is installed on Linux x64 glibc
- **WHEN** `tx --version` runs with Bun and Node absent from `PATH`
- **THEN** it prints the package version and exits successfully before loading plugins

## Constraints

- The MIT license uses neutral copyright text: `2026 tx contributors`.
- Conventional commits determine versions and CHANGELOG entries; Release Please owns generated CHANGELOG updates.
- macOS, arm64, Windows, musl, npmjs.org, signing, attestations, SBOM generation, and automatic release-PR merging are out of scope.
- No first release, package publication, package visibility change, repository setting change, or release PR merge is performed by this change.

## Tasks

- [x] Record and index the approved distribution contract; amend architecture and plugin-system specifications.
- [x] Rename and package `@fx/tx`; add the license, deterministic build, version command, and package integration coverage.
- [x] Add Release Please configuration, dispatch-capable CI, and exact-SHA release orchestration.
- [x] Document installation, authentication, supported platform, plugin imports, and the manual release process.
- [x] Pass targeted tests, `bun run check`, production build, package inspection, and local workflow validation.

## Open Questions

None. GitHub package visibility and repository release settings remain explicit manual prerequisites.

## References

- [Architecture](../specs/architecture/)
- [Plugin System](../specs/plugin-system/)
- [Release Please](https://github.com/googleapis/release-please-action)
- [GitHub Packages npm registry](https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
