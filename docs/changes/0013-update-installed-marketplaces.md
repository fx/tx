# 0013: Update Installed Marketplaces

## Summary

Let the marketplace plugin participate in `tx update`. Every installed marketplace is gathered as one item: a cloned one reports the commit it holds and the commit its remote offers, a referenced local one reports that it is live and has nothing to apply. Applying moves a clone's checkout forward and reinstalls its dependencies exactly as adding it would, refuses to touch a checkout carrying local modifications, and puts the previous commit back if the new one fails to validate.

**Spec:** [Updates](../specs/updates/)
**Status:** complete
**Depends On:** 0012

## Motivation

A cloned marketplace is frozen at the commit it was installed from. The author of a plugin pushes a fix; every user of it stays on the old code until they notice, remove the marketplace, and add it again — losing nothing except the certainty that they will not bother. That is the actual failure mode: an install-once tool whose plugins silently rot.

Remove-and-add is also not a correct update even when a user does it. It re-clones the whole repository over the network for what is usually a few commits, and it goes through the "already installed" check by first destroying the installation, so a failure at any point between the two commands leaves the user with no marketplace at all rather than the old one. An update should be the operation that cannot end in less than what you started with.

The pieces are already here. The marketplace plugin owns the checkout, knows the remote it cloned from, and already validates a manifest and installs dependency manifests as part of adding one — updating is those same steps against a commit that moved. What is missing is somewhere to put them, which [0012](./0012-add-generic-update-lifecycle.md) supplies.

