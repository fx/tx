# 0019: Reduce Marketplace Clone Footprint

## Summary

Let `marketplace add` and marketplace updates retrieve, for a Git-sourced marketplace, only the manifest and the repository content the manifest's validated plugin entries and package selections require, instead of the marketplace's complete history and tree, whenever the local Git installation and the remote support it. [Plugin System: Minimal Clone Footprint](../specs/plugin-system/index.md#minimal-clone-footprint) owns the observable behavior; this change implements it against the existing clone and update code paths.

**Spec:** [Plugin System](../specs/plugin-system/)
**Status:** draft
**Depends On:** —

## Motivation

`MarketplaceManager#cloneStaging` runs a plain `git clone -- <source> <staging>` with no `--depth`, `--filter`, or sparse-checkout options — every install and every update fetch retrieves the marketplace's complete history and tree, even though only `.tx/config.json` (or the legacy `tx.marketplace.json`) and the files its `plugins` array resolves to are ever read. For a marketplace repository that bundles large unrelated assets, documentation, or history alongside a small set of plugins, this makes every `marketplace add` and every update far slower and heavier than the data actually consumed.

A naive fix — fetching only `.tx/` — does not work: `.tx/config.json`'s `entry` and `package` fields are repository-relative paths that routinely point outside `.tx/` (the manual's own example resolves to `plugins/notes.ts` and `plugins/reports/index.ts`). A footprint reduction that only ever materializes `.tx/` would silently fail validation for the overwhelming majority of real marketplaces, which is worse than not attempting one. This change instead reads the manifest first and derives what to retrieve from what it actually declares.

