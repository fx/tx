# 0022: Exempt and Verify the tx Self-Update

## Summary

Make `tx update` tell the truth about updating `tx` itself. The delegated `mise upgrade` runs with mise's minimum release age disabled for that one command, so the release `tx` just offered is not withheld from the command sent to install it; and a delegated upgrade counts as applied only when the manager afterwards reports a newer version installed, so an upgrade that changed nothing is reported as nothing applied rather than as success. [Updates: Executable Updates](../specs/updates/index.md#executable-updates) owns both behaviors.

**Spec:** [Updates](../specs/updates/)
**Status:** draft
**Depends On:** 0015

## Motivation

`tx update` reported an update it did not perform:

```
tx      1.5.0   -> 1.6.0
tx      updated "mise upgrade github:fx/tx": mise WARN  newer github:fx/tx release 1.6.0 (released 2026-09-02, eligible 2026-09-03 04:23 UTC) ignored by minimum_release_age (24h); latest eligible release is 1.5.0; mise All tools are up to date
```

The installed executable was still 1.5.0. Two independent defects produced that line, and either one alone would still be a defect.

**The release was withheld from the command sent to install it.** mise's `minimum_release_age` setting defaults to 24h and defers any release younger than that. Nothing in this user's configuration set it; the default did. `tx` looks the release up from GitHub directly and so does not see that policy at all, which means the two halves of the command permanently disagree for a day after every release: gathering names `1.6.0` as available, and the upgrade `tx` then delegates refuses to install it. There is no flag, and no amount of re-running helps — the user is told about an update they cannot take, by the command whose job is to take it.

**A zero exit code was read as success.** `#delegate` (`plugins/executable/updater.ts:489-503`) reports `{ applied: true, detail: '"<command>": <output>' }` for any exit code of zero, and mise exits zero after warning that it ignored the release. The manager's own warning was faithfully printed and then contradicted by the word `updated` in front of it. That failure mode is not specific to release age: a tool pinned in the user's mise configuration, or an npm registry that has not yet published the version GitHub has, produces the same successful exit with nothing installed. This is also the honest answer to [0015](./0015-update-the-tx-executable.md)'s open question about whether a delegated upgrade should re-observe the installed version — it must, because that observation is the only thing separating "updated" from "ran a command".

Fixing only the first would leave `tx` claiming success for every other reason a manager can decline. Fixing only the second would leave `tx` correctly reporting, once a day for a day, that it cannot update itself.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable behavior MUST have automated tests — the environment the delegated command receives, and each outcome of the post-upgrade observation.
- Subprocess execution MUST stay injected through the existing runner seam. **No test may execute a real `mise`, `npm`, or `tx`, and no test may read the ambient environment for its expectations.**
- The environment the delegated child receives MUST be asserted directly, rather than inferred from the command succeeding. An override that silently stopped being passed would otherwise reintroduce the defect with every test still green.
- A test MUST assert that the override reaches the delegated upgrade and nothing else — the manager's listing commands MUST NOT carry it.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Updates: Executable Updates](../specs/updates/index.md#executable-updates) owns both behaviors and their scenarios, which are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **A per-child environment on the runner seam.** `RunCommand` currently takes only a command, so there is nowhere to put an override that must not escape one child. It gains an optional second argument carrying the complete environment for that child; the default `runCommand` passes it to `Bun.spawn` and spawns with the inherited environment when it is absent, so every existing call site and every existing test fake is unchanged.
- **The override belongs to the manager, not to `#delegate`.** The `Manager` record gains an optional set of environment entries that its upgrade command runs with. Only mise carries one, `MISE_MINIMUM_RELEASE_AGE=0`. `#delegate` merges it over the injected `env` and passes the result; the listing commands are run exactly as they are today.
- **The post-upgrade observation reuses the listing the delegation already reads.** `Installation` gains the version each manager's listing already reports — mise's JSON entries carry it beside `install_path`, and npm's parseable listing carries it in the `<name>@<version>` label the reader already splits. Re-reading the listing after the upgrade and taking the newest version reported for the upgraded tool is the whole check.
- **A delegated success reports the observed version.** `#delegate` returns `{ applied: true, version: <observed>, detail: '"<command>": <output>' }`, where it returned no version before. A non-move returns `applied: false` with the same detail plus the version still installed, and does not throw.
- **The existing delegation tests need their fake listings extended.** They assert `applied: true` against a fake runner whose listing is read once; each now needs a post-upgrade listing that reports the upgraded version, which is also what makes them cover the new observation rather than bypass it.

## Design

### Approach

