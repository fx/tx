# Updates

## Overview

`tx` keeps two kinds of installed things current: the executable itself, and whatever plugins have installed on the user's behalf. One command, `tx update`, gathers what could change and applies it. Nothing about it is automatic — `tx` never checks for a new version on an invocation the user did not spend on updating.

The command belongs to a bundled update plugin that knows nothing about marketplaces or executables. It drives *update participants* contributed by other plugins through the generic host contribution mechanism owned by [Plugin System: Update Participation](../plugin-system/index.md#update-participation). Two bundled plugins participate: the marketplace plugin, which owns installed marketplace checkouts, and the executable plugin, which owns the running `tx` binary and claims no namespace of its own.

This spec describes the desired state. None of it is implemented yet; [Change 0011](../../changes/0011-add-generic-update-lifecycle.md) through [Change 0014](../../changes/0014-update-the-tx-executable.md) implement it in that order.

## Requirements

### Never Automatic

- `tx` MUST NOT check for updates of anything, ever, except while running an update command the user invoked.
- No invocation that is not an update command MAY perform a network request, read a cached update result, or print an update notice. This binds plugin initialization, command dispatch, `--version`, `--help`, and every command any bundled plugin defines.
- `tx` MUST NOT install, schedule, or rely on a background process, timer, daemon, or shell hook to check for or apply updates.
- `tx` MUST NOT persist "an update is available" as state. A gathered result lives as long as the command that gathered it.
- These prohibitions are absolute and are not configurable. There is no opt-in flag, environment variable, or configuration key that turns automatic checking on, because a setting that exists gets set.

#### Scenario: A normal invocation stays offline

- **GIVEN** a newer `tx` release and newer marketplace commits exist
- **WHEN** the user runs any command other than an update command, including `tx --version`
- **THEN** no network request is made, no update notice is printed, and nothing is written to disk about available versions

### The Update Command

- The update plugin MUST claim the namespace `update` and MUST define its behavior at that namespace's root, so `tx update` is the whole command.
- `tx update` MUST gather what every committed participant reports, apply everything applicable, and report the outcome.
- `tx update --dry-run` MUST gather and report exactly what `tx update` would gather, and MUST apply nothing. It MUST NOT download, fetch, write, move, or delete anything outside a temporary location it removes before returning, and MUST NOT run a participant's apply step.
- `tx update` MUST accept optional positional arguments naming items to update. With none, every gathered item is in scope. With one or more, only items whose names match are in scope, and a name matching no gathered item MUST be reported as an error. Names are matched exactly; a name owned by more than one participant selects every item that carries it.
- Gathering MUST run every participant, in the order the host committed them, which follows composition order. Applying MUST run in the same order, so the executable — composed last — is applied after everything a plugin owns.
- Applying MUST be sequential. Two participants MUST NOT apply concurrently, because an update runs trusted lifecycle code and its output belongs to a user reading one thing at a time.
- Every gathered item MUST be reported with its name, its current version label, and either the version label it would move to or an indication that nothing is available. A participant MAY supply one line of detail per item, which MUST be reported as it is.
- An item that is already current MUST still be reported, so `tx update --dry-run` answers "is anything out of date" without the user having to interpret silence.
- Version labels are opaque to the command. It MUST NOT parse, compare, or order them; deciding whether something is out of date belongs to the participant that owns it.
- A participant that fails while gathering MUST NOT prevent other participants from being gathered, applied, or reported. Its failure MUST be reported against its own name and MUST make the command exit non-zero.
- A participant that fails while applying one item MUST NOT prevent the remaining items, of its own or of any other participant, from being applied. Each failure MUST be reported against the item it belongs to and MUST make the command exit non-zero.
- `tx update` MUST exit zero when every in-scope item either applied successfully or had nothing to apply, and non-zero when any gather or apply failed.
- `tx update --dry-run` MUST exit zero when gathering succeeded, whether or not updates are available. An available update is not a failure, and a dry run that exits non-zero for one cannot be used to check anything.
- Progress and results MUST be written through the injected context streams. Results MUST go to standard output and failures to standard error, so a user can pipe one without losing the other.
- An update command MUST work while an installed plugin is broken. Gathering and applying MUST depend only on what participants read from storage, never on a plugin having loaded successfully, because updating is how a user fixes a marketplace whose current commit does not load.

#### Scenario: Dry run applies nothing

- **GIVEN** an out-of-date marketplace and an out-of-date executable
- **WHEN** the user runs `tx update --dry-run`
- **THEN** both are reported with their current and available versions, the marketplace checkout and the executable are byte-for-byte unchanged, and the command exits zero

#### Scenario: One failure does not stop the run

- **GIVEN** three items are in scope and applying the first fails
- **WHEN** `tx update` runs
- **THEN** the remaining two are still applied, the failure is reported on standard error against the item that failed, and the command exits non-zero

#### Scenario: Updating a broken marketplace

- **GIVEN** an installed marketplace whose current commit fails to load, so its recovery diagnostic is printed on every invocation
- **WHEN** the user runs `tx update`
- **THEN** the marketplace is gathered and updated like any other, and a commit that loads resolves the failure

#### Scenario: Nothing to do

- **GIVEN** every installed item is current
- **WHEN** the user runs `tx update`
- **THEN** each item is reported as current, nothing is fetched or written, and the command exits zero

### Marketplace Updates

The marketplace plugin contributes one participant covering every installed marketplace. [Plugin System: Marketplace Plugin Ownership](../plugin-system/index.md#marketplace-plugin-ownership) owns marketplace storage, names, classification, manifests, and clone behavior; this section owns only what updating one means.

- Each installed marketplace MUST be gathered as one item named by its local marketplace name.
- A cloned marketplace's version label MUST identify the commit its checkout holds, and MUST prefer a tag reachable from that commit when one exists, so a user reads `v1.4.0` rather than a bare hash where the marketplace publishes tags.
- A referenced local marketplace MUST be reported as live and MUST NOT be fetched, moved, or modified. Its contents are whatever its directory holds when `tx` runs, so it has no version to compare and nothing to apply.
- Gathering a cloned marketplace MUST contact its recorded remote to learn what is available, and MUST NOT modify the checkout: after gathering, the working tree, the checked-out commit, and installed dependencies MUST be exactly as they were. Updating remote-tracking state is not a modification of the checkout.
- Gathering MUST resolve what the marketplace tracks: the remote's current default branch when it is not pinned, and its pinned ref when it is, per [Marketplace Versions and Pins](#marketplace-versions-and-pins).
- Network operations MUST be non-interactive, on the same terms clone attempts already are — no Git terminal prompt, and SSH batch mode unless the caller configured an SSH command. `tx update` walks every installed marketplace, so one prompt would stall the whole run against a transport the user was not asked about.
- A fetch MUST use the remote recorded in the checkout, exactly as it stands. The SSH retry that [Plugin System: Marketplace Plugin Ownership](../plugin-system/index.md#marketplace-plugin-ownership) requires of `marketplace add` MUST NOT be applied to a fetch: the recorded remote is the source the marketplace was successfully cloned from, so there is no second spelling of it to try.
- Applying MUST move the checkout to the resolved target commit and MUST NOT merge, rebase, or create a commit.
- Applying MUST refuse a checkout carrying modifications to tracked files, and MUST report the marketplace as blocked rather than discarding them. Untracked files MUST NOT block an update, because dependency installation puts them there.
- An unpinned marketplace MUST only move forward: applying MUST refuse when its current commit is not an ancestor of the target, which is what a force-pushed or rewritten upstream looks like, and MUST report it as blocked with the remedy. A pin MAY move a checkout to any commit, in either direction, because the user named it.
- After the checkout moves, the marketplace MUST be validated and its selected dependency manifests installed exactly as they are when it is added, since the new commit may declare different plugins or different dependencies.
- If validation or installation fails after the checkout moved, the checkout MUST be restored to the commit it held before, and the marketplace MUST be reported as failed. Restoring the checkout does not restore installed dependencies: installation is trusted code that owns what it writes, and `tx` MUST NOT claim to have undone it.
- A marketplace whose checkout did not move MUST NOT be revalidated or reinstalled. Applying nothing MUST cost nothing.
- Each marketplace MUST be applied independently. A marketplace that is blocked or fails MUST NOT prevent another from updating.
- Marketplaces MUST be gathered and applied in the same deterministic name order the plugin already uses for discovery.

#### Scenario: A marketplace moves forward

- **GIVEN** an installed cloned marketplace whose remote default branch has advanced
- **WHEN** the user runs `tx update`
- **THEN** the checkout moves to the remote's commit, the marketplace is revalidated, its selected dependency manifests are installed, and the new version label is reported

#### Scenario: A live reference is never touched

- **GIVEN** an installed marketplace that references a local directory
- **WHEN** the user runs `tx update`
- **THEN** it is reported as live with nothing to apply, and nothing in the referenced directory is fetched, moved, or modified

#### Scenario: Local modifications block the update

- **GIVEN** an installed cloned marketplace with an edited tracked file
- **WHEN** the user runs `tx update`
- **THEN** the marketplace is reported as blocked, the edit is intact, the checkout has not moved, and the command exits non-zero

#### Scenario: A rewritten upstream blocks the update

- **GIVEN** an unpinned marketplace whose remote branch was force-pushed, so its current commit is no longer an ancestor of the remote's
- **WHEN** the user runs `tx update`
- **THEN** the marketplace is reported as blocked with the remedy, the checkout has not moved, and other marketplaces still update

#### Scenario: A failed preparation restores the commit

- **GIVEN** a marketplace whose new commit carries an invalid manifest or a failing dependency installation
- **WHEN** `tx update` applies it
- **THEN** the checkout is restored to the commit it held before, the marketplace is reported as failed, and the command exits non-zero

### Marketplace Versions and Pins

- `marketplace add` MUST accept a version suffix on its source, spelled `<source>@<ref>`, where the ref is any commit-ish the remote publishes: a tag, a branch, or a commit hash. `tx marketplace add fx/cc@1.4.0` installs that version.
- A ref MUST be taken from the source only when the source is not a local directory. [Plugin System: Local Marketplace Sources](../plugin-system/index.md#local-marketplace-sources) classifies the argument exactly as it is typed, first and unchanged; only a source that classification hands to Git MAY be split. A directory named `tools@2` is therefore added as a local reference under that name, not as `tools` at ref `2`.
- Within a Git source, the ref MUST be separated by the last `@` that follows the source's last `/`. That leaves an SSH source's `git@host` and an HTTP(S) source's userinfo alone, since neither `@` follows the last `/`, and it needs no list of source forms.
- A ref suffix MUST be rejected when it is empty, and a ref that does not exist on the remote MUST fail the addition and publish nothing.
- A version suffix MUST NOT contribute to a derived marketplace name. `fx/cc@1.4.0` installs as `cc`.
- A local source given with a version suffix MUST be rejected, naming the reason: a reference is live, so there is no version to pin it to.
- A pinned marketplace MUST record the ref it was pinned to, as the user spelled it, and MUST keep it across updates.
- An unpinned marketplace MUST track its remote's current default branch, and MUST keep tracking it when the remote's default branch is renamed.
- Gathering a pinned marketplace MUST report the pin, and MUST report the commit its ref currently resolves to as what is available. A pin to a tag or a hash resolves to the same commit forever and so reports nothing to apply; a pin to a branch moves with that branch.
- Gathering a marketplace pinned to a tag SHOULD additionally report a newer tag published by the remote, as detail, without proposing to apply it. A user who pinned a version still wants to learn a newer one exists; moving them off the version they pinned without being asked would defeat the pin.
- `marketplace pin` MUST set an installed marketplace's pin to a given ref, and MUST take effect on the next update rather than moving the checkout itself. `marketplace unpin` MUST clear it, returning the marketplace to tracking its remote's default branch.
- Pinning MUST reject a ref the remote does not publish, and MUST leave the previous pin in place when it does.
- Pinning a referenced local marketplace MUST be rejected for the same reason a local source cannot carry a version suffix.
- `marketplace list` MUST report each marketplace's version label alongside its name and source, and MUST report a referenced local marketplace as live. Listing MUST NOT contact any remote.

#### Scenario: Adding a pinned version

- **GIVEN** the user runs `tx marketplace add fx/cc@1.4.0`
- **WHEN** the marketplace is installed
- **THEN** it is installed as `cc` at the commit `1.4.0` names, its pin is recorded, and `marketplace list` reports that version

#### Scenario: A pin survives an update

- **GIVEN** a marketplace pinned to a tag and a newer tag published on its remote
- **WHEN** the user runs `tx update`
- **THEN** the marketplace is reported as pinned with the newer tag noted, the checkout does not move, and the command exits zero

#### Scenario: A directory beats a version suffix

- **GIVEN** an existing local directory named `tools@2`
- **WHEN** the user runs `tx marketplace add ./tools@2`
- **THEN** it is added as a live local reference named `tools@2`, and no ref is parsed from the argument

#### Scenario: Unpinning resumes tracking

- **GIVEN** a marketplace pinned to `v1.4.0` and a remote default branch well ahead of it
- **WHEN** the user runs `tx marketplace unpin cc` and then `tx update`
- **THEN** the marketplace moves to the remote's default branch commit

### Executable Updates

The executable plugin contributes one participant covering the running `tx` binary. It defines no commands and therefore claims no namespace.

- The item MUST be named `tx`, its current version MUST be the version the running executable reports, and its available version MUST be the version of the project's latest published release.
- The participant MUST determine the available version from the project's own release publication, whose version is identical to the published package's by [Architecture: Runtime and Distribution](../architecture/index.md#runtime-and-distribution). One source of truth serves every installation shape.
- The available version MUST be compared to the running version as a semantic version. An equal or older published version MUST report nothing to apply, so a locally built executable ahead of the last release is never downgraded.
- A published-release lookup MUST send an authentication token when the environment supplies one, and MUST work without one. The token exists to raise a rate limit, not to reach anything private.
- The participant MUST refuse to apply anything when the running program is not a compiled `tx` executable. Running from a source checkout makes the running program the Bun runtime, and replacing it would overwrite the user's Bun. This MUST be reported as nothing to apply rather than as a failure.
- The participant MUST refuse to apply anything when the running platform has no published executable for it, reporting the platform and the platforms that are published.
- When the executable is installed by a version manager, applying MUST delegate to that manager's own upgrade command rather than replacing the file. Replacing a file inside a manager's store leaves the manager recording a version that is not what is on disk, and its next install silently reverts the update.
- Delegation MUST identify the manager from the executable's own resolved location, MUST ask the manager which tool owns that location rather than reconstructing the tool's name from the path, and MUST report the manager's command, its output, and its outcome. A manager that cannot be interrogated MUST be reported as a failure; the participant MUST NOT fall back to replacing a file inside a store some manager owns.
- When no version manager owns the executable, applying MUST download the published executable for the running platform, verify it against the checksum published alongside it, and refuse on any mismatch.
- A verified download MUST be checked by running it and requiring it to report the version that was published, before it replaces anything.
- Replacement MUST be atomic and MUST leave the installed executable untouched on every failure: the downloaded executable is staged beside the target, made executable, verified, and then moved onto the target in one step. A partially written file MUST NOT be reachable under the installed name at any point.
- Every temporary file the participant creates MUST be removed on every exit path, and a removal the filesystem refuses MUST NOT replace the failure that preceded it.
- When the executable's location is not writable and no version manager owns it, applying MUST report that, naming the path. `tx` MUST NOT attempt to acquire privileges.
- After a successful update, the participant MUST report the version now installed, observed rather than assumed. Where a delegated upgrade makes the new executable's location unknowable, the participant MUST report what the manager reported instead of naming a version it did not observe.

#### Scenario: Direct replacement

- **GIVEN** a compiled `tx` at a writable path no version manager owns, and a newer published release
- **WHEN** the user runs `tx update`
- **THEN** the published executable is downloaded, its checksum verified, its version confirmed by running it, moved onto the installed path in one step, and the new version reported

#### Scenario: Managed installation delegates

- **GIVEN** `tx` was installed by a version manager and a newer release exists
- **WHEN** the user runs `tx update`
- **THEN** the manager's own upgrade command runs for the tool that owns that path, its output is reported, and no file inside the manager's store is replaced by `tx`

#### Scenario: Checksum mismatch aborts

- **GIVEN** the downloaded executable does not match its published checksum
- **WHEN** `tx update` applies the executable item
- **THEN** nothing is replaced, no temporary file remains, the failure is reported, and the command exits non-zero

#### Scenario: Source checkout is not updated

- **GIVEN** `tx` is being run from a source checkout rather than as a compiled executable
- **WHEN** the user runs `tx update`
- **THEN** the executable item reports nothing to apply, the Bun runtime is untouched, and marketplace items still update

#### Scenario: Unwritable location is reported

- **GIVEN** a compiled `tx` at a path the user cannot write and no version manager owns
- **WHEN** the user runs `tx update`
- **THEN** the failure names the path, no privilege escalation is attempted, and the command exits non-zero

## Design

### One Driver, Many Owners

The update plugin holds no knowledge of what it updates. It asks each participant what it has, prints that, and — unless the run is a dry run — asks each participant to apply the items in scope. Everything domain-specific lives with the plugin that owns the domain: the marketplace plugin knows what a marketplace version is because it owns the checkout, and the executable plugin knows how a release is published because it owns the binary.

That boundary is what makes `tx update` extensible without being modified. A third-party plugin that installs something of its own — a model, a template set, a language server — contributes a participant and appears in `tx update` alongside the bundled two, with no change to the update plugin, and no marketplace vocabulary anywhere in it.

It also decides where version comparison lives. The driver treats a version as an opaque label precisely because a participant may not be versioning anything the driver could compare: a marketplace's version is a commit that only its own history orders, and the executable's is a semantic version. Asking each participant "have you got anything to apply" instead of comparing labels centrally keeps the driver honest.

### Why the Executable Is a Plugin

The executable updater could have been part of the update plugin, and is not. Keeping it separate means the update plugin has exactly one job and no privileged participant, and it makes the composition root — not the driver — decide that the executable is applied last. It also demonstrates the contract the spec claims: a plugin that contributes a participant and no commands.

### Ordering

Participants run in the order the host committed them, which is the order the composition root lists the default plugins. Placing the executable plugin after the marketplace plugin makes marketplaces update first and the executable last. That way a failure updating the executable leaves the marketplaces already updated, and the executable is replaced as the last thing the process does with the filesystem.

## Constraints

- Automatic checking is not merely disabled; it is not implemented. See [Never Automatic](#never-automatic).
- Rollback of a marketplace update, beyond restoring the previous commit when preparation fails, is out of scope. A user reaches an older version by pinning to it.
- Signing and provenance verification remain out of scope for marketplaces, unchanged by this spec. The executable's published checksum is an integrity check on a download, not a signature.
- Updating one plugin inside a marketplace independently of the rest is out of scope. A marketplace is one Git checkout and moves as one.
- The published executable exists for the platforms [Architecture: Runtime and Distribution](../architecture/index.md#runtime-and-distribution) names, and self-update reaches no further than those.

## Open Questions

- Should `tx update` offer machine-readable output? Line-oriented output greps well enough for now, and a format is worth defining once something is consuming it.
- Should a participant be able to report progress while applying, rather than only a result? Nothing here needs it yet; a long dependency installation may change that.
- Should a marketplace pinned to a tag be able to follow tags matching a range, rather than an exact ref? That is a dependency-resolution feature and wants a version policy the manifest does not have.
- Should `tx update` be able to update a marketplace that is blocked by local modifications, given an explicit flag? The remedy today is to resolve them in the checkout, which is what a user editing an installed clone should be doing anyway.

## References

- [Plugin System](../plugin-system/)
- [Architecture](../architecture/)
- [Change 0011: Add a Generic Update Lifecycle](../../changes/0011-add-generic-update-lifecycle.md)
- [Change 0012: Update Installed Marketplaces](../../changes/0012-update-installed-marketplaces.md)
- [Change 0013: Pin Marketplace Versions](../../changes/0013-pin-marketplace-versions.md)
- [Change 0014: Update the tx Executable](../../changes/0014-update-the-tx-executable.md)
- [Git fast-forward merges](https://git-scm.com/docs/git-merge#_fast_forward_merge)
- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-07 | Initial desired update lifecycle, marketplace updates and pins, and executable self-update | [0011-add-generic-update-lifecycle](../../changes/0011-add-generic-update-lifecycle.md) |
