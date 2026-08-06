# 0008: Link Local Marketplace Sources

## Summary

Let `tx marketplace add` take a local directory and record it as a live reference to the author's working tree instead of cloning it. A plugin author can then run their uncommitted work against the real `tx` executable: edit, rerun, repeat — with no commit, no push, no merge to a repository's default branch, and no reinstall.

**Spec:** [Plugin System](../specs/plugin-system/)
**Status:** draft
**Depends On:** 0007

## Motivation

Every way of installing a marketplace today ends in a clone, and a clone captures a commit. That is the whole problem: an author's current edits are not a commit.

`tx marketplace add` hands its source to `git clone`, into `<user-data>/marketplaces/<name>`. For a remote source that clones the remote's default branch, so work on an unmerged branch is not reachable at all — the author has to merge to `main` before `tx` can run it. For a local path it is better but not fixed: `git clone ./repo` already works today and takes that repository's checked-out `HEAD`, so an author can at least test committed local work without pushing. What they cannot do is test what they just typed. Every iteration is commit, `marketplace remove`, `marketplace add` — three steps and a commit per edit, on work that is not ready to be a commit yet. The one alternative the system offers, a repository's own `.tx/config.json`, is explicitly not auto-loaded, so being inside the repository does not help either.

So the develop-test loop runs through the version-control history, and for anything on a branch it runs through code review, which is backwards: review is supposed to come after the author has run the thing. Cloning a local path cannot close it, because a clone is still a snapshot of a commit. What closes it is a marketplace that resolves to the author's live working tree, so the next `tx` invocation reads whatever is on disk right now.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable classification, linking, discovery, listing, removal, and recovery behavior MUST have automated tests.
- Tests MUST create every link, source directory, and marketplace root inside a temporary directory they own, and MUST remove it afterwards. No test may link to, install into, or remove a path in the working repository.
- The removal test MUST assert the referenced directory and its contents still exist after `remove` returns. A test that asserts only the absence of the reference does not cover the destructive failure this change risks.
- Tests MUST cover a reference whose target no longer exists: discovery, listing, recovery diagnostics, and removal.
- Git and Bun execution MUST stay injected in tests, as it is today, so no test reaches the network or requires a `bun` executable on `PATH`.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Plugin System: Local Marketplace Sources](../specs/plugin-system/index.md#local-marketplace-sources) owns source classification, live-reference semantics, name derivation, discovery, listing, removal safety, and stale-reference recovery. Its scenarios are this change's acceptance criteria and are not restated here. [Plugin System: Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership) continues to own manifest validation, package selection, and dependency installation, which a local source reuses unchanged. This change also amends [Architecture: State Ownership](../specs/architecture/index.md#state-ownership) and [Architecture: Runtime and Distribution](../specs/architecture/index.md#runtime-and-distribution); the index records Plugin System as its primary spec.

What implementing them requires of this change:

- **This is a deliberate behavior change to a released command.** `tx marketplace add ./repo` today succeeds by handing the path to `git clone`, which snapshots the local repository's checked-out `HEAD`. After this change the same invocation records a live reference instead. The old behavior stays available through a `file://` URL, which classification leaves with Git. The change MUST be called out in `docs/manual/plugins.md`, which is where it is documented for users; it ships as an ordinary feature and does not carry a breaking-change footer.
- Discovery currently filters directory entries by their own type, which reports a symbolic link to a directory as not-a-directory. Left as is, every linked marketplace would be silently invisible: installed and occupying its name, absent from `marketplace list`, contributing no plugins, and diagnosing nothing. Removal by name would still work, since `MarketplaceManager.remove` resolves the path itself rather than going through discovery — but only for an author who remembers the name, because nothing in the CLI would admit the marketplace exists. Discovery MUST be made reference-aware in the PR that lands before linking becomes reachable, not after.
- `marketplace list` derives a source by asking Git for `remote.origin.url` inside the checkout. For a reference, that would report the author's remote and hide which directory is actually being read. Listing MUST report the recorded target for references and MUST keep the Git-derived source for clones.
- Removal already unlinks rather than recurses for a non-directory entry. That behavior is now load-bearing for a user's working tree rather than incidental, so it MUST be covered by an explicit test that asserts the target survives.
- The marketplace plugin owns all of this. No requirement here may add path, link, or filesystem vocabulary to any module under `src/`, and `test/plugin-boundary.test.ts` MUST keep passing unmodified.

#### Scenario: Cloning a local repository stays available

- **GIVEN** an author wants a snapshot of a local Git repository rather than a live reference
- **WHEN** they add it through a `file://` URL
- **THEN** it is cloned into marketplace storage exactly as a remote source is, and later edits to the source do not affect it

## Design

### Approach

Three seams change, all inside `plugins/marketplace/`.

`MarketplaceManager.add` gains a classification step ahead of everything else. An empty source is rejected outright, before anything is resolved — `resolve(cwd, "")` is `cwd`, so an empty argument would otherwise name the user's current directory and quietly install into it. A source carrying a URL scheme or SCP-style host separator goes to the existing Git path untouched. Otherwise the manager resolves the argument against the working directory and inspects it: an existing directory is a local source, an existing non-directory is an error, and anything absent falls through to the Git path — which is what keeps `owner/repository` shorthand working, since a shorthand that names nothing on disk simply is not a local source.

Absence here means `ENOENT` and nothing else. An inspection that fails for another reason — `EACCES` under an unreadable ancestor, `ELOOP` through a symbolic-link cycle — is reported as itself. Treating those as absence would send the source to `git clone`, and the author would be told their clone failed rather than that their path is unreadable. `resolveExistingPath` in `storage.ts` already draws exactly this distinction and is the model to follow.

The local path skips cloning and staging entirely. There is nothing to stage: validation and dependency installation already operate on a checkout directory, and for a local source that directory is the author's own tree, which the change is explicitly not allowed to copy. So the manager resolves the source's real path, validates the name is free, runs the existing preparation against the real path, and only then creates the reference. A failure anywhere before that last step leaves no reference behind, and nothing to clean up.

The reference itself is a symbolic link at `<marketplaces>/<name>` pointing at the resolved source. Everything downstream then works because it already resolves real paths: `resolveMarketplaceManifest` calls `realpath` on the checkout before reading anything and runs its containment checks against that resolved root, so a linked checkout validates against the author's real tree with no new path logic and no weakening of the escape checks.

`discoverInstalledMarketplaces` is the one place that does not follow links, and it must. Its `Dirent.isDirectory()` filter reports a symbolic link to a directory as `false` — verified — so a linked marketplace would never be discovered. It becomes a classification that accepts a real directory, and accepts a symbolic link on the strength of it being a link at all: not only one resolving to a directory, but equally a dangling one and one whose target has been replaced by a file. Discovery decides what is installed, not whether it works. A degraded reference that discovery silently dropped would leave a name occupied by something the CLI never mentions — unusable, unlisted, and undiagnosed, removable only by an author who happens to remember the name — while the loading path already exists to diagnose exactly that failure and already points the author at `marketplace remove`.

`MarketplaceManager.list` reads the link target for a reference and keeps the Git lookup for a clone. A stale reference reports the target it was recorded with, because that is the fact the author needs to fix it.

### Decisions

- **Decision:** Represent the reference as a filesystem symbolic link, not as a registry file of linked paths.
  - **Why:** Marketplace identity is already "a directory named `<name>` under the marketplace root", and a link satisfies that with no second source of truth. Manifest reading, containment checks, and per-plugin dependency selection all resolve real paths already, so they work through a link unchanged. Removal is already an unlink for a non-directory entry, so a link cannot take the author's tree with it. Verified: `rm(link, { recursive: false, force: false })` removes the link and leaves the target and its contents intact.
  - **Alternatives considered:** A JSON registry of linked paths was rejected — it adds a file format, a second discovery path, a second removal path, and a way for the registry and the directory listing to disagree. Copying the source was rejected by the requirement: a copy has to be refreshed on every edit, which is the problem being solved.

- **Decision:** Classify by inspecting the filesystem, and let an existing local directory win over `owner/repository` shorthand.
  - **Why:** The check is a single `stat`, needs no network, and gives one deterministic answer per invocation. The collision is narrow — it needs a directory literally named `owner/repository` relative to the working directory — and resolving it toward the local directory is what makes `tx marketplace add my-org/my-plugins` mean the obvious thing when the author is standing next to that directory. The remote stays reachable by its full URL, so nothing becomes unaddressable.
  - **Alternatives considered:** Requiring an explicit `--link` flag or a separate `link` command was rejected as more surface for the same outcome. Restricting local detection to arguments starting with `.` or `/` was rejected because it silently ignores a bare directory name that exists, which is the more confusing failure of the two.

- **Decision:** Record the resolved real path at add time rather than the argument as typed.
  - **Why:** A relative argument is only meaningful next to the working directory it was typed in, and the marketplace outlives that shell. Resolving once also pins the reference to a directory rather than to a chain of intermediate links someone can later repoint.
  - **Alternatives considered:** Storing the literal argument was rejected — `tx marketplace add .` would resolve differently on every later invocation, which is the opposite of a stable install.

- **Decision:** Run dependency installation in the author's own directory, exactly as for a clone, and only at add time.
  - **Why:** A live reference is the author's tree by construction; installing anywhere else would install into a copy nothing loads. Doing it at add time and not on every invocation keeps `tx` startup free of package-manager work, and an author who adds a dependency later is already running `bun install` themselves as part of writing that code.
  - **Alternatives considered:** Skipping installation for local sources was rejected — a plugin whose dependencies were never installed simply fails to import, and the author has no signal saying why. Reinstalling on each invocation was rejected as an unacceptable startup cost for a case the author can trigger themselves.

- **Decision:** Ship as an ordinary feature, without a breaking-change footer, and document the changed meaning of a local path in the manual.
  - **Why:** The specification has never granted local paths clone semantics — [Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership) says `marketplace add` accepts Git clone sources, and a local path working at all is a consequence of `git clone` accepting one, not a documented contract. Changing an undocumented consequence does not warrant the major version bump a `BREAKING CHANGE:` footer forces, and the `file://` escape means nobody relying on the old behavior loses it.
  - **Alternatives considered:** A `BREAKING CHANGE:` footer was rejected — Release Please would render it, but at the cost of `2.0.0` for a case with a one-word workaround. Putting the explanation in an ordinary commit body was rejected as ineffective: Release Please's Node changelog renders commit subjects only, as the existing `CHANGELOG.md` shows, so the body would never reach a reader.

- **Decision:** Report the link target as the source in `marketplace list`.
  - **Why:** For a reference, the actionable fact is which directory `tx` is reading — not which remote that directory happens to have configured. It also makes a stale reference self-diagnosing: the listing names the path that went missing.
  - **Alternatives considered:** Adding a third column or a `(linked)` marker was rejected as a change to the output shape for information the path itself already carries.

### Non-Goals

- Auto-loading `.tx/config.json` from the current working repository. It stays out of scope; adding the repository as a local source is the supported way to load it.
- Watching a referenced source for changes, or any caching, invalidation, or reload machinery. Each invocation reads the tree as it finds it, which is all the live behavior requires.
- Re-running dependency installation for a referenced marketplace after it is added.
- Snapshot copies of a local directory. `file://` clones cover it.
- Converting an installed clone into a reference, or the reverse. Remove and add again.
- Protecting the author's tree from the dependency installation itself. Installing in that tree is the point of a live reference, and lifecycle scripts are trusted code with `tx`'s permissions — a script that deletes the directory it runs in is beyond anything the host can guarantee. What this change owns is that `tx`'s own cleanup never touches it.
- Platform support beyond the supported Linux x64 target. Symbolic-link creation on Windows is not addressed here.
- Any change to `src/`. The whole change lives in the marketplace plugin.

## Tasks

- [ ] Make marketplace discovery, listing, and removal reference-aware
  - [ ] Replace the `Dirent`-type filter in `discoverInstalledMarketplaces` (`plugins/marketplace/storage.ts`) with classification that accepts a real directory or any symbolic link, preserving the existing safe-name filter and sorted order
  - [ ] Retain every degraded reference as a discovered marketplace — dangling, and resolving to a non-directory — so a stale reference stays listable and removable instead of occupying a name the CLI cannot see
  - [ ] Report the recorded target as the source for a referenced marketplace in `MarketplaceManager.list` (`plugins/marketplace/manager.ts`), keeping the Git-derived source for clones and the existing unknown-source fallback for a corrupt checkout
  - [ ] Add tests in `test/marketplaces.test.ts` covering discovery of a linked marketplace, discovery of a dangling reference, discovery of a reference whose target is now a file, listing of each, and removal of each
  - [ ] Add a removal test asserting the referenced directory and its contents still exist after `remove` returns
  - [ ] Add a recovery test asserting a degraded reference produces marketplace-aware recovery diagnostics naming its `marketplace remove` invocation, while a healthy marketplace installed alongside it still dispatches its commands
  - [ ] Confirm `test/plugin-boundary.test.ts` still passes unmodified

- [ ] Add local sources to `marketplace add`
  - [ ] Add source classification to `MarketplaceManager.add`: an empty source rejected before anything is resolved, URL-scheme and SCP-style sources to Git, an existing directory to the local path, an existing non-directory rejected with a clear message, anything absent to Git
  - [ ] Treat only `ENOENT` as absence during classification, reporting every other inspection failure as itself rather than falling through to Git, following `resolveExistingPath` in `plugins/marketplace/storage.ts`
  - [ ] Derive a local marketplace's name from the final component of the resolved real path when `--name` is absent, taking that component as it is on disk rather than reusing `deriveMarketplaceName`'s `.git` stripping, and report that `--name` is required when no safe name can be derived
  - [ ] Reject a name that is already installed, whether it holds a clone or a reference
  - [ ] Update the `add` command's own description and `<repository>` argument help in `plugins/marketplace/index.ts`, which today name a Git repository only, so `tx marketplace add --help` does not contradict the input the command now accepts
  - [ ] Record the reference against the source's fully resolved real path, and validate and install through the existing `prepareMarketplace` path against that same real path, publishing the reference only after both succeed
  - [ ] Add a test that repoints an intermediate symbolic link after the marketplace is added and asserts the marketplace still resolves to the directory it was added from, proving the real path was pinned rather than the path as typed
  - [ ] Ensure no tx-owned failure path deletes, empties, or rolls back the referenced directory, and test it — the guarantee covers tx's own cleanup, not what a trusted lifecycle script does to the tree it runs in
  - [ ] Add tests covering classification of each source form, live re-reading of an edited entry without reinstalling, a local directory winning over `owner/repository` shorthand, a `file://` URL still cloning, an empty source being rejected without installing into or referencing the working directory, an existing non-directory being rejected, an inspection failure that is not `ENOENT` being reported rather than cloned, name derivation including `.`, a trailing separator, and a directory whose own name ends in `.git` (which keeps that suffix, unlike a Git source), and a rejected local source publishing nothing
  - [ ] Add an end-to-end test that a plugin edited in a referenced source dispatches its new behavior on the next invocation
  - [ ] Update `docs/manual/plugins.md` with local sources, the classification rule, the `file://` escape, dependency-installation timing, and the removal guarantee — in this same pull request, since it documents behavior this PR changes
  - [ ] Verify 100% coverage and `bun run check`

## Open Questions

- [ ] Should `marketplace list` distinguish a reference from a clone explicitly, rather than leaving it implicit in the path shape? Worth revisiting if authors report confusion once the feature is in use.
- [ ] Should a stale reference be removable through a dedicated prune command rather than by name? Not needed while the recovery diagnostic already names the exact `marketplace remove` invocation.
- [ ] Should adding a local source warn that dependency installation writes into the author's own tree? The write is the point of a live reference, but it is still `tx` touching a directory the user did not hand over for modification.

## References

- Spec: [Plugin System](../specs/plugin-system/), [Architecture](../specs/architecture/)
- Related changes: [0002-add-plugin-marketplaces](./0002-add-plugin-marketplaces.md), [0005-install-per-plugin-dependencies](./0005-install-per-plugin-dependencies.md), [0007-delegate-dispatch-to-plugins](./0007-delegate-dispatch-to-plugins.md)
- Manual: [Plugins](../manual/plugins.md)
- External: [Node.js `fs.symlink`](https://nodejs.org/api/fs.html#fspromisessymlinktarget-path-type), [Git URL syntax](https://git-scm.com/docs/git-clone#_git_urls)