One decision deserves stating up front because it shapes everything else: an update is not allowed to lose work. An installed checkout is `tx`'s to manage, but a user who edited a file in it did so for a reason, and a marketplace whose upstream history was rewritten is a situation `tx` cannot resolve by guessing. Both are reported and refused rather than resolved.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable gathering, fetching, blocking, applying, restoring, and reporting behavior MUST have automated tests.
- Git execution MUST stay injected, as it is today. No test may reach the network, and no test may depend on an SSH key, an agent, or a reachable host.
- Tests MUST create every marketplace root inside a temporary directory they own and MUST remove it afterwards.
- The rollback requirement MUST have a test that fails against an implementation which moves the checkout and leaves it moved when preparation throws. Asserting only that the failure is reported does not cover it.
- The blocked-checkout requirements MUST each have a test asserting that the checkout did not move: one for modified tracked files, one for a current commit that is not an ancestor of the target.
- Untracked files MUST have a test asserting they do not block an update, since dependency installation creates them, and a second test asserting that an untracked file occupying a path the target commit tracks does block it and survives intact.
- A test MUST assert that gathering leaves the checked-out commit and the working tree unchanged.
- A test MUST assert that a referenced local marketplace is neither fetched nor modified, by failing if the injected Git runner is called for it at all.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Updates: Marketplace Updates](../specs/updates/index.md#marketplace-updates) owns the participant's behavior, and [Plugin System: Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership) owns the storage, manifest, and non-interactive execution contracts it builds on. Their scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **The participant is contributed by the marketplace root plugin, not by a discovered child.** Discovered children are per-marketplace plugin definitions that load a manifest, and a marketplace whose manifest is broken contributes none of them. Updating has to work precisely then, so the participant enumerates storage the way `marketplace list` does and never depends on a marketplace having loaded.
- **Non-interactive execution extends from cloning to fetching.** The environment that disables Git's terminal prompt and applies SSH batch mode already exists for clone attempts; a fetch needs it for a stronger reason, since `tx update` walks every installed marketplace and one credential prompt would stall the run. Reading Git configuration, `marketplace list`, and dependency installation keep the invoking environment, unchanged.
- **The SSH retry does not extend to fetching.** [0010](./0010-retry-marketplace-clones-over-ssh.md) named this as a non-goal and it stays one. A clone retries because shorthand expansion picked the transport; a fetch uses the remote recorded in a checkout that was successfully cloned from it, so there is no second spelling to try.
- **`marketplace list` gains a version column.** The label is the same one the participant reports and is read from the checkout with no network access, so listing stays offline.
- **Preparation is reused, not reimplemented.** The validation and dependency installation that run when a marketplace is added are the same steps that must run when its commit changes, including the trusted lifecycle execution that entails.

## Design

### Approach

A new module under `plugins/marketplace/` implements the participant; `plugins/marketplace/index.ts` contributes it during initialization. `manager.ts` grows the Git operations it needs and exports the non-interactive environment it already builds for clones so the fetch shares one definition of it.

Gathering, per installed marketplace in the discovery order that is already sorted:

1. A symbolic link is a live reference. It is reported with a live label and no available version, and no Git command runs against it at all.
2. Otherwise the checkout's current commit and its label come from the repository — the label preferring a reachable tag over an abbreviated hash, so a marketplace that publishes tags reads as `v1.4.0`.
3. The remote is fetched, tags included, and the remote's default branch is re-resolved so a renamed default branch is followed rather than reported as missing.
4. The target commit is what the marketplace tracks. Equal to the current commit means nothing is available.
5. Two local checks decide whether an available update could actually be applied: tracked-file modifications, and whether the current commit is an ancestor of the target. Either one is reported as detail on the item, so a dry run tells the user what is in the way before they run the real thing.

Applying an item re-reads the checkout rather than trusting what gathering saw, because a user may have edited it in between and because an item is a report rather than a transaction. It repeats the blocking checks, records the current commit, moves the checkout to the target, runs the same preparation adding a marketplace runs, and reports the new label. If preparation throws, the recorded commit is restored and the failure is reported with the restoration stated, since installed dependencies are not restored with it.

### Decisions

- **Decision:** Move the checkout by detaching onto the target commit, rather than fast-forwarding a branch.
  - **Why:** One operation then covers every case: an unpinned marketplace tracking a branch, a marketplace pinned to a tag by [0014](./0014-pin-marketplace-versions.md), and the rollback path that puts a specific commit back. A managed checkout has no reason to be on a branch — nothing commits into it, and an author who wants to commit uses a local reference, which is what [0008](./0008-link-local-marketplace-sources.md) added. Detaching also makes "did the checkout move" a single commit comparison instead of a question about branch state.
  - **Alternatives considered:** `merge --ff-only` was rejected because it cannot express a pin and does nothing for a detached checkout. `reset --hard` was rejected outright: it discards local modifications, which this change refuses to do, and it would make the blocking check the only thing standing between a user's edit and its destruction.

- **Decision:** Refuse to update a checkout with modified tracked files; ignore untracked files except where one occupies a path the target commit tracks.
  - **Why:** A tracked modification is either a user's edit or a sign that something is wrong with the checkout, and both are worth stopping for. Untracked files cannot be treated the same way, because `bun install` writes `node_modules` into the checkout and a marketplace that does not ignore it would become permanently un-updatable — a blocking rule that fires on `tx`'s own side effect is a bug, not a safeguard. The collision case is the exception the filesystem forces: a checkout that would have to write over an untracked file cannot proceed without destroying it, so it is reported as blocked with the path named. Nothing extra implements that — an ordinary checkout already refuses, and this change reports the refusal instead of forcing past it.
  - **Alternatives considered:** Stashing was rejected as `tx` taking custody of a user's work in a directory they may never look at again. Blocking on untracked files generally was rejected for the reason above. Forcing the checkout past a collision was rejected as the data loss this whole rule exists to prevent. Ignoring modifications entirely was rejected for the same reason.

- **Decision:** Refuse to move an unpinned marketplace when its current commit is not an ancestor of the target.
  - **Why:** That is what a force-push or a rewritten branch looks like, and moving anyway would silently discard the commit history the checkout was validated against — including, in the worst case, moving a user onto a completely unrelated tree that happens to be at the remote's branch. The condition is rare, so paying for it with a report and a remedy costs almost nothing; getting it wrong silently costs a marketplace nobody can explain. A pin is exempt because the user named the commit-ish, and naming an older tag is how a downgrade is spelled.
  - **Alternatives considered:** A `--force` flag was rejected as surface for a case whose remedy — remove and add — already exists and is unambiguous. Detecting the rewrite and re-cloning automatically was rejected: it is `marketplace add` with extra steps and a directory removal the user did not ask for.

- **Decision:** Restore the previous commit when validation or dependency installation fails after the checkout moved, and say that dependencies were not restored.
  - **Why:** Leaving a marketplace on a commit that failed validation is the one outcome worse than not updating: the user's next invocation reports a broken marketplace they did not have before. The blocking checks guarantee the checkout was clean and its previous commit is known, so restoring it is exactly reversible for tracked content. Installed dependencies are not, because installation is trusted code that owns what it writes, and a claim to have undone it would be false.
  - **Alternatives considered:** Staging the update in a second checkout and swapping it in, the way `add` stages a clone, was rejected as a full second copy of every marketplace on every update for a failure case a restore already covers. Leaving the new commit in place with a warning was rejected as handing the user a broken installation.

- **Decision:** Gather by fetching, and let a dry run perform the fetch.
  - **Why:** There is no way to learn what a remote has without asking it, and a dry run whose answer is "probably" is not worth running. Fetching writes only remote-tracking refs and objects, so the checkout, the working tree, and the installed dependencies are untouched — the property the dry run actually has to preserve.
  - **Alternatives considered:** `git ls-remote` reads the remote without writing anything and was rejected: it answers what commit a ref points at but not whether the current commit is an ancestor of it, which is the check that decides whether the update is even possible. Fetching only at apply time was rejected because it makes the dry run useless.

- **Decision:** Re-resolve the remote's default branch during each fetch rather than trusting what cloning recorded.
  - **Why:** A repository renaming its default branch is ordinary, and a marketplace installed before the rename would otherwise report a missing ref forever, with a diagnostic about Git internals rather than about anything the user did.
  - **Alternatives considered:** Reading the recorded head and reporting an error when it is gone was rejected as making the user run a Git command inside `tx`'s storage.

- **Decision:** Contribute the participant from the marketplace root plugin, and enumerate storage directly.
  - **Why:** The marketplace most in need of an update is one whose current commit does not load — a bad manifest, a missing entry, a plugin that throws on import. Its discovered child definitions fail, so anything hanging off them is unavailable exactly when it is needed. Enumerating storage is also what `marketplace list` and `marketplace remove` already do, for the same reason.
  - **Alternatives considered:** One participant per discovered marketplace was rejected for that reason, and because it would report items through plugin identities that fail independently of the storage they name.

- **Decision:** Report a blocking condition as detail during gathering, while the refusal itself happens at apply time.
  - **Why:** A user running a dry run wants to know that an available update cannot be applied, before they run the command that fails. But the refusal has to be re-checked when applying, because time passes between the two and the item is a report rather than a lock. Reporting during gathering costs two local Git reads that the fetch already justified.
  - **Alternatives considered:** Suppressing the available version for a blocked marketplace was rejected: it hides the fact that an update exists, which is the thing the user asked about.

### Non-Goals

- Pins and version suffixes. [0014](./0014-pin-marketplace-versions.md) adds them; this change resolves the tracked target as the remote's default branch and is written so that a pin replaces only that resolution.
- Updating the executable. [0015](./0015-update-the-tx-executable.md) covers it.
- Any per-plugin update within a marketplace. A marketplace is one checkout and moves as one.
- Re-cloning a marketplace whose upstream was rewritten, or converting a clone's remote between transports.
- Applying the [0010](./0010-retry-marketplace-clones-over-ssh.md) SSH fallback to a fetch.
- Removing a marketplace that fails to update. `marketplace remove` is the existing remedy and is unchanged.
- Timeouts on Git or Bun operations, per [PR Review](../../REVIEW.md).
- Any change to `src/`. The whole change lives in the marketplace plugin.

## Tasks

- [x] Specify marketplace updating (PR #30)
  - [x] Add [Updates: Marketplace Updates](../specs/updates/index.md#marketplace-updates) covering version labels, live references, gathering without modification, non-interactive fetching, forward-only movement, blocked checkouts, preparation, and restoration (PR #30)
  - [x] Add the pointer bullets and the non-interactive network-operation requirement to [Plugin System: Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership) (PR #30)
  - [x] Add scenarios for a forward move, an untouched live reference, both blocked cases, and a restored commit (PR #30)
  - [x] Update the specs' references and changelogs, and both documentation indexes (PR #30)

- [x] Extend the marketplace manager's Git surface in `plugins/marketplace/manager.ts`
  - [x] Export the non-interactive environment so cloning and fetching share one definition, without changing what cloning does with it
  - [x] Add reads for the current commit, its label preferring a reachable tag, tracked-file modifications, and ancestry between two commits
  - [x] Add the fetch, including tags and re-resolution of the remote's default branch
  - [x] Add the checkout move, used for both applying and restoring

- [x] Add the update participant under `plugins/marketplace/`
  - [x] Gather every installed marketplace in discovery order, reporting a live label for a reference and a commit label for a clone
  - [x] Resolve the tracked target from the remote's default branch and report an available version only when it differs from the current commit
  - [x] Report a blocking condition as item detail
  - [x] Re-check blocking conditions when applying, including an untracked file occupying a path the target tracks, and refuse without moving the checkout or discarding the file
  - [x] Move the checkout, run the same preparation adding a marketplace runs, and report the new label
  - [x] Restore the recorded commit when preparation fails, and state that installed dependencies were not restored
  - [x] Report a corrupt or unreadable checkout as a failed item naming its `marketplace remove` remedy, without failing the participant or hiding the marketplaces around it
  - [x] Contribute the participant from `plugins/marketplace/index.ts` during initialization

- [x] Add the version column to `marketplace list` without contacting any remote

- [x] Cover the new behavior in `test/marketplaces.test.ts` and a new participant test
  - [x] Gathering: a clone with and without an available commit, a live reference that reaches Git not at all, a corrupt checkout reported as a failed item beside healthy ones that still report and still apply, and an assertion that nothing in the checkout changed
  - [x] Applying: a forward move with preparation, a no-op when nothing is available, a modified tracked file, an untracked file that does not block, an untracked file in the way of a tracked path that does, a non-ancestor target, and a preparation failure that restores the previous commit
  - [x] Environment: a fetch running non-interactively, and `marketplace list` and dependency installation keeping the invoking environment
  - [x] Ordering: marketplaces gathered and applied in sorted name order
  - [x] Listing: the version column for a clone and for a reference, with no Git call reaching a remote

- [x] Document updating marketplaces in `docs/manual/plugins.md`, in the pull request that implements it
- [x] Verify 100% coverage and `bun run check`

## Open Questions

- [ ] Should a blocked marketplace be reported through the plugin's recovery diagnostics on ordinary invocations, rather than only during an update? It would tell users something is wrong sooner, at the cost of a Git read on every startup, which the eager-initialization open question in [Architecture](../specs/architecture/index.md#open-questions) already worries about.
- [ ] Should the participant report how many commits an update spans, or their subjects? It is one more Git read and genuinely useful, and it is also the beginning of a changelog feature with no boundaries.
- [ ] Should a lockfile that `tx`'s own dependency installation rewrote count as a user modification? A marketplace that commits `bun.lock` and whose install rewrites it acquires a modified tracked file that nothing the user did produced, and the blocking rule then refuses every later update until they resolve it by hand. Exempting a path because `tx` wrote it is a hole in a rule whose whole value is that it has none, and the alternative — refusing on a modification the tool itself made — is a trap. Changing either needs an amendment to [Updates: Marketplace Updates](../specs/updates/index.md#marketplace-updates), which owns the rule.
- [ ] Should a marketplace be updatable while a dependency installation from a previous update left the checkout half-installed? There is no way to detect that state today, and Bun's own install is the thing that would have to report it.

## References

- Spec: [Updates](../specs/updates/), [Plugin System](../specs/plugin-system/)
- Related changes: [0012-add-generic-update-lifecycle](./0012-add-generic-update-lifecycle.md), [0008-link-local-marketplace-sources](./0008-link-local-marketplace-sources.md), [0010-retry-marketplace-clones-over-ssh](./0010-retry-marketplace-clones-over-ssh.md)
- Manual: [Plugins](../manual/plugins.md)
- External: [`git fetch`](https://git-scm.com/docs/git-fetch), [`git describe`](https://git-scm.com/docs/git-describe), [`git remote set-head`](https://git-scm.com/docs/git-remote#Documentation/git-remote.txt-emset-headem)