`#delegate` grows one step at each end and keeps its shape. Before running the upgrade it builds the child's environment from the injected `env` plus whatever the owning manager declares its upgrade needs. After the upgrade exits zero it re-runs that manager's listing, finds the entries for the tool it just upgraded, and asks whether any of them names a version strictly newer than the one that was running — the same `isNewerRelease` ordering the participant already uses to decide whether a release is worth offering, so an unorderable version is not evidence of movement in either direction.

A non-zero exit is still a thrown failure, unchanged. What changes is only the meaning of a zero exit: it now says the command ran, not that anything moved.

The observation deliberately asks the manager rather than the filesystem. The participant's `target` is the *resolved* path of the running executable, which under mise is the install directory of the version that is running — after a successful `mise upgrade` that path either still holds the old version or has been removed entirely, so running `target --version` would report the old version on success and fail outright on the same success. The manager's listing is the only place that answers "what is installed now" for both managers with one mechanism, and keeping the manager's record true is the reason delegation exists in the first place.

### Decisions

- **Decision:** Override the manager's minimum release age unconditionally for `tx`'s own delegated upgrade, rather than only filling it in when the user has not set the variable themselves.
  - **Why:** The distinction cannot be drawn honestly. The deferral the user hit came from mise's built-in 24h default, not from anything they wrote; and a user who *did* choose a value can have written it either into `MISE_MINIMUM_RELEASE_AGE` or into `[settings]` in their mise configuration. An environment variable set by `tx` overrides the configuration file either way, so "only fill in when the variable is unset" would honor one spelling of a deliberate choice and silently override the other — an incoherent rule that is harder to explain than the unconditional one. Beyond that, `tx update` is not an unattended toolchain install: it is one command, typed by hand, naming this one tool, after `tx` has already printed the exact version it is about to install. Deferring at that point does not protect the user from a surprise; it refuses a request they made explicitly, with no way to say "yes, now". The blast radius is a single child process: the setting keeps applying to every other tool, every other mise invocation, and every other participant.
  - **Alternatives considered:** Honoring an explicitly set variable was rejected as above. Adding a `--force` or `--no-release-age` flag was rejected as new command surface for a decision the user already made by typing `tx update`, and it would leave the default broken. Writing the setting into the user's mise configuration was rejected outright — `tx` does not own that file, and a global policy change is not a defensible side effect of updating one tool. Detecting the warning in mise's output and retrying was rejected as parsing a human-readable message that is not a contract.

- **Decision:** Carry the override as a per-child environment on the runner seam, declared by the manager it belongs to.
  - **Why:** It keeps "which command gets this" a property of the manager definition instead of a conditional inside `#delegate`, so npm contributes none and reading the mise entry tells you exactly what it affects. Making it an optional argument leaves `runCommand`'s inherit-the-environment behavior as the default for every other call, so nothing else changes, and it puts the child's environment where a test can assert it byte for byte — the one assertion that keeps this fix from quietly evaporating.
  - **Alternatives considered:** Setting the variable on `process.env` before spawning was rejected as leaking into every later child in the process. Passing only the overrides and merging inside `runCommand` was rejected because it would merge against the ambient environment rather than the injected one, putting the merge outside the seam the tests own. Prefixing the command with `env MISE_MINIMUM_RELEASE_AGE=0` was rejected as depending on a program that may not exist and mangling the command that gets reported back to the user.

- **Decision:** Decide "did it move?" from the manager's own listing after the upgrade, comparing against the version that was running.
  - **Why:** It is the only observation that works for both managers with one mechanism, it reuses the reader and the ordering the file already has, and it asks the component whose record delegation exists to keep true. Running the executable is not an option: the resolved target is the old version's install path under mise, so it would report the old version on success or fail on success. Comparing against the running version rather than against the offered one keeps a manager that installs some other newer version — a release GitHub has not marked latest, a version the user pinned to — reported as the update it is, and names the version actually installed.
  - **Alternatives considered:** Requiring the manager to report exactly the offered version was rejected as calling a real upgrade a failure whenever the manager's idea of latest differs from GitHub's. Diffing install paths was rejected because npm installs into the same global prefix and its path never changes. Parsing the upgrade's output was rejected as reading a message with no contract behind it. Re-running the executable was rejected as above.

- **Decision:** An upgrade whose effect cannot be observed — the listing no longer reads, or names no orderable version — is reported as nothing applied rather than as success or as a failure.
  - **Why:** Claiming an update that was not observed is the defect being fixed, so an unobservable outcome cannot resolve in that direction. It is not a failure either: the command the user asked for ran and exited zero, nothing is broken, and nothing needs their attention beyond the detail line, which carries the manager's output. The cost is a rare false negative — "nothing to apply" for an upgrade that did happen — which the next `tx update` corrects and which leaves nobody believing they are on a version they are not.
  - **Alternatives considered:** Falling back to `applied: true` when the observation is unavailable was rejected as reinstating the bug for the one case where the participant knows least. Throwing was rejected as making an unreadable listing exit the command non-zero after a successful upgrade.

