# 0032: Publish a Linux arm64 Executable

## Summary

Publish a standalone Linux arm64 (glibc) executable, `tx-linux-arm64`, on every GitHub Release beside `tx-linux-x64`, with one `SHA256SUMS` covering both, and let an arm64 `tx` update itself from it. The executable is cross-compiled with Bun on the existing x64 runner and run natively on a GitHub-hosted arm64 runner before anything about the release is published. [Architecture: Runtime and Distribution](../specs/architecture/index.md#runtime-and-distribution) and [Architecture: Continuous Integration](../specs/architecture/index.md#continuous-integration) own the behavior.

**Spec:** [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** 0004, 0015

## Motivation

`tx` is published for exactly one platform: Linux x64 with glibc. There is no arm64 build of any kind, so `tx` cannot be installed on an arm64 Linux machine — a Graviton or Ampere server, a Raspberry Pi, an arm64 container on an Apple Silicon laptop — even though nothing in the program is specific to x86. `mise use -g github:fx/tx` finds no asset for the architecture, and the npm package declares `cpu: ["x64"]`.

That is a scoping decision, not a limitation. [Change 0004](./0004-automate-versioning-and-publishing.md) listed arm64 among the platforms it left out of scope, and [Architecture](../specs/architecture/index.md#open-questions) left additional architectures as an open question for a future change. Bun cross-compiles a standalone executable for `bun-linux-arm64` from an x64 host, and GitHub hosts arm64 Linux runners for public repositories, so the cost of answering it is a build target and a release job.

Publishing the asset alone would not be enough. [Change 0015](./0015-update-the-tx-executable.md)'s participant decides whether an executable can be replaced from a fixed list of published platforms; an arm64 `tx` installed from the new asset would read `linux-arm64` as unpublished and refuse every update — `#irreplaceable()` in `plugins/executable/updater.ts` would report "no executable is published for linux-arm64" while one is.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- The production build test MUST assert what each executable is, not only that it exists: both MUST carry the ELF magic, `dist/tx` MUST declare the x86-64 machine (`e_machine` `0x3e`) and `dist/tx-linux-arm64` MUST declare AArch64 (`0xb7`). An x64 build written under the arm64 name would otherwise pass.
- Self-update MUST be covered for `linux-arm64` on each path it takes: gathering offers the newer release; a direct replacement downloads `tx-linux-arm64` and verifies it against its own line of `SHA256SUMS` rather than the x64 line; a release whose `SHA256SUMS` predates the arm64 asset is refused without touching the installed executable; and a mise-owned install delegates exactly as on x64.
- Subprocess execution and downloads MUST stay injected through the existing seams. **No test may execute a real `tx`, `mise`, or `npm`, or download a published asset.**
- Committed tests MUST NOT contain unjustified focused or skipped cases.

The release workflow itself can only run on a real release. Its jobs MUST pass `actionlint` and `shellcheck` locally, and the job that runs Release Please MUST keep its existing steps unchanged; the arm64 smoke test and the uploads are verified manually on the first release that carries this change.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Architecture: Runtime and Distribution](../specs/architecture/index.md#runtime-and-distribution) and [Architecture: Continuous Integration](../specs/architecture/index.md#continuous-integration) own the behavior and its scenarios, which are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **One build, both executables.** `bun run build` compiles `dist/tx` for `bun-linux-x64-baseline` and `dist/tx-linux-arm64` for `bun-linux-arm64` on every run, from one constant list of targets, and fails if either fails. There is no flag, environment variable, or host check that selects a subset.
- **The package stays x64.** `@fx/tx` keeps `cpu: ["x64"]` and its `files` allowlist keeps naming only `dist/tx`, so the arm64 executable is never packed.
- **The release gains a native gate.** The release workflow builds both executables once, runs the arm64 one on a GitHub-hosted arm64 runner — it must report the release version and print root help naming the bundled `marketplace` namespace — and only then publishes the package and uploads `tx-linux-x64`, `tx-linux-arm64`, and a `SHA256SUMS` listing both.
- **Self-update reaches arm64.** The executable plugin's published platforms become `linux-x64` and `linux-arm64`. Nothing else in the participant changes: it already names the asset after the running platform and already looks that asset's own line up in `SHA256SUMS`.

## Design

### Approach

Bun compiles a standalone executable for any target from any host by downloading that target's runtime once and appending the bundle to it, so the arm64 executable is built on the same x64 runner, from the same checkout, by the same `bun run check` that builds the x64 one. `build.ts` turns its single `Bun.build` call into a loop over a constant two-entry list; the Ink development-mode plugin is shared by both.

Cross-compiling proves the executable was produced, not that it runs. The release workflow therefore splits into four jobs:

1. **`release`** runs Release Please, dispatches and verifies release-PR CI, and resolves whether a release is to be published, with its steps unchanged. It no longer builds or publishes anything; it exposes the resolved SHA, tag, and version as job outputs.
2. **`build`** checks out the release SHA, verifies every version invariant, runs `bun run check`, confirms each executable's architecture, packs the npm package and confirms it is x64-only, and hands the package archive and both executables to later jobs as one artifact with their digests as job outputs.
3. **`smoke-arm64`** runs on `ubuntu-24.04-arm` without a checkout: it verifies the arm64 executable against the digest `build` reported and runs it with an empty home, requiring `--version` to print the release version exactly and `--help` to succeed with `Usage: tx` and `marketplace` in its output.
4. **`publish`** runs only when all three succeeded. It verifies every artifact against the digests `build` reported, publishes the package idempotently and confirms the registry serves the identical archive, exactly as before, then writes one `SHA256SUMS` over both executables and uploads all three assets, verifying their sizes.

Each job gets only the permissions it uses, so the jobs that run release code — `build` and `smoke-arm64` — hold read-only tokens, and nothing writes anywhere until the arm64 executable has run.

### Decisions

- **Decision:** Cross-compile on the x64 runner and smoke-test natively on arm64, rather than building on an arm64 runner.
  - **Why:** One build from one checkout keeps the two executables from the same source, the same lockfile install, and the same `bun run check`; building on two runners would mean two installs and two checks that could disagree. Bun's cross-compilation is a supported, documented path. What it cannot show is that the result starts on real hardware, which is the one thing the native job checks.
  - **Alternatives considered:** A matrix build per architecture was rejected as duplicating the whole validation for no additional assurance. Running the arm64 executable under QEMU on the x64 runner was rejected as proving it starts under emulation rather than on the hardware users run.

- **Decision:** The arm64 smoke test gates the npm publish as well as the asset uploads, although the package is x64-only.
  - **Why:** A release is one version published everywhere at once ([Architecture: Runtime and Distribution](../specs/architecture/index.md#runtime-and-distribution) requires one identical version across every artifact). Publishing the package and then failing to upload the assets would leave a release half-published, with a package version that can never be republished. Gating everything on the slowest check keeps a failure all-or-nothing.
  - **Alternatives considered:** Publishing the package before the smoke test finishes was rejected for the reason above.

- **Decision:** `bun run build` always compiles both targets from a constant, branch-free list.
  - **Why:** Every first-party file must be covered and checked, and a build that selected targets by host or flag would have paths CI never takes. The cost is a few seconds per build and a one-time download of the arm64 runtime.
  - **Alternatives considered:** Building arm64 only in the release workflow was rejected because the test suite could then never assert that the arm64 executable is produced and is AArch64.

- **Decision:** Target `bun-linux-arm64` rather than a baseline variant.
  - **Why:** Bun's baseline CPU variants exist only for x64; there is no `bun-linux-arm64-baseline`.

- **Decision:** Keep the npm package x64-only.
  - **Why:** A package whose `bin` names one executable cannot serve two architectures without a per-architecture package or a launcher choosing between bundled binaries, and either is a packaging change of its own. mise's GitHub backend already selects the release asset for the machine's architecture, and it is the recommended installation path.

### Non-Goals

- An arm64 npm package: `package.json` keeps `cpu: ["x64"]`, its `files` still names only `dist/tx`, and the package-consumer test is unchanged.
- macOS, Windows, and musl executables.
- Signing, attestations, or SBOM generation for either executable.
- An arm64 job in pull-request CI.
- Bringing root `build.ts` and `cli.ts` under the coverage walker, and reconciling the Bun version pinned in the workflows with the one named in `REVIEW.md`.
- Any change to `CHANGELOG.md`, which Release Please owns.

## Tasks

- [x] Specify the arm64 executable in [Architecture](../specs/architecture/)
  - [x] Name Linux arm64 with glibc as a supported platform and require the build to produce both executables
  - [x] Keep the package x64-only and require releases to carry both executables under one `SHA256SUMS`
  - [x] Require a native arm64 smoke test to gate every publication, with a scenario
  - [x] Narrow the open question on architectures, and update references, the changelog, the [Updates](../specs/updates/) changelog, and both documentation indexes

- [x] Compile both executables in `build.ts`
  - [x] Build `dist/tx` for `bun-linux-x64-baseline` and `dist/tx-linux-arm64` for `bun-linux-arm64` from one constant list, failing on either
  - [x] Assert each executable's ELF machine in `test/standalone.test.ts`

- [x] Let an arm64 `tx` update itself
  - [x] Add `linux-arm64` to the executable plugin's published platforms
  - [x] Cover gathering, replacement against the arm64 checksum line, a release predating the arm64 asset, and mise delegation on `linux-arm64` in `test/executable-plugin.test.ts`

- [x] Publish `tx-linux-arm64` from the release workflow
  - [x] Split `.github/workflows/release.yml` into `release`, `build`, `smoke-arm64`, and `publish` jobs with least-privilege permissions
  - [x] Run the arm64 executable natively and gate the package publish and every upload on it
  - [x] Upload both executables with one `SHA256SUMS` covering both

- [x] Amend the wording the change makes wrong
  - [x] `README.md`: supported platforms, the release flow, and its prerequisites
  - [x] `docs/manual/plugins.md`: the standalone installation sentence

- [x] Verify 100% coverage, `bun run check`, the packed package's contents, and `actionlint` and `shellcheck` on the workflows

## Open Questions

- [ ] Should macOS executables be published? Bun cross-compiles them as well, but an unsigned macOS executable is quarantined by Gatekeeper, so publishing one is really a decision about signing.
- [ ] Should a musl executable be published for Alpine and other musl distributions? It is one more compile target and one more native smoke test.
- [ ] Should the npm package serve arm64, through per-architecture packages or a launcher? Nothing installs `tx` from npm on arm64 today.

## References

- Spec: [Architecture](../specs/architecture/), [Updates](../specs/updates/)
- Related changes: [0004-automate-versioning-and-publishing](./0004-automate-versioning-and-publishing.md), [0015-update-the-tx-executable](./0015-update-the-tx-executable.md)
- External: [Bun executables](https://bun.sh/docs/bundler/executables), [GitHub-hosted runners](https://docs.github.com/en/actions/using-github-hosted-runners/using-github-hosted-runners/about-github-hosted-runners)