This change deliberately stops at that concrete need. It does not add sparse-checkout controls the user configures, a manifest schema that declares its own footprint, or any change to what `.tx/config.json` may contain.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable reduced-retrieval, fallback, re-validation, and update re-derivation behavior MUST have automated tests, including the case where a reduced retrieval must fall back to a complete one before a failure is reported.
- Tests MUST exercise both an environment where the reduced-retrieval mechanism is available and one where it is not (or is made to fail), without depending on which mechanism the local `git` binary actually supports, since CI's `git` version is not controlled by this change.
- `test/marketplaces.test.ts`, `test/marketplace-updates.test.ts`, and `test/marketplace-plugin.test.ts` MUST keep passing against the new clone and update paths.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Plugin System: Minimal Clone Footprint](../specs/plugin-system/index.md#minimal-clone-footprint) owns the observable behavior — when a reduced retrieval is attempted, what it must make available, how its validation must match a complete retrieval, and when it must fall back. Those scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **`#cloneStaging` gains a manifest-driven reduced-retrieval attempt before its existing full clone.** The existing HTTPS-then-derived-SSH retry loop in `manager.ts` is unchanged; the reduced attempt sits in front of it, per candidate source, and a failure of the reduced attempt for a reason unrelated to the manifest falls through to today's full clone of that same candidate rather than abandoning the candidate.
- **Manifest discovery for a reduced retrieval reuses `storage.ts`'s existing path-resolution logic, not a parallel implementation.** `resolveMarketplaceManifest`, `resolvePluginEntry`, and the package-candidate resolution it already calls are the single source of truth for what a path resolves to and whether it is valid; the reduced-retrieval planner calls them against whatever is currently materialized rather than re-deriving its own notion of a valid entry.
- **A presence-dependent validation failure under a reduced retrieval triggers one retry against a complete retrieval of the same clone, not a second full clone attempt from scratch.** The retry extends the existing staging checkout to the complete tree; it does not discard it and start over, so work already done (fetched objects, resolved candidates unaffected by the missing path) is not repeated.
- **`fetchCheckoutRemote` and the update path re-derive the reduced-retrieval footprint from the target commit's manifest before `moveCheckout` completes what a later `prepareMarketplace` call will validate.** `MarketplaceUpdater#gatherMarketplace` and `apply()` in `updater.ts` are the call sites; the manifest at the target commit is read without requiring that commit's full tree to already be present, and the footprint is extended before validation runs against the moved checkout.
- **The explicit full-retrieval request is a new `marketplace add` option**, threaded through the same path `#clone` already uses, that skips the reduced attempt entirely and goes straight to today's full clone.
- **Capability detection follows the existing behavioral-probe convention, not a `git --version` comparison.** `manager.ts` has no version-comparison helper anywhere (`hasConfiguredSshCommand` probes behavior directly instead of parsing a version string), and this change does not introduce one; a reduced-retrieval attempt that fails is treated as "not available here" and falls back, the same way a clone failure already does today.
- **Local marketplace sources are untouched.** `#reference` and `#resolveLocalSource` have no retrieval to reduce; this change touches only `#clone`, `#cloneStaging`, and the update path.

#### Scenario: Retry extends staging rather than restarting the clone

- **GIVEN** a reduced retrieval staged a checkout that is missing a path a valid manifest entry resolves to
- **WHEN** validation fails for that reason
- **THEN** the same staging checkout is extended to the complete tree and re-validated, without discarding it and cloning again from nothing

#### Scenario: Explicit full retrieval skips the reduced attempt

- **GIVEN** `marketplace add` is invoked with the explicit full-retrieval request
- **WHEN** the source clones
- **THEN** no reduced-retrieval attempt is made and the marketplace is cloned exactly as it is today

## Design

### Approach

`#cloneStaging` currently builds a list of candidate sources (HTTPS, then a derived SSH fallback) and tries `git clone -- <candidate> <staging>` against each in turn. This change inserts, for each candidate, an attempt to fetch a Git partial clone (`--filter=blob:none`) with cone-mode sparse-checkout initially scoped to `.tx/` **and** the repository root's `tx.marketplace.json` file, before falling through to the existing full `git clone`. Both locations are materialized up front because `storage.ts`'s manifest resolution already accepts either one, and a marketplace predating `.tx/config.json` has no `.tx/` directory at all — scoping the initial fetch to `.tx/` alone would make a legacy-only marketplace's manifest indistinguishable from a genuinely absent one. If the reduced attempt succeeds, `storage.ts`'s `resolveMarketplaceManifest` reads and validates whichever manifest is present exactly as it does today; whichever repository-relative directories the validated `entry` and `package` fields resolve into are then added to the sparse-checkout set and checked out, and validation runs again against that broader set. A presence-dependent failure at that point (not a shape/content failure — see the spec's split between the two, which also covers a manifest, entry, or package path that is itself a symbolic link whose target the current sparse-checkout set does not yet include) triggers dropping the partial-clone filter and materializing the complete tree in the same checkout, then a final validation pass; only that pass's outcome is ever reported to the user.

The update path mirrors this: `fetchCheckoutRemote`'s `git fetch` already keeps whatever partial-clone filter the checkout was cloned with, so no repeated per-fetch filter argument is needed. Before `moveCheckout` checks out the target commit, the manifest at that commit is read via a plumbing command that does not require the working tree to move first, the sparse-checkout set is extended for whatever that commit's manifest resolves to, and only then does the checkout move and `prepareMarketplace` re-validate.

### Decisions

- **Decision:** Scope the reduced retrieval to a two-phase fetch (both manifest locations first, then manifest-derived directories) rather than trying to compute the full footprint before any network access.
  - **Why:** The footprint cannot be known before the manifest is read, and the manifest cannot be read before something is fetched. `.tx/config.json` and the legacy root `tx.marketplace.json` are the only two fixed, well-known locations a manifest can occupy, and a marketplace need only have one of them — a marketplace predating `.tx/config.json` has no `.tx/` directory at all — so both must be materialized before "no manifest is present" can be told apart from "the manifest's location was not fetched."
  - **Alternatives considered:** Scoping the initial fetch to `.tx/` alone was rejected — and this document's own first draft made exactly that mistake — because it makes a legacy-only marketplace's manifest indistinguishable from a genuinely absent one, contradicting [Plugin System: Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership)'s requirement that a marketplace predating `.tx/config.json` remain loadable through the legacy manifest. Asking a marketplace to declare its own footprint (e.g., a `paths` field in `.tx/config.json`) was rejected as a manifest schema change with no concrete need beyond this optimization, and as something an author could get wrong or let drift from the `plugins` array it should match.

- **Decision:** On a presence-dependent validation failure, extend the existing staging checkout to the complete tree and re-validate there, rather than discarding it and cloning again with no filter.
  - **Why:** The reduced retrieval already paid for a working `.git` and whatever objects it fetched; discarding it would repeat that network cost for the exact case reduced retrieval was least effective for. Extending in place also keeps the single-retry rule in [Plugin System: Minimal Clone Footprint](../specs/plugin-system/index.md#minimal-clone-footprint) cheap to satisfy without a second staging directory.
  - **Alternatives considered:** Restarting from a fresh full clone was rejected as strictly more expensive with no correctness benefit; the existing checkout's objects remain valid regardless of how the sparse-checkout cone changes.

- **Decision:** Distinguish presence-dependent from content-only validation failures explicitly, and only retry on the former. A path counts as presence-dependent whenever it exists as a repository entry — including a manifest, entry, or package path that is itself a symbolic link — but its target has not been made available by the reduced retrieval; a path counts as content-only only when neither supported manifest location exists as a repository entry at all, or a manifest that was successfully read is malformed.
  - **Why:** [Plugin System: Minimal Clone Footprint](../specs/plugin-system/index.md#minimal-clone-footprint) requires identical validation outcomes to a complete retrieval; retrying on every failure would work but would also mean a marketplace with a genuinely malformed manifest pays for a complete retrieval before it can be told its JSON does not parse, on every single install attempt. The "exists as a repository entry" line is what keeps this correct rather than merely convenient: `resolveMarketplaceManifest` (`storage.ts`) resolves the manifest path itself through `realpath` before reading it, so a manifest that is a symbolic link whose target sits in a directory the reduced retrieval never fetched fails to resolve for a reason indistinguishable, from inside the reduced checkout, from the manifest genuinely not existing. Treating every unresolved manifest as content-only would report that marketplace as broken when a complete retrieval would install it, breaking the identical-validation requirement exactly as the `.tx/`-only initial scope did for a legacy-only marketplace.
  - **Alternatives considered:** Retrying unconditionally on any validation failure was rejected for the wasted-retrieval cost above. Never retrying, and requiring the explicit full-retrieval option instead, was rejected as breaking installation for any marketplace whose layout the initial manifest-location pass under-scopes for a reason other than a genuine error — for example a symbolic link resolving through a directory the manifest-derived set did not anticipate. Treating "manifest fails to resolve" as always content-only was rejected once the symbolic-link case above was found: it silently breaks a marketplace a complete clone would install successfully.

- **Decision:** Add an explicit `marketplace add` option to force a complete retrieval, rather than relying solely on the automatic fallback.
  - **Why:** A plugin's nonliteral dynamic import can reach outside the manifest-derived directories in a way no validation pass at install time can detect (it only fails later, when `tx` actually loads and runs the plugin). An author who knows their marketplace does this needs a way to opt out up front rather than discovering the failure downstream.
  - **Alternatives considered:** Relying only on the presence-dependent-failure fallback was rejected because it cannot catch a dynamic-import failure, which surfaces at plugin-load time, not at the validation this change's fallback covers.

- **Decision:** Detect whether the reduced-retrieval mechanism is available by attempting it and treating failure as unavailability, rather than parsing `git --version`.
  - **Why:** `manager.ts` has no version-comparison helper today, and its existing precedent (`hasConfiguredSshCommand`) is a behavioral probe, not a version check. Reusing that shape avoids introducing new machinery for a project that declares no minimum Git version anywhere (no `engines` field, no CI pin) and cannot plausibly encounter a Git old enough for partial clone or sparse-checkout to matter in practice.
  - **Alternatives considered:** Adding a `git --version` parse-and-compare helper was rejected as new machinery introduced for a check the try-and-fall-back pattern already covers for free, and one this codebase has never needed before.

### Non-Goals

- A user-facing command or config key to inspect or tune the sparse-checkout set directly; the set is always derived from the manifest.
- A manifest field for a marketplace to declare its own footprint.
- Any change to what `.tx/config.json` or the legacy manifest may contain, or to entry/package validation rules themselves.
- Reducing the footprint of a local (referenced, non-cloned) marketplace source, which has none to reduce.
- Detecting or mitigating a nonliteral dynamic import that reaches outside the reduced footprint at plugin-load time; the explicit full-retrieval option and the tracked [Open Question](../specs/plugin-system/index.md#open-questions) are the only mitigations this change provides.

## Tasks

- [ ] Add manifest-driven reduced retrieval to marketplace install (PR #1)
  - [ ] Add a reduced-retrieval attempt to `#cloneStaging` in `manager.ts`, scoped initially to both `.tx/` and the repository root's `tx.marketplace.json` file, per candidate source, ahead of the existing full `git clone`
  - [ ] After a successful reduced attempt, read and validate the manifest via `storage.ts`'s existing `resolveMarketplaceManifest`, extend the checkout to the directories its validated entries and packages resolve to, and re-validate
  - [ ] On a presence-dependent validation failure — including a manifest, entry, or package path that exists as a repository entry (a symbolic link included) but whose target the current sparse-checkout set does not include — extend the same staging checkout to the complete tree and re-validate before reporting any failure; report a content-only failure (neither supported manifest location existing as a repository entry at all, or a manifest that read successfully but is malformed) immediately without extending
  - [ ] On failure of the reduced-retrieval mechanism itself (unrelated to the manifest), fall back to today's full clone for that candidate
  - [ ] Add the explicit `marketplace add` option that skips the reduced attempt and always performs a full clone
  - [ ] Cover: successful reduced retrieval and validation; a legacy marketplace with only a root `tx.marketplace.json` and no `.tx/` directory installing successfully under reduced retrieval; a manifest that is itself a symbolic link whose target sits outside the initial sparse-checkout set, installing successfully after the presence-dependent fallback; presence-dependent failure retried and resolved against the complete tree; content-only failure (including a genuinely absent manifest, with both locations already materialized and neither existing as a repository entry) reported without a retry; reduced-mechanism unavailability falling back to a full clone; the explicit full-retrieval option skipping the reduced attempt; local sources unaffected
  - [ ] Update `docs/manual/plugins.md` to describe the reduced retrieval and the explicit full-retrieval option
  - [ ] Verify 100% coverage and `bun run check`

- [ ] Re-derive the footprint on update (PR #2)
  - [ ] In `updater.ts`, read the target commit's manifest before `moveCheckout` runs, without requiring that commit's complete tree to already be present
  - [ ] Extend the checkout's sparse-checkout set for whatever that commit's manifest resolves to before `moveCheckout` completes and `prepareMarketplace` re-validates
  - [ ] Apply the same presence-dependent-failure fallback to a complete retrieval as install uses, using `restoreCheckout` exactly as today's rollback already does if `prepareMarketplace` still fails afterward
  - [ ] Cover: an update whose new commit adds a plugin entry in a previously unretrieved directory; an update whose new commit's manifest fails validation for a content-only reason; an update falling back to a complete retrieval on a presence-dependent failure
  - [ ] Verify 100% coverage and `bun run check`

## Open Questions

- [ ] Whether a marketplace author should have a way to declare, inside `.tx/config.json`, that their plugins' nonliteral dynamic imports reach outside the manifest-derived directories, so a reduced retrieval is never attempted for that marketplace at all — tracked in [Plugin System: Open Questions](../specs/plugin-system/index.md#open-questions), not resolved by this change.

## References

- Spec: [Plugin System](../specs/plugin-system/), specifically [Minimal Clone Footprint](../specs/plugin-system/index.md#minimal-clone-footprint)
- Related changes: [0010-retry-marketplace-clones-over-ssh](./0010-retry-marketplace-clones-over-ssh.md), [0011-resolve-plugin-dependencies-by-node-rules](./0011-resolve-plugin-dependencies-by-node-rules.md), [0013-update-installed-marketplaces](./0013-update-installed-marketplaces.md)
- Manual: [Plugins](../manual/plugins.md)
- External: [Git partial clone (`--filter`)](https://git-scm.com/docs/partial-clone), [Git sparse-checkout](https://git-scm.com/docs/git-sparse-checkout)
