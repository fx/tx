# Updates

## Overview

`tx` keeps two kinds of installed things current: the executable itself, and whatever plugins have installed on the user's behalf. One command, `tx update`, gathers what could change and applies it. Nothing about it is automatic — `tx` never checks for a new version on an invocation the user did not spend on updating.

The command belongs to a bundled update plugin that knows nothing about marketplaces or executables. It drives *update participants* contributed by other plugins through the generic host contribution mechanism owned by [Plugin System: Update Participation](../plugin-system/index.md#update-participation). Two bundled plugins participate: the marketplace plugin, which owns installed marketplace checkouts, and the executable plugin, which owns the running `tx` binary and claims no namespace of its own.

[Never Automatic](#never-automatic) and [The Update Command](#the-update-command) are implemented as specified in [Change 0012](../../changes/0012-add-generic-update-lifecycle.md), which ships the driver, [Marketplace Updates](#marketplace-updates) in [Change 0013](../../changes/0013-update-installed-marketplaces.md), which contributes the first participant to it, and [Marketplace Versions and Pins](#marketplace-versions-and-pins) in [Change 0014](../../changes/0014-pin-marketplace-versions.md), which pins what that participant updates. The rest describes the desired state, and [Change 0015](../../changes/0015-update-the-tx-executable.md) supplies the executable. [Compatible Marketplace Versions](#compatible-marketplace-versions) is specified by [Change 0034](../../changes/0034-add-marketplace-tx-compatibility.md) and is not implemented yet: adding and updating an unpinned marketplace still target its remote's default branch whatever its manifest declares.

## Requirements

### Never Automatic

- `tx` MUST NOT check for updates of anything, ever, except while running an update command the user invoked.
- No invocation that is not an update command MAY contact a remote to learn what version of anything is available, read a cached update result, or print an update notice. This binds plugin initialization, command dispatch, `--version`, `--help`, and every command any bundled plugin defines. It binds update traffic only: a command whose own work is a network operation the user asked for — cloning a marketplace, resolving a ref the user named — is unaffected.
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
- `tx update --dry-run` MUST gather and report exactly what `tx update` would gather, and MUST NOT run any participant's apply step.
- Gathering is identical in both modes and MAY contact a remote, because learning what is available is what gathering is. What it MUST NOT do — in either mode — is change anything installed: no participant may move, replace, or delete a checkout, an executable, or an installed dependency while gathering. Bookkeeping a gather writes in order to answer the question, such as a repository's remote-tracking refs and the objects behind them, is not a change to anything installed.
- `tx update` MUST accept optional positional arguments naming items to update. With none, every gathered item is in scope. With one or more, only items whose names match are in scope, and a name matching no gathered item MUST be reported as an error. Names are matched exactly; a name owned by more than one participant selects every item that carries it.
- Gathering MUST run every participant in the order the host committed them, and applying MUST run in that same order. Commit order is the host's FIFO initialization order, so composing the executable plugin after every other default plugin places its participant after every participant those plugins contribute themselves. A participant contributed by a *child* definition — a plugin installed through a marketplace — is committed after every root, so it MAY be applied after the executable. That is harmless: replacing the executable does not affect the running process, which keeps executing the file it started from.
- Applying MUST be sequential. Two participants MUST NOT apply concurrently, because an update runs trusted lifecycle code and its output belongs to a user reading one thing at a time.
- Applying one item MUST end in exactly one of three ways, and each MUST be reported: the participant applied it, the participant applied nothing, or the participant failed. Applying nothing is not a failure and MUST NOT change the exit code — it is the answer for an item that turned out to be current by the time it was asked, or that the participant declined for a reason needing no action from anyone. A refusal the user has to resolve MUST be a failure instead, so the command exits non-zero while something is outstanding.
- Every gathered item MUST be reported with its name, its current version label, and either the version label it would move to or an indication that nothing is available. A participant MAY supply one line of detail per item, which MUST be reported as it is.
- An item that is already current MUST still be reported, so `tx update --dry-run` answers "is anything out of date" without the user having to interpret silence.
- Version labels are opaque to the command. It MUST NOT parse, compare, or order them; deciding whether something is out of date belongs to the participant that owns it.
- A participant that fails while gathering MUST NOT prevent other participants from being gathered, applied, or reported. Its failure MUST be reported against the identity of the plugin that contributed it, which the host records for exactly this purpose, and MUST make the command exit non-zero. A participant does not name itself.
- An item that reports its own failure MUST be reported as failed, MUST make the command exit non-zero, and MUST NOT be applied. Its siblings MUST be reported and applied normally: one unusable installation among several is not a reason to withhold the others, and it is exactly what a user runs an update to find out about.
- A participant that fails while applying one item MUST NOT prevent the remaining items, of its own or of any other participant, from being applied. Each failure MUST be reported against the item it belongs to and MUST make the command exit non-zero.
- `tx update` MUST exit zero when every in-scope item either applied successfully or had nothing to apply, and non-zero when any gather or apply failed.
- `tx update --dry-run` MUST exit zero when gathering succeeded, whether or not updates are available. An available update is not a failure, and a dry run that exits non-zero for one cannot be used to check anything. Gathering succeeded only when no participant failed and no item came back carrying a failure; either one exits non-zero in a dry run exactly as it does in a real one.
- Progress and results MUST be written through the injected context streams. Results MUST go to standard output and failures to standard error, so a user can pipe one without losing the other.
- A committed participant MUST be able to gather and apply while the things it manages are broken. What it reports MUST come from what it reads out of storage, never from a plugin having loaded successfully, because updating is how a user fixes a marketplace whose current commit does not load. A plugin that fails its own initialization contributes no participant at all, per [Plugin System: Update Participation](../plugin-system/index.md#update-participation) — which is why a participant covering installed things is contributed by the plugin that owns their storage rather than by the plugins loaded out of them.

#### Scenario: Dry run applies nothing

- **GIVEN** an out-of-date marketplace and an out-of-date executable
- **WHEN** the user runs `tx update --dry-run`
- **THEN** both are reported with their current and available versions, the marketplace's checked-out commit, working tree, and installed dependencies are unchanged, the installed executable is byte-for-byte unchanged, and the command exits zero

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
- **THEN** each item is reported as current, no participant's apply step runs, nothing installed changes, and the command exits zero

### Marketplace Updates

The marketplace plugin contributes one participant covering every installed marketplace. [Plugin System: Marketplace Plugin Ownership](../plugin-system/index.md#marketplace-plugin-ownership) owns marketplace storage, names, classification, manifests, and clone behavior; this section owns only what updating one means.

- Each installed marketplace MUST be gathered as one item named by its local marketplace name.
- A cloned marketplace's version label MUST identify the commit its checkout holds, and MUST prefer a tag reachable from that commit when one exists, so a user reads `v1.4.0` rather than a bare hash where the marketplace publishes tags.
- A referenced local marketplace MUST be reported as live and MUST NOT be fetched, moved, or modified. Its contents are whatever its directory holds when `tx` runs, so it has no version to compare and nothing to apply.
- Gathering a cloned marketplace MUST contact its recorded remote to learn what is available, and MUST NOT modify the checkout: after gathering, the working tree, the checked-out commit, and installed dependencies MUST be exactly as they were. Updating remote-tracking state is not a modification of the checkout.
- Gathering MUST resolve what the marketplace tracks: the remote's current default branch when it is not pinned, and its pinned ref when it is, per [Marketplace Versions and Pins](#marketplace-versions-and-pins). For an unpinned marketplace, [Compatible Marketplace Versions](#compatible-marketplace-versions) decides whether that branch's commit or one from its release history is the target.
- Fetching is a network operation and is therefore non-interactive on the terms [Plugin System: Marketplace Plugin Ownership](../plugin-system/index.md#marketplace-plugin-ownership) requires of every operation against a remote, which that section owns and this bullet only points at. It matters more here than anywhere else: `tx update` walks every installed marketplace, so one credential or host-key prompt would stall the whole run over a transport the user was not asked about.
- A fetch MUST use the remote recorded in the checkout, exactly as it stands. The SSH retry that [Plugin System: Marketplace Plugin Ownership](../plugin-system/index.md#marketplace-plugin-ownership) requires of `marketplace add` MUST NOT be applied to a fetch: the recorded remote is the source the marketplace was successfully cloned from, so there is no second spelling of it to try.
- Applying MUST move the checkout to the resolved target commit and MUST NOT merge, rebase, or create a commit.
- Applying MUST refuse a checkout carrying modifications to tracked files, and MUST report the marketplace as blocked rather than discarding them.
- An untracked file MUST NOT block an update on its own, because dependency installation puts untracked files in every checkout. An untracked file occupying a path the target commit tracks MUST block it: the file cannot be kept and moved to, and it MUST NOT be discarded to make room. That collision MUST be reported as blocked, naming the path.
- An unpinned marketplace MUST only move forward: applying MUST refuse when its current commit is not an ancestor of the target, which is what a force-pushed or rewritten upstream looks like, and MUST report it as blocked with the remedy. A pin MAY move a checkout to any commit, in either direction, because the user named it. The one exception for an unpinned marketplace is a target selected from its release history, which [Compatible Marketplace Versions](#compatible-marketplace-versions) owns.
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

#### Scenario: An untracked file in the way blocks the update

- **GIVEN** an installed cloned marketplace holding an untracked file at a path the target commit tracks
- **WHEN** the user runs `tx update`
- **THEN** the marketplace is reported as blocked naming that path, the file is intact, the checkout has not moved, and untracked files elsewhere in the checkout have blocked nothing

#### Scenario: A rewritten upstream blocks the update

- **GIVEN** an unpinned marketplace whose remote branch was force-pushed, so its current commit is no longer an ancestor of the remote's
- **WHEN** the user runs `tx update`
- **THEN** the marketplace is reported as blocked with the remedy, the checkout has not moved, and other marketplaces still update

#### Scenario: A failed preparation restores the commit

- **GIVEN** a marketplace whose new commit carries an invalid manifest or a failing dependency installation
- **WHEN** `tx update` applies it
- **THEN** the checkout is restored to the commit it held before, the marketplace is reported as failed, and the command exits non-zero

### Marketplace Versions and Pins

- `marketplace add` MUST accept a version suffix on its source, spelled `<source>@<ref>`, where the ref is a commit-ish the remote publishes — a tag, a branch, or a commit hash — whose own name contains no `@`. `tx marketplace add fx/cc@1.4.0` installs that version.
- A ref whose name contains `@`, which Git permits and almost nothing uses, MUST be set through `marketplace pin`, where the ref is an argument of its own and needs no separator. The suffix cannot carry one: the separator is the last `@` outside the authority, so such a ref splits in the wrong place and names a source the user did not type. That failure MUST NOT be silent — the addition fails against the remote, reporting the source it actually tried.
- A ref MUST be taken from the source only when the source is not a local directory. [Plugin System: Local Marketplace Sources](../plugin-system/index.md#local-marketplace-sources) classifies the argument exactly as it is typed, first and unchanged; only a source that classification hands to Git MAY be split. A directory named `tools@2` is therefore added as a local reference under that name, not as `tools` at ref `2`.
- Within a Git source, the ref MUST be separated by the last `@` that falls outside the source's authority — the part Git reads to locate the host, which is everything up to the first `/` after a `://` scheme, everything up to the colon in SCP-style `host:path` syntax, and nothing at all in a source carrying neither. An `@` inside the authority is an SSH login or an HTTP(S) credential and MUST NOT be read as a separator; `git@host:owner/repository` and `https://user@host/owner/repository` are unpinned sources.
- The ref MAY contain `/`, so `fx/cc@release/1.4` pins to that branch. Excluding the authority before searching is what makes that unambiguous. It is the same boundary [Plugin System: Local Marketplace Sources](../plugin-system/index.md#local-marketplace-sources) reasons about when it decides that a colon ahead of the first slash means a source carries Git syntax — the rule is shared, and where the authority *ends* is a question only this one has to answer.
- A ref suffix MUST be rejected when it is empty.
- A requested ref MUST be resolved against what the remote publishes, preferring a tag, then a branch, then a commit. A ref that begins with a digit and resolves to none of them MUST additionally be tried with a `v` prefix, so `@1.4.0` finds the `v1.4.0` tag that most repositories publish, this project included. A ref that resolves nowhere after that MUST fail the addition and publish nothing.
- A version suffix MUST NOT contribute to a derived marketplace name. `fx/cc@1.4.0` installs as `cc`.
- A local source given with a version suffix MUST be rejected, naming the reason: a reference is live, so there is no version to pin it to.
- A pinned marketplace MUST record the ref it was pinned to, as the user spelled it, and MUST keep it across updates.
- An unpinned marketplace MUST track its remote's current default branch, and MUST keep tracking it when the remote's default branch is renamed.
- Gathering a pinned marketplace MUST report the pin, and MUST report the commit its ref currently resolves to as what is available. A pin names a ref, not a commit: it is re-resolved on every update, so a pin to a hash never moves, a pin to a branch moves with that branch, and a pin to a tag moves if and only if the remote moves the tag. Following a moved tag is deliberate — the pin says "whatever `v1.4.0` is", and `tx` neither records what it used to be nor asserts that a remote's tags are immutable.
- Gathering a marketplace pinned to a tag MUST additionally report a higher tag published by the remote, as detail, without proposing to apply it. A user who pinned a version still wants to learn a newer one exists; moving them off the version they pinned without being asked would defeat the pin.
- "Higher" MUST mean higher as a semantic version. Only a tag that parses as one may be reported as higher, and only a pin that parses as one may be compared against; a pin to a tag that is not a semantic version reports no comparison at all. Creation time, lexical order, and reachability each order tags differently, and only one of the four answers the question a user asks about a release.
- A tag carrying a pre-release component MUST NOT be reported as higher, whatever the pin is. A user pinned to a release is not asking to hear about `1.5.0-beta.1`, and a pre-release is precisely the version its publisher has not offered yet. A pin MAY itself name a pre-release, and the first ordinary release above it is then reported normally.
- `marketplace pin` MUST set an installed marketplace's pin to a given ref, and MUST take effect on the next update rather than moving the checkout itself. `marketplace unpin` MUST clear it, returning the marketplace to tracking its remote's default branch.
- Pinning MUST reject a ref the remote does not publish. A rejected pin MUST leave the previous pin exactly as it was, so a mistyped ref never silently unpins a marketplace.
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

### Compatible Marketplace Versions

A marketplace that declares which `tx` releases it supports, and which commit carried each of its released versions, per [Plugin System: Marketplace Compatibility](../plugin-system/index.md#marketplace-compatibility), can be installed at the newest version that supports the running `tx` instead of at whatever its default branch holds now. This section owns which commit adding and updating select from that declaration. The fields, their validation, the range semantics, the running `tx` version, and the refusal to load an incompatible marketplace belong to that section and are not restated here.

Three terms are used throughout:

- The **tip** is the commit the remote's default branch points at, as [Marketplace Updates](#marketplace-updates) already resolves it for an unpinned marketplace: the commit `marketplace add` clones onto, and the commit gathering resolves after its fetch.
- A commit is **compatible** when the manifest it carries declares no `tx` range, or declares one the running `tx` version satisfies.
- The **candidate** is the element of the tip manifest's `versions` history with the highest precedence among those whose `version` carries no pre-release component and whose `tx` range the running `tx` version satisfies.

Reports describe a commit by the `version` its manifest declares when it declares one, by the `version` of the history element that selected it when it was selected from the history, and by its version label otherwise.

- Selection MUST apply to an unpinned marketplace cloned from Git, and only to one. A pinned marketplace targets what its pin resolves to, per [Marketplace Versions and Pins](#marketplace-versions-and-pins), and a live reference has no target, per [Marketplace Updates](#marketplace-updates); selection changes neither, and both remain subject to the load-time refusal [Plugin System: Marketplace Compatibility](../plugin-system/index.md#marketplace-compatibility) owns.
- Selecting a target MUST read the tip's manifest. When the tip is compatible, the target MUST be the tip, exactly as it is for a marketplace that declares nothing.
- When the tip is not compatible, the target MUST be the candidate's commit. Only the tip's history MUST be consulted: the history any other commit carries, the installed commit's included, plays no part, so a publisher corrects or withdraws an entry by changing the default branch.
- An element whose `version` carries a pre-release component MUST NOT be a candidate. A pre-release is the version its publisher has not offered yet, exactly as [Marketplace Versions and Pins](#marketplace-versions-and-pins) treats one, and a user who wants one pins it.
- When the candidate's commit is not present in the checkout after the fetch, selection MUST fetch that commit by its object name from the recorded remote, under the non-interactive terms every fetch runs under. A commit the remote does not serve MUST make the candidate unusable.
- The candidate commit's own manifest is the authority on what that commit supports; the history element is a claim about it. When the commit's own manifest is not compatible, cannot be read, or is invalid, the candidate MUST be unusable, and every report of it MUST name the candidate's version, the range its history element declares, and the range the commit's manifest declares or why that manifest could not be read.
- An unusable candidate MUST NOT be replaced by a lower element of the history. Selection then has no usable target, and everything below that applies when no candidate exists applies to it.
- Selection MUST NOT record a pin, or anything else. A marketplace installed or held at a version from its history stays unpinned and is selected afresh on every update, so it returns to the tip once the running `tx` supports the tip.
- When the tip's manifest cannot be read or is invalid, the target MUST be the tip, exactly as it is for a marketplace that declares nothing, and selection MUST add no report of its own. When the tip is not the installed commit, the manifest's failure is reported where an invalid target's failure is already reported: by validation when the marketplace is added, or when the update is applied, with the checkout restored. When the installed commit already is the tip, there is nothing to apply, so it MUST NOT be revalidated, as [Marketplace Updates](#marketplace-updates) requires of every checkout that does not move; its failure is the load-time diagnostic that commit already produces on every invocation, and is not repeated by the update.
- `marketplace add` with a Git source carrying no ref MUST select a target before validating and publishing, and MUST validate, install, and publish the target rather than the tip.
- When the target `marketplace add` installs is not the tip, it MUST report on standard output the version it installed and that the tip requires a `tx` range the running version does not satisfy, naming that range.
- When selection has no usable target, `marketplace add` MUST fail and publish nothing. The failure MUST name the running `tx` version and the range the tip declares, MUST state why the candidate was unusable when there was one, and MUST name the `<source>@<ref>` suffix as the way to install a specific version anyway.
- `marketplace add` with a ref, and with a local source, MUST NOT select. When the commit or directory it installs is not compatible, adding MUST still succeed and MUST warn on standard error that the marketplace's plugins will be refused under the running `tx`, naming the range it declares and the running version. The user named that version or that directory, and the override [Plugin System: Marketplace Compatibility](../plugin-system/index.md#marketplace-compatibility) provides is how they run it.
- `marketplace pin` MUST warn the same way when the commit its ref resolves to is not compatible, and MUST record the pin regardless. When the manifest at that commit cannot be read, pinning MUST NOT warn; the manifest is validated when the update applies the pin.
- Gathering an unpinned marketplace MUST select its target by the rules above, and applying MUST select again rather than trust what gathering reported, exactly as applying re-reads everything else.
- When the target was selected from the history and the installed commit is not an ancestor of it, applying MUST move the checkout to the target only when the installed commit is not compatible. That is the case moving backwards exists for: the running `tx` refuses the installed commit, and the target is the newest version it does not refuse.
- Whether the installed commit is compatible MUST be decided by the manifest it carries. A manifest that cannot be read or is invalid MUST count as not compatible, because that commit does not load either.
- When the target was selected from the history, the installed commit is compatible, and it is not an ancestor of the target, the checkout MUST stay where it is and the marketplace MUST be reported as held. Moving would trade a commit that works for an older one. This MUST NOT be reported as blocked or as a rewritten upstream, because nothing is wrong with the remote.
- A marketplace whose tip is not compatible and whose checkout stays where it is — because the target is the installed commit, by the rule above, or because selection has no usable target while the installed commit is compatible — is **held**. A held marketplace MUST be reported with nothing available and with detail of the form `held at <installed>: <tip> requires tx <range>`. Being held is not a failure.
- A marketplace whose target was selected from the history and is applicable MUST report the target's version label as available, with detail of the form `<tip> requires tx <range>; <target> is the newest version supporting tx <running>`.
- When selection has no usable target, a marketplace whose installed commit is compatible MUST be reported as held, with the reason the candidate was unusable when there was one. A marketplace whose installed commit is not compatible MUST instead be reported as a failed item naming the running `tx` version, the range the tip declares, and the remedies: a newer `tx`, `tx marketplace pin <name> <ref>`, and the override. Any of those three remedies resolves the failure. The two outcomes differ because a held marketplace runs and waits harmlessly for a newer `tx`, while a failed one is refused on every invocation until the user resolves it, which is why [The Update Command](#the-update-command) makes it exit non-zero.
- Gathering a pinned marketplace whose pin resolves to a commit that is not compatible MUST add that to the pin's detail, naming the range the commit declares and the running version, and MUST NOT otherwise change what is reported or applied.
- `marketplace list` MUST report, after each marketplace's source, the `version` its manifest declares, or a fixed non-empty placeholder when it declares none or its manifest cannot be read, so that column is never blank. The three columns [Marketplace Versions and Pins](#marketplace-versions-and-pins) requires keep their order and content. Listing stays offline.

#### Scenario: Adding installs the newest compatible version

- **GIVEN** the running `tx` is `1.8.0`, and the remote's default branch carries a manifest declaring `"version": "2.0.0"`, `"tx": "^2.0.0"`, and a `versions` history in which `1.5.0` at commit A declares `">=1.6.0 <2.0.0"` and `1.4.0` at commit B declares `">=1.0.0 <2.0.0"`
- **WHEN** the user runs `tx marketplace add example/tools`
- **THEN** `tools` is installed at commit A, no pin is recorded, and standard output reports that `1.5.0` was installed because `2.0.0` requires `tx` `^2.0.0`

#### Scenario: Nothing compatible publishes nothing

- **GIVEN** the running `tx` is `1.8.0`, and the remote's default branch declares `"tx": "^2.0.0"` with no history element `1.8.0` satisfies
- **WHEN** the user runs `tx marketplace add example/tools`
- **THEN** the addition fails naming `1.8.0`, `^2.0.0`, and the `@<ref>` suffix, and no marketplace is published

#### Scenario: A compatible installation is held

- **GIVEN** the running `tx` is `1.8.0`, an unpinned `tools` installed at a commit declaring `">=1.6.0 <2.0.0"`, and a remote default branch that advanced to a commit declaring `"version": "2.0.0"` and `"tx": "^2.0.0"` whose history's candidate is the installed commit or one of its ancestors
- **WHEN** the user runs `tx update`
- **THEN** `tools` is reported as held with nothing available and detail naming `2.0.0` and `^2.0.0`, the checkout does not move, and the command exits zero

#### Scenario: A refused installation moves back to the last working version

- **GIVEN** the running `tx` is `1.8.0`, an unpinned `tools` installed at a commit declaring `"tx": "^2.0.0"`, and a candidate `1.5.0` whose commit is not a descendant of the installed one
- **WHEN** the user runs `tx update`
- **THEN** the checkout moves to the candidate's commit, is validated and has its dependencies installed as any applied update does, the item reports the candidate's label with detail naming `^2.0.0` and `1.5.0`, and the next invocation loads its plugins

#### Scenario: A dry run reports the selection without moving

- **GIVEN** the installation from the previous scenario
- **WHEN** the user runs `tx update --dry-run`
- **THEN** the same target and detail are reported, the checkout, working tree, and installed dependencies are unchanged, and the command exits zero

#### Scenario: A newer tx returns to the tip

- **GIVEN** an unpinned `tools` installed at its `1.5.0` commit because its tip requires `tx` `^2.0.0`
- **WHEN** the user runs `tx update` under `tx` `2.0.0`
- **THEN** the tip is the target and the checkout moves forward to it

#### Scenario: A history claim the commit contradicts is not installed

- **GIVEN** the running `tx` is `1.8.0`, a tip whose history claims `1.5.0` at commit A supports `">=1.6.0 <2.0.0"` while commit A's own manifest declares `"^2.0.0"`, and a compatible `1.4.0` at commit B
- **WHEN** the user runs `tx marketplace add example/tools`
- **THEN** the addition fails naming `1.5.0`, `">=1.6.0 <2.0.0"`, and `"^2.0.0"`, and commit B is not installed in its place

#### Scenario: A pin is never re-selected

- **GIVEN** the running `tx` is `1.8.0` and `tools` pinned to `v2.0.0`, whose manifest declares `"tx": "^2.0.0"`
- **WHEN** the user runs `tx update`
- **THEN** the target is what the pin resolves to, nothing from the history is selected, and the pin's detail names `^2.0.0` and `1.8.0`

#### Scenario: Listing shows the declared version

- **GIVEN** one installed marketplace whose manifest declares `"version": "1.5.0"` and another that declares no `version`
- **WHEN** the user runs `tx marketplace list`
- **THEN** each line carries the name, version label, and source in their existing order, followed by `1.5.0` for the marketplace that declares it and the placeholder for the one that does not, and no remote is contacted

### Executable Updates

The executable plugin contributes one participant covering the running `tx` binary. It defines no commands and therefore claims no namespace.

- The item MUST be named `tx` and its current version MUST be the version the running executable reports.
- The participant MUST determine the published version from the project's own release publication, whose version is identical to the published package's by [Architecture: Runtime and Distribution](../architecture/index.md#runtime-and-distribution). One source of truth serves every installation shape.
- The published version MUST be compared to the running version as a semantic version. An equal or older published version MUST report nothing to apply, so a locally built executable ahead of the last release is never downgraded.
- An available version MUST be reported only when the published version is strictly newer *and* updating this executable is possible in principle. Exactly two conditions decide that, and both are properties of the running program rather than of its surroundings: it is a compiled `tx` executable, and its platform has a published executable. Where either fails, the newer release MUST be reported as detail with no available version, so the user learns it exists and the driver never tries to apply what the participant would only refuse.
- Everything else that can prevent an update — an unwritable location, a manager that cannot be interrogated, a checksum that does not match — MUST be an apply-time failure rather than a reason to withhold the available version. Those conditions can change between gathering and applying, and each is something the user can act on, so reporting them as failures is what makes the command exit non-zero while something is outstanding.
- A published-release lookup MUST send an authentication token when the environment supplies `GH_TOKEN` or `GITHUB_TOKEN`, preferring the first of those two that is non-empty, and MUST work without either. It MUST NOT read any other variable: a token is sent to the release host, and a credential the user configured for something else — a package registry, another forge — is not one they offered to this request. The token exists to raise a rate limit, not to reach anything private.
- The participant MUST NOT apply anything when the running program is not a compiled `tx` executable. Running from a source checkout makes the running program the Bun runtime, and replacing it would overwrite the user's Bun. This MUST be reported as nothing to apply rather than as a failure.
- The participant MUST NOT apply anything when the running platform has no published executable for it, reporting the platform and the platforms that are published.
- When the executable is installed by a version manager the participant recognizes, applying MUST delegate to that manager's own upgrade command rather than replacing the file. Replacing a file inside a manager's store leaves the manager recording a version that is not what is on disk, and its next install silently reverts the update.
- The recognized managers MUST be exactly those the project documents as installation paths — mise and npm — and MUST be recognized from the executable's own resolved location. A location no recognized manager owns MUST be treated as unmanaged, which is the only honest reading of it: the participant cannot refuse on behalf of a manager it cannot name, and the replacement path below already reports an unwritable location rather than forcing one.
- Delegation MUST ask the manager which tool owns that location rather than reconstructing the tool's name from the path, and MUST report the manager's command, its output, and its outcome. A recognized manager that cannot be interrogated MUST be reported as a failure; the participant MUST NOT then fall back to replacing a file inside that manager's store.
- A delegated upgrade MUST run in an environment that does not defer the release the participant has already offered. Where a recognized manager withholds a published release until it reaches a minimum age, that policy MUST be overridden for this one delegated command, because `tx update` is an explicit request to update this one tool now and a policy the participant cannot see would otherwise let the command name an available version and then decline to install it. The override MUST apply to that single command and nothing else: it MUST NOT modify the user's configuration, and MUST NOT reach any other tool, any other invocation of the manager, or any other participant.
- A delegated upgrade MUST be reported as applied only when the manager afterwards reports, for the tool it upgraded, a version newer than the running one that it was not already reporting before the upgrade. A manager may list every version it has installed, so a newer one that was there all along is not evidence that this upgrade installed anything. Where a manager reports several versions, the newest that can be ordered at all decides, independently of the order they were listed in: a manager that names versions it does not order — an install tracking a branch — MUST NOT be able to hide the ones it does. A manager that exits successfully without installing anything newer — because it withheld the release, because the user pinned the tool, or because what it publishes is not yet what was offered — MUST be reported as nothing applied, carrying the manager's output and the version still installed as detail. A manager whose installations cannot be read afterwards MUST be reported the same way: an upgrade whose effect was not observed MUST NOT be reported as success.
- When no version manager owns the executable, applying MUST download the published executable for the running platform, verify it against the checksum published alongside it, and refuse on any mismatch.
- A verified download MUST be checked by running it and requiring it to report the version that was published, before it replaces anything.
- Replacement MUST be atomic and MUST leave the installed executable untouched on every failure: the downloaded executable is staged beside the target, made executable, verified, and then moved onto the target in one step. A partially written file MUST NOT be reachable under the installed name at any point.
- Every temporary file the participant creates MUST be removed on every exit path, and a removal the filesystem refuses MUST NOT replace the failure that preceded it.
- When the executable's location is not writable and no version manager owns it, applying MUST report that, naming the path. `tx` MUST NOT attempt to acquire privileges.
- After a successful update, the participant MUST report the version now installed, observed rather than assumed. A version the participant did not observe MUST NOT be named, whether the update replaced the file itself or was delegated to a manager.

#### Scenario: Direct replacement

- **GIVEN** a compiled `tx` at a writable path no version manager owns, and a newer published release
- **WHEN** the user runs `tx update`
- **THEN** the published executable is downloaded, its checksum verified, its version confirmed by running it, moved onto the installed path in one step, and the new version reported

#### Scenario: Managed installation delegates

- **GIVEN** `tx` was installed by a version manager and a newer release exists
- **WHEN** the user runs `tx update`
- **THEN** the manager's own upgrade command runs for the tool that owns that path, its output is reported, and no file inside the manager's store is replaced by `tx`

#### Scenario: A young release is not withheld from the delegated upgrade

- **GIVEN** `tx` was installed by a manager configured to withhold a release until it reaches a minimum age, and the release `tx update` offers is younger than that
- **WHEN** the user runs `tx update`
- **THEN** the delegated upgrade installs the offered release, the user's configuration is unchanged, and every other tool that manager installed keeps the policy

#### Scenario: A delegated upgrade that changed nothing is not reported as applied

- **GIVEN** `tx` was installed by a version manager whose upgrade command exits successfully while leaving the installed version where it was
- **WHEN** the user runs `tx update`
- **THEN** the item is reported as nothing applied, with the manager's output and the version still installed as detail, and no version is named that the participant did not observe

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

The executable updater could have been part of the update plugin, and is not. Keeping it separate means the update plugin has exactly one job and no privileged participant, and it leaves the composition root — not the driver — deciding where the executable falls among the default plugins' own participants. It also demonstrates the contract the spec claims: a plugin that contributes a participant and no commands.

### Ordering

Participants run in the order the host committed them. For the default plugins that is the order the composition root lists them, so placing the executable plugin after the marketplace plugin makes marketplaces update first and the executable after them: a failure updating the executable leaves the marketplaces already updated.

That is a statement about root definitions only. The host queues a plugin's child definitions behind everything already queued, so a participant contributed by a plugin installed *through* a marketplace commits after the executable's and may be applied after it. Nothing here needs that not to happen — replacing the executable does not disturb the running process, which keeps executing the file it started from — so the rule stated is the one the host actually produces, and an explicit ordering mechanism waits until something needs one.

### Compatibility Is Declared at the Tip

A marketplace's default branch is the one thing every installation of it already reads, so the release history lives there, in the manifest, rather than in tags or in a registry. One manifest read answers "what may this `tx` install" for every installation, the publisher corrects a mistaken entry by committing to the branch they already publish from, and a history element names a commit rather than a tag because a commit is the one Git name its publisher cannot move.

The history is an index, not the authority. Each released commit still carries its own manifest, and the commit's own `tx` range decides whether that commit is compatible; an element that disagrees with it is reported rather than trusted, and selection never reaches past it to an older release the user did not ask for. A user who wants a particular version names it with a pin, which selection never touches.

Moving an unpinned marketplace backwards is allowed for exactly one reason: the running `tx` refuses the commit it is on. A marketplace on a commit that works stays there, held, until the running `tx` supports something newer — the forward-only rule in [Marketplace Updates](#marketplace-updates) protects that commit for the same reason it always has.

## Constraints

- Automatic checking is prohibited by [Never Automatic](#never-automatic), which owns the rule. It is not a feature left out, and adding one would require changing that requirement rather than writing code against it.
- Rollback of a marketplace update, beyond restoring the previous commit when preparation fails, is out of scope. A user reaches an older version by pinning to it; the only older version `tx` selects on its own is the one [Compatible Marketplace Versions](#compatible-marketplace-versions) selects when the running `tx` refuses the installed commit.
- `tx update` gathers every participant before applying any, and selects marketplace targets against the running `tx`. A run that also replaces the executable therefore selects marketplaces for the `tx` it started as, and the next run selects them for the `tx` it installed. This is tracked in [Open Questions](#open-questions) rather than solved.
- Signing and provenance verification remain out of scope for marketplaces, unchanged by this spec. The executable's published checksum is an integrity check on a download, not a signature.
- Updating one plugin inside a marketplace independently of the rest is out of scope. A marketplace is one Git checkout and moves as one.
- The published executable exists for the platforms [Architecture: Runtime and Distribution](../architecture/index.md#runtime-and-distribution) names, and self-update reaches no further than those.

## Open Questions

- Should `tx update` offer machine-readable output? Line-oriented output greps well enough for now, and a format is worth defining once something is consuming it.
- Should a participant be able to report progress while applying, rather than only a result? Nothing here needs it yet; a long dependency installation may change that.
- Should participant order be settable, rather than falling out of the host's initialization order? It would matter the first time a participant contributed by an installed plugin has to run before or after another one.
- Should a marketplace pinned to a tag be able to follow tags matching a range, rather than an exact ref? That is a dependency-resolution feature and wants a version policy; [Compatible Marketplace Versions](#compatible-marketplace-versions) gives the manifest a release history, but selects from it only by `tx` compatibility.
- Should a run of `tx update` that replaces the executable select marketplaces for the `tx` it is installing rather than the one running? It would let one run finish what currently takes two, at the cost of the marketplace participant learning a version from another participant, which the driver deliberately does not broker.
- Should `marketplace add <source>@<version>` resolve a version through the manifest's history when the remote publishes no tag for it? It would let a publisher who does not tag releases still be pinned by version, and it would make one suffix mean two lookups.
- Should `tx update` be able to update a marketplace that is blocked by local modifications, given an explicit flag? The remedy today is to resolve them in the checkout, which is what a user editing an installed clone should be doing anyway.

## References

- [Plugin System](../plugin-system/)
- [Architecture](../architecture/)
- [Change 0012: Add a Generic Update Lifecycle](../../changes/0012-add-generic-update-lifecycle.md)
- [Change 0013: Update Installed Marketplaces](../../changes/0013-update-installed-marketplaces.md)
- [Change 0014: Pin Marketplace Versions](../../changes/0014-pin-marketplace-versions.md)
- [Change 0015: Update the tx Executable](../../changes/0015-update-the-tx-executable.md)
- [Change 0022: Exempt and Verify the tx Self-Update](../../changes/0022-exempt-and-verify-the-tx-self-update.md)
- [Change 0034: Add Marketplace tx Compatibility](../../changes/0034-add-marketplace-tx-compatibility.md)
- [Git fast-forward merges](https://git-scm.com/docs/git-merge#_fast_forward_merge)
- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-07 | Initial desired update lifecycle: the never-automatic prohibition, the `tx update` command surface, and the participant-facing contract | [0012-add-generic-update-lifecycle](../../changes/0012-add-generic-update-lifecycle.md) |
| 2026-08-07 | Specified marketplace updating: version labels, live references, non-interactive fetching, forward-only movement, blocked checkouts, and restoration | [0013-update-installed-marketplaces](../../changes/0013-update-installed-marketplaces.md) |
| 2026-08-07 | Specified marketplace version pins: the source suffix, ref resolution, pin recording, pin-aware gathering, and the pin commands | [0014-pin-marketplace-versions](../../changes/0014-pin-marketplace-versions.md) |
| 2026-08-07 | Specified executable self-update: release lookup, availability gating, manager delegation, download verification, and atomic replacement | [0015-update-the-tx-executable](../../changes/0015-update-the-tx-executable.md) |
| 2026-09-02 | Specified that a delegated upgrade runs without the manager's minimum-release-age deferral and counts as applied only against an observed newer installed version | [0022-exempt-and-verify-the-tx-self-update](../../changes/0022-exempt-and-verify-the-tx-self-update.md) |
| 2026-10-01 | Self-update reaches Linux arm64 now that [Architecture: Runtime and Distribution](../architecture/index.md#runtime-and-distribution) publishes an executable for it; no requirement here changed | [0032-publish-a-linux-arm64-executable](../../changes/0032-publish-a-linux-arm64-executable.md) |
| 2026-10-10 | Specified compatible marketplace versions: selecting the newest release whose declared `tx` range the running `tx` satisfies on add and update, the commit's own manifest as authority, the backwards move for a refused installation, held reporting, pin and local-source warnings, and the declared-version list column | [0034-add-marketplace-tx-compatibility](../../changes/0034-add-marketplace-tx-compatibility.md) |