- **Decision:** Report a non-move through `applied: false` rather than as a failure, leaving the exit code at zero.
  - **Why:** It is the shape the driver already has for "the participant did not change anything", it renders as `nothing to apply` beside the manager's own explanation, and [the plugin guide](../manual/plugins.md#update-what-is-installed) already states that applying nothing is not a failure. Nothing here failed: a manager declining to install a release it considers too young, or a tool the user pinned, is the system working.
  - **Alternatives considered:** Throwing so that `tx update` exits non-zero was rejected for now — it changes the exit code of a command that did what it was asked, and it would fire on a deliberate pin. It is recorded as an open question, because an item that was offered and then did not move is arguably different from one that was never offered.

### Non-Goals

- Any change to the replacement path, its checksum verification, its staged run, or its rename. Those already observe the installed version by running the file they installed.
- Any change to gathering: it keeps reading the published release from GitHub and comparing semantically, and it MUST NOT learn what any manager considers eligible. That would put a manager's policy in front of the item's availability, which is exactly the coupling this change avoids.
- Recognizing any manager beyond mise and npm, or changing how either is detected.
- Any new flag, configuration key, or environment variable read from the user. The override is written, not read.
- Reading or writing the user's mise configuration, or changing any setting outside one child process.
- Any change to the update driver, its output format, or its exit codes.

## Tasks

- [ ] Specify the two behaviors in [Updates: Executable Updates](../specs/updates/index.md#executable-updates)
  - [ ] Require the delegated upgrade to run without the manager's minimum-release-age deferral, scoped to that one command
  - [ ] Require a delegated upgrade to count as applied only against an observed newer installed version, and drop the carve-out that let it name a version it did not observe
  - [ ] Add scenarios for a withheld young release and for an upgrade that changed nothing
  - [ ] Update the spec's references, changelog, and both documentation indexes

- [ ] Carry a per-child environment on the runner seam
  - [ ] Extend `RunCommand` with an optional environment argument and pass it through `runCommand` to `Bun.spawn`, leaving an absent argument spawning as it does today
  - [ ] Give `Manager` the environment entries its upgrade command runs with, set only for mise as `MISE_MINIMUM_RELEASE_AGE=0`, and merge it over the injected `env` in `#delegate`

- [ ] Report a delegated upgrade against what the manager installed
  - [ ] Record each listing's reported version in `Installation`, from mise's JSON entries and npm's `<name>@<version>` label
  - [ ] Re-read the owning manager's listing after a zero-exit upgrade and take the newest version it reports for the upgraded tool
  - [ ] Report `applied: true` with that observed version only when it is strictly newer than the running version
  - [ ] Report `applied: false` with the manager's output and the version still installed otherwise, including when the listing cannot be read or names nothing orderable, and keep a non-zero exit a thrown failure

- [ ] Cover the new behavior in `test/executable-plugin.test.ts`
  - [ ] Assert the exact environment the delegated mise upgrade receives, and that the listing commands receive no override
  - [ ] Assert npm's upgrade receives no override
  - [ ] A delegated upgrade the manager confirms moved: `applied: true` with the observed version
  - [ ] A delegated upgrade that exits zero with the version unchanged — the reported defect — asserting `applied: false`, the manager's output in the detail, and no version named
  - [ ] A post-upgrade listing that cannot be read, and one naming an unorderable version
  - [ ] Extend the existing delegation tests' fake listings so their post-upgrade read reports the upgraded version

- [ ] Amend the wording the change makes wrong, in the same pull request
  - [ ] `README.md`: the delegation sentence in the update section
  - [ ] `docs/manual/plugins.md`: the version-manager bullet under "Updating tx itself"

- [ ] Verify 100% coverage and `bun run check`

## Open Questions

- [ ] Should an item that was gathered as available and then did not move make `tx update` exit non-zero? It differs from an item that was never offered, but failing on a deliberate pin would be worse than reporting it.
- [ ] Should the participant tell the user *why* a delegated upgrade did not move, beyond passing the manager's own words through? Every reason it could name is a message with no contract behind it.
- [ ] Should npm's delegation grow an equivalent exemption? npm has no release-age policy today, and the manager record is the place to add one if it ever does.

## References

- Spec: [Updates](../specs/updates/)
- Related changes: [0015-update-the-tx-executable](./0015-update-the-tx-executable.md), [0012-add-generic-update-lifecycle](./0012-add-generic-update-lifecycle.md)
- Manual: [Plugins](../manual/plugins.md#update-what-is-installed)
- External: [mise `minimum_release_age`](https://mise.jdx.dev/configuration/settings.html), [mise upgrade](https://mise.jdx.dev/cli/upgrade.html)
