# 0014: Update the tx Executable

## Summary

Make `tx` able to update itself. A bundled plugin that defines no commands contributes an update participant for the running executable: it reports the installed version against the latest published release, and applying it either delegates to the version manager that installed `tx` or downloads the published executable, verifies its checksum, confirms its version, and moves it into place atomically.

**Spec:** [Updates](../specs/updates/)
**Status:** draft
**Depends On:** 0011

## Motivation

A user who installed `tx` with `mise use -g github:fx/tx` has a way to update it and probably does not remember what it is. A user who downloaded the release asset directly has none at all. Meanwhile `tx update` — after [0011](./0011-add-generic-update-lifecycle.md) and [0012](./0012-update-installed-marketplaces.md) — updates everything the user installed *through* `tx` while leaving `tx` itself behind, which is the one thing it would be strange for an update command not to cover.

The release side of this already exists and is strict. [Architecture: Runtime and Distribution](../specs/architecture/index.md#runtime-and-distribution) requires the tag, the `package.json` version, the compiled `tx --version`, the published package, and the release assets to be one identical version, and it requires the release to carry the executable alongside a SHA-256 checksum file. So the artifact to install, the version to expect, and the way to verify it are all already published — there is nothing to design about the source of truth, only about how to consume it.

The interesting problem is who owns the file. `tx` is normally installed by a version manager, and a self-updater that overwrites a file inside such a manager's store creates a specific, quiet failure: the manager still records the old version, `mise ls` and `mise current` report something that is not what is on disk, and the next install or reshim reverts the update without explanation. The alternative is not to refuse — a user who typed `tx update` wants `tx` updated — but to run the manager's own upgrade for them. It is what they would have typed, and it leaves the manager's records true.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable lookup, comparison, detection, delegation, verification, replacement, and failure behavior MUST have automated tests.
- Network access, subprocess execution, and the resolved executable path MUST be injected, exactly as Git and Bun execution already are in the marketplace plugin. **No test may reach the network, and no test may execute or replace any real executable.**
- Replacement MUST be tested against real files in a temporary directory the test owns, with a stub standing in for the downloaded executable, so that atomicity and cleanup are asserted against a filesystem rather than a mock.
- The checksum requirement MUST have a test whose downloaded bytes do not match the published digest, asserting that the installed file is byte-for-byte unchanged and that no temporary file remains.
- The source-checkout guard MUST have a test asserting that nothing is downloaded, executed, or replaced when the running program is not a compiled executable. A self-updater that can overwrite the Bun runtime is the worst outcome available here, and it MUST be covered directly.
- A test MUST assert that a dry run performs the version lookup and nothing else — no download, no subprocess, no write.
- Delegation MUST have tests for a manager-owned path, for a manager that cannot be interrogated, and for a path no manager owns, asserting in the second case that no file is replaced.
- A test MUST assert that a temporary file the filesystem refuses to remove does not replace the failure that preceded it, forced through a property of the path rather than a permission bit so it holds for a suite run as root as well as for one run as an ordinary user.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Updates: Executable Updates](../specs/updates/index.md#executable-updates) owns the participant's behavior and its scenarios, which are this change's acceptance criteria and are not restated here. [Architecture: Runtime and Distribution](../specs/architecture/index.md#runtime-and-distribution) owns what is published and under what version invariants.

What implementing them requires of this change:

- **A second bundled plugin, contributing a participant and no commands.** It is composed after the marketplace plugin, which is what makes the executable the last thing applied.
- **This plugin is deliberately not externalizable.** The marketplace plugin could be copied to another repository; this one is about *this* executable and names this project's repository and asset names. That is a property of what it owns, not a boundary violation, and the boundary rules it must still satisfy — no import from `src/` implementation, public types type-only — are unchanged.
- **The running version comes from injected dependencies.** `CoreDependencies` already carries it, so the participant never reads a package manifest.
- **Every effect is injected.** Network access, subprocess execution, and the resolved executable path are constructor options with real defaults, following the marketplace manager's existing shape.

## Design

### Approach

The participant answers three questions before it will do anything: is this a compiled `tx`, is there a published executable for this platform, and is the latest release newer than what is running. Any "no" reports an item with nothing to apply, which is a report rather than a failure — a user on an unsupported platform or a source checkout does not need `tx update` to exit non-zero over it. The first two are also why an available version is withheld rather than reported in those cases: the driver applies whatever is available, so offering a version this participant would only refuse would manufacture a failure. The newer release is still named, as detail.

Those two are the *only* gates on availability, and both are facts about the running program that cannot change while the command runs. Everything else that can stop an update — an unwritable target, a manager that will not answer, a checksum that does not match — is checked when applying and reported as a failure, because each can change between gathering and applying and each is something the user can act on. Probing writability during gathering would also mean answering a question whose answer is stale by the time it matters.

Gathering fetches the project's latest release, reads its tag, and compares it to the running version as a semantic version. Only a strictly greater published version, on an executable that could actually be replaced, produces an available version — so a locally built executable ahead of the last release is never dragged backwards.

Applying resolves the real path of the running executable and asks whether one of the two managers the project documents — mise and npm — owns it. A path neither owns is unmanaged, including one owned by some manager the participant cannot name: there is nothing to delegate to, and the replacement path below already reports an unwritable location rather than forcing past it.

- Under a recognized manager, the manager itself is asked which tool owns that path, and the manager's own upgrade command is run for that tool. Its output is reported. A manager that answers nothing usable is a failure, and the participant stops there rather than writing into a store it does not own.
- Otherwise the release's executable and checksum assets are downloaded, the digest is computed over the downloaded bytes and compared, the file is staged beside the target with the executable bit set, run once with the version flag and required to report the published version, and then moved onto the target in one rename. Same directory, so the rename is atomic, and the running process keeps the inode it is executing from.

Every failure path removes the staged file, through a helper that swallows a refused removal so that cleanup cannot replace the failure the user needs to read — the shape [0010](./0010-retry-marketplace-clones-over-ssh.md) established for clone staging, for the same reason.

### Decisions

- **Decision:** Delegate to the version manager that owns the executable instead of replacing the file, and do it without asking.
  - **Why:** Replacing a file inside a manager's store desynchronizes the manager from the disk: it keeps recording the old version, and its next install silently reverts the update. Refusing with instructions was the first proposal and is worse than delegating — the user typed `tx update` because they want `tx` updated, and printing a command for them to copy is an errand, not an answer.
  - **Alternatives considered:** Refusing with the manager's command printed was rejected as above. Replacing the file and then telling the manager about it was rejected: no manager has a stable interface for "I changed your store behind your back". Asking for confirmation was rejected as a prompt in a command whose whole purpose is the thing being confirmed.

- **Decision:** Recognize exactly mise and npm, and treat every other location as unmanaged.
  - **Why:** A requirement to delegate to "the version manager" without naming one is not implementable and not testable — there is no set to enumerate and no detection to write. mise and npm are the two paths [the installation guide](../../README.md#install) documents, so they are the two whose detection and upgrade commands can be verified. For anything else there is nothing to delegate *to*: the participant cannot run an upgrade for a manager it cannot name, and refusing on that manager's behalf would leave a user who installed `tx` some third way permanently unable to update it. The replacement path is the safe default there, and it reports an unwritable location instead of forcing one.
  - **Alternatives considered:** Refusing whenever the path looks managed by anything was rejected as guessing at a manager's store layout in order to withhold the feature. Adding managers speculatively was rejected as detection rules only their own users could verify, and is recorded as an open question.

- **Decision:** Ask the manager which tool owns the path, rather than reconstructing the tool's name from the path.
  - **Why:** The path encodes the tool name through a flattening that is not invertible — a backend and an owner and a repository collapse into one directory component with separators that also occur inside the names themselves. Guessing wrong means running an upgrade for a tool the user does not have, or for a different one they do. The manager already knows the answer and will report it.
  - **Alternatives considered:** Parsing the install path was rejected for that reason. Hardcoding the tool name was rejected because the same executable arrives through more than one backend.

- **Decision:** Verify the download against the published checksum, and then verify the staged file by running it.
  - **Why:** The checksum catches a truncated or corrupted download and a mismatched asset; running the file catches everything the checksum cannot — an asset published for the wrong platform, a release whose assets were rebuilt after the tag moved, an executable that will not start on this machine's libc. Discovering that after the rename means the user's `tx` is broken and they need `tx` to fix it. The check costs one process spawn against a file that already matched a checksum published by the project.
  - **Alternatives considered:** Trusting the checksum alone was rejected as verifying integrity but not usability. Trusting the run alone was rejected as executing unverified bytes. Signature verification was rejected as needing a signing story the project does not have; the checksum is an integrity check and the spec says so.

- **Decision:** Stage beside the target and replace with a single rename.
  - **Why:** A rename within one directory is atomic, so the installed name never refers to a partially written file, and on Linux the running process keeps executing the inode it started from, so `tx` can replace itself mid-command. Writing into the target file directly would leave a truncated executable behind on any failure — the one outcome that leaves the user unable to run the tool that would fix it.
  - **Alternatives considered:** Writing to a system temporary directory and renaming across filesystems was rejected: cross-device renames fail, and the copy fallback is exactly the non-atomic write being avoided. Backing up the old executable first was rejected as a file nothing removes and a rollback nobody invokes.

- **Decision:** Refuse to apply anything when the running program is not a compiled `tx`.
  - **Why:** From a source checkout the running program is the Bun runtime, so "replace the running executable" means overwriting the user's Bun with a `tx` binary. It is reported as nothing to apply rather than as a failure, because running from source is a normal thing for a contributor to be doing and it should not make `tx update` exit non-zero while marketplaces update fine.
  - **Alternatives considered:** Trusting the executable's filename was rejected as a check a `bun` renamed by anyone defeats in the dangerous direction. Failing loudly was rejected as noise on every contributor's `tx update`.

- **Decision:** Compare versions semantically and only offer a strictly greater release.
  - **Why:** The project's versions are semantic and released by Release Please, so ordering them is well defined. Comparing as strings would misorder `1.10.0` against `1.9.0`; comparing only for inequality would offer a "update" that downgrades a locally built executable, which contributors run constantly.
  - **Alternatives considered:** String equality was rejected for the downgrade. Trusting the release marked latest to always be newer was rejected because it says nothing about what is running.

- **Decision:** Send a token from `GH_TOKEN` or `GITHUB_TOKEN`, in that order, and from nothing else.
  - **Why:** The release assets are public, so no token is required; unauthenticated API access is rate limited per address, which a shared network can exhaust. Those two variables are what the GitHub CLI reads and what CI sets, so using them removes that failure for free. Naming them exactly is the point — "a token when the environment supplies one" would leave an implementation free to pick up something like the `read:packages` credential the installation guide has users configure for the npm registry, and send it to a host and endpoint it was never issued for. The precedence follows `gh`'s so that a user who overrode one deliberately gets the same result they get everywhere else.
  - **Alternatives considered:** Always requiring a token was rejected as making a public download need credentials. Never sending one was rejected as leaving a rate-limit failure with no remedy. Scanning the environment for anything token-shaped was rejected as exfiltration by accident.

- **Decision:** A separate bundled plugin rather than a participant inside the update plugin.
  - **Why:** The update plugin must have no privileged participant, or the extensibility [0011](./0011-add-generic-update-lifecycle.md) exists for is a claim rather than a demonstration. Separating them also puts "the executable is applied last" in the composition root, where ordering is already explicit, instead of inside the driver's logic.
  - **Alternatives considered:** Building it into the driver was rejected for both reasons. Putting it in the marketplace plugin was rejected as unrelated ownership.

### Non-Goals

- Signing and provenance verification. The published checksum is an integrity check, and the spec says so rather than implying more.
- Installing `tx` where it is not already installed, or changing how it was installed.
- Acquiring privileges to write an unwritable path. The failure names the path; what to do about it is the user's call.
- Rolling back to an earlier release. `tx update` moves toward the latest published version; an older one is installed the way it was installed the first time.
- Platforms with no published executable. [Architecture: Runtime and Distribution](../specs/architecture/index.md#runtime-and-distribution) decides what is published, and this change reaches exactly that far.
- Updating from anywhere other than the project's own published releases. There is no mirror, channel, or source override.
- Any automatic check for a new version. Prohibited by [Updates: Never Automatic](../specs/updates/index.md#never-automatic).
- Any change to `src/` or to the release workflow.

## Tasks

- [ ] Specify executable updating
  - [ ] Add [Updates: Executable Updates](../specs/updates/index.md#executable-updates) covering the item, version comparison, the compiled-program and platform guards, manager delegation, download verification, atomic replacement, cleanup, and reporting
  - [ ] Record in [Architecture: Runtime and Distribution](../specs/architecture/index.md#runtime-and-distribution) that the published executable and checksum are the self-update source
  - [ ] Add scenarios for direct replacement, delegation, a checksum mismatch, a source checkout, and an unwritable path
  - [ ] Update the specs' references and changelogs, and both documentation indexes

- [ ] Add the bundled executable plugin under `plugins/executable/`
  - [ ] Contribute an update participant and claim no namespace
  - [ ] Inject network access, subprocess execution, and the resolved executable path, with real defaults
  - [ ] Compose the plugin in `cli.ts` after the marketplace plugin, with the ordering stated

- [ ] Gather the executable item
  - [ ] Read the running version from injected dependencies and the latest published release from the project's releases
  - [ ] Send a token from `GH_TOKEN`, then `GITHUB_TOKEN`, and from no other variable
  - [ ] Compare semantically and report an available version only when the release is strictly greater and this executable could be replaced
  - [ ] Report nothing to apply for a source checkout and for a platform with no published executable, naming the reason and still naming the newer release as detail

- [ ] Apply through a version manager when one owns the executable
  - [ ] Detect mise and npm from the resolved executable path, treating every other location as unmanaged
  - [ ] Ask the manager which tool owns that path and run its upgrade command for that tool
  - [ ] Report the command, its output, and its outcome, and fail without replacing anything when the manager cannot be interrogated

- [ ] Apply by replacement when no manager owns the executable
  - [ ] Download the published executable and checksum assets for the running platform
  - [ ] Verify the digest and refuse on any mismatch
  - [ ] Stage beside the target with the executable bit set, run it, and require the published version
  - [ ] Replace the target with one rename, and report the version now installed
  - [ ] Report an unwritable location by name without attempting to acquire privileges
  - [ ] Remove every staged file on every exit path through a helper whose refused removal does not replace the failure that preceded it

- [ ] Cover the new behavior in a new test module
  - [ ] Gathering: newer, equal, older, and unparseable published versions; each recognized token variable present, both present, neither present, and an unrelated token-shaped variable that MUST NOT be sent; a lookup failure
  - [ ] Guards: a source checkout and an unsupported platform, asserting nothing is downloaded, executed, or replaced
  - [ ] Delegation: a manager-owned path, a manager that answers nothing usable, and an unowned path
  - [ ] Replacement against real files in a temporary directory: a successful swap, a checksum mismatch, a staged file whose version does not match, an unwritable target, and a refused cleanup that does not mask its failure
  - [ ] A dry run that performs the lookup and nothing else
  - [ ] Boundary: `test/plugin-boundary.test.ts` covering the new plugin directory

- [ ] Document `tx update` for the executable in `README.md` and `docs/manual/plugins.md`, in the pull request that implements it
- [ ] Verify 100% coverage and `bun run check`

## Open Questions

- [ ] Should the participant recognize package managers beyond the two documented installation paths? Each one added is a detection rule and a delegation command that only its own users can verify.
- [ ] Should a delegated upgrade re-resolve the executable afterwards to report the installed version, rather than reporting what the manager said? It is one more subprocess, and the manager's own output is what the user would have seen had they run it themselves.
- [ ] Should the release lookup fall back to listing releases when the latest one is a draft or a pre-release? The project publishes neither today.
- [ ] Should `tx update` report the release notes, or a link to them, after updating the executable? The release payload already carries them.

## References

- Spec: [Updates](../specs/updates/), [Architecture](../specs/architecture/)
- Related changes: [0011-add-generic-update-lifecycle](./0011-add-generic-update-lifecycle.md), [0004-automate-versioning-and-publishing](./0004-automate-versioning-and-publishing.md)
- Manual: [Plugins](../manual/plugins.md)
- External: [GitHub Releases API](https://docs.github.com/en/rest/releases/releases), [Bun single-file executables](https://bun.sh/docs/bundler/executables), [mise tool management](https://mise.jdx.dev/cli/upgrade.html)
