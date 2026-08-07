# 0013: Pin Marketplace Versions

## Summary

Let a user say which version of a marketplace they want. `tx marketplace add fx/cc@1.4.0` installs that version and records the pin; `tx update` then keeps the marketplace there, while still reporting a newer tag when the remote publishes one. `tx marketplace pin` and `tx marketplace unpin` change the decision afterwards.

**Spec:** [Updates](../specs/updates/)
**Status:** draft
**Depends On:** 0012

## Motivation

Without a pin, a marketplace is whatever its default branch happens to be. That is the right default — most users want the current version of the plugins they installed — and it is the wrong and only option for three cases that recur:

A user hit a regression. The remedy today is to stop updating that marketplace, which is not something they can express; the alternative is removing it entirely. A pin to the last good tag is the smallest correct answer, and it is also how a user gets *back* to that version, since a pin may name an older commit than the one installed.

A team wants everyone on the same plugin version. Any instruction that says "add this marketplace" produces a different installation depending on the day, and the difference shows up as a plugin behaving differently on one machine. `tx marketplace add fx/cc@1.4.0` in a setup document is reproducible in the way the document implies.

A marketplace publishes tags and a user wants releases rather than every commit on the default branch. Pinning to a tag with the update command still reporting newer tags gives them a release channel they step through deliberately.

The spelling matters as much as the feature. `fx/cc@1.4.0` reads the way every package manager's version syntax reads, and it costs no flag, no second argument, and no ordering to remember. It has to be parsed carefully, because `@` is also how an SSH source spells its user and how an HTTP(S) source spells a credential — which is why the rule is anchored on the last `@` after the last `/` rather than on the first one found.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable parsing, resolution, recording, pinning, and update-interaction behavior MUST have automated tests.
- Git execution MUST stay injected. No test may reach the network.
- The suffix parser MUST have a table-driven test covering every source form the plugin accepts: bare shorthand, HTTP(S) with and without userinfo, SCP-style, `ssh://`, `file://`, a bare path, a Windows drive letter, and each of those with and without a suffix. A parser that mistakes `git@host:owner/repo.git` for a pinned source MUST fail that test.
- A ref containing `/` MUST have a test asserting the suffix is rejected rather than read as part of the source, since that is the case the separator rule cannot represent.
- The precedence rule MUST have a test using a real temporary directory whose name contains `@`, asserting it is added as a live local reference under its full name and that no ref is parsed.
- The pin-survives-update requirement MUST have a test that fails against an implementation which moves a pinned checkout to the remote's default branch.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Updates: Marketplace Versions and Pins](../specs/updates/index.md#marketplace-versions-and-pins) owns the suffix syntax, its precedence against local classification, pin recording, pin-aware gathering, and the pin commands. [Updates: Marketplace Updates](../specs/updates/index.md#marketplace-updates) owns what applying a pinned marketplace does. Their scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **Classification runs first and is not modified.** [Plugin System: Local Marketplace Sources](../specs/plugin-system/index.md#local-marketplace-sources) decides local-versus-Git from the argument exactly as typed. Only a source it hands to Git is examined for a suffix, which is what keeps a directory named `tools@2` addable and keeps this change from touching a contract 0008 settled.
- **The pin is marketplace-plugin state.** Nothing about it reaches `src/`, and no new storage format is introduced for it.
- **A pin changes only which commit the update participant targets.** Everything else 0012 specified — blocking checks, preparation, restoration, reporting — applies to a pinned marketplace unchanged, except that a pinned marketplace may move backwards because the user named the commit-ish.
- **Adding at a ref is still one clone.** The clone is unchanged, including the [0010](./0010-retry-marketplace-clones-over-ssh.md) SSH retry; only what is checked out afterwards differs, and a ref that does not resolve fails the addition before anything is published.

## Design

### Approach

Source parsing gains one function: given a Git source, return the source and its ref. It finds the last `@` that occurs after the last `/`; if there is none, the source has no ref. `git@github.com:owner/repo.git` has its `@` before the last `/` and parses as unpinned, and so does `https://token@github.com/owner/repo.git`; `fx/cc@1.4.0` and `git@github.com:owner/repo.git@v1.4.0` both parse as pinned. The rule needs no list of source forms and no second parse of the source it splits. It is also the reason the suffix cannot carry a ref containing `/`, which the spec states and `marketplace pin` covers.

It runs after classification, so a local directory never reaches it, and `add` rejects a local source that carried a suffix rather than silently ignoring the version the user asked for.

Resolution follows the order the spec fixes — tag, branch, commit, then the `v`-prefixed retry for a ref beginning with a digit — against the staged clone, which already has the remote's refs and tags. A ref that resolves nowhere fails the addition, and staging is discarded exactly as it is for any other publication failure.

The pin is recorded in the checkout's own Git configuration under a `tx` key. Reading it is one local Git call, which the participant makes while it is already reading that repository; removing the marketplace removes the pin with it, because it lives inside the directory being removed.

The update participant changes in one place: resolving the target. Unpinned, the target is the remote's default branch as 0012 specified. Pinned, the target is what the recorded ref resolves to after the fetch — for a tag or a hash that is the same commit every time, so nothing is available; for a branch it moves with the branch. When the pin is a tag and the remote publishes a higher one, the higher tag is reported as detail and nothing is applied.

`marketplace pin` resolves the ref against the fetched remote before recording it, so a typo is rejected while the previous pin stands. It does not move the checkout: pinning states an intention, and `tx update` is where intentions become checkouts. `marketplace unpin` deletes the key.

### Decisions

- **Decision:** Spell the version as a `@<ref>` suffix on the source rather than as a `--ref` option.
  - **Why:** It is the spelling every package manager uses, it survives being copied into a setup document as one token, and it puts the version where the eye already looks for it. A flag would also have to be repeated in `pin`, where the ref is the whole argument.
  - **Alternatives considered:** `--ref <ref>` was rejected as a second thing to remember for something that is part of the source's identity. Supporting both was rejected as two syntaxes for one idea, with a conflict rule nobody should need to learn.

- **Decision:** Split on the last `@` following the last `/`.
  - **Why:** Every `@` that is *not* a version separator in a Git source appears in the authority — `git@host:path`, `https://user@host/path` — which is always before the last `/`. Anchoring on position instead of on source shape means the rule is one comparison, holds for source forms nobody has thought of, and cannot be defeated by a credential containing `@`, which [0010](./0010-retry-marketplace-clones-over-ssh.md) already established is real.
  - **Alternatives considered:** Parsing the source as a URL first and taking the suffix from its path was rejected: SCP syntax and bare paths do not parse, so it would need the source-form list this rule avoids. Splitting on the first `@` was rejected because it eats an SSH source's user. Requiring the ref to look like a version was rejected: branch names and hashes are legitimate refs and look like nothing in particular.

- **Decision:** A ref carried as a suffix may not contain `/`, and a slash-bearing ref is set with `marketplace pin` instead.
  - **Why:** The separator is defined by position against the last `/`, so a ref spelling one — `release/1.4` — moves the last `/` past the `@` and defeats the rule that makes the suffix readable without parsing the source. The alternatives are all worse than a second command: an escape syntax nobody would remember, or a resolution attempt that decides which side of the `@` a slash belongs to by trying both and preferring whichever happens to exist. Rejecting the suffix explicitly means the user gets told, rather than watching `tx` clone a repository they did not name.
  - **Alternatives considered:** Quoting or escaping the ref was rejected as syntax invented for one case. Splitting on the last `@` regardless of slashes was rejected because it breaks SCP-style sources, which is the case the position rule exists for. Probing both interpretations was rejected as behavior that depends on what exists remotely rather than on what the user typed.

- **Decision:** Classification wins over suffix parsing.
  - **Why:** [0008](./0008-link-local-marketplace-sources.md) settled that a source naming an existing directory is that directory, and a directory whose name contains `@` is unremarkable — `tools@2`, `notes@work`. Parsing the suffix first would rename such a directory out from under the user and then fail to find it, reporting an error about a repository they never mentioned. Running classification first means a local path is never split, and a suffix on a local source is an explicit error rather than a silent one.
  - **Alternatives considered:** Splitting first and falling back to the literal source when the split does not resolve was rejected as two filesystem probes producing an outcome that depends on which one happened to succeed.

- **Decision:** Try `v` + the ref when a numeric ref does not resolve.
  - **Why:** `@1.4.0` is what a user types and `v1.4.0` is what almost every repository tags, this project included. The fallback is bounded — one extra attempt, only when the ref starts with a digit, only after the literal ref failed everywhere — so it cannot shadow a real ref or make resolution ambiguous.
  - **Alternatives considered:** Stripping a leading `v` from the user's input as well was rejected as a second rule with no observed need. Doing no normalization was rejected as making the documented example fail against the project's own tags.

- **Decision:** Record the pin in the checkout's own Git configuration.
  - **Why:** It is state about one checkout that should die with that checkout, and Git configuration gives it that lifetime for free — `marketplace remove` deletes the directory and the pin goes with it, with no index to keep consistent. It also needs no new file format, no schema migration, and no rule keeping storage discovery from mistaking it for a marketplace. Reading it costs one local Git call in a place that is already running local Git calls.
  - **Alternatives considered:** A JSON sidecar in marketplace storage was rejected: it is a second source of truth about what is installed, it desynchronizes the moment anyone removes a directory by hand, and it needs its own containment and validation rules. Inferring the pin from a detached HEAD was rejected because it cannot distinguish "pinned here" from "a tracked branch that currently points here". A file inside the checkout was rejected as writing into the marketplace author's tree.

- **Decision:** A pinned marketplace may move backwards, and an unpinned one may not.
  - **Why:** These are different statements. An unpinned marketplace says "keep me current", so a target that is not a descendant is a sign something went wrong upstream. A pin says "put me at this", and the whole point of pinning after a regression is to go back. The distinction costs one condition and removes the need for a downgrade flag.
  - **Alternatives considered:** Requiring an explicit flag to move backwards under a pin was rejected as asking twice for something the user already named exactly.

- **Decision:** Report a newer tag for a tag-pinned marketplace, and apply nothing.
  - **Why:** "Gather all potential upgrades" is the point of the command, and a pinned marketplace has one — the user simply has not accepted it. Applying it would make the pin meaningless; hiding it would make the update report incomplete for exactly the marketplaces a user is most deliberately managing.
  - **Alternatives considered:** Treating a newer tag as available and applying it was rejected as ignoring the pin. Saying nothing was rejected as withholding the answer to the question asked.

- **Decision:** `marketplace pin` records without moving the checkout.
  - **Why:** Moving a checkout runs validation and a trusted dependency installation, which is `tx update`'s job and carries `tx update`'s failure handling and restoration. A pin command that quietly did all that would be an update with a different name, and its failure modes would have to be specified twice.
  - **Alternatives considered:** Pinning and applying in one step was rejected for that reason; a user who wants both types two commands, and the second one is the one they already know.

### Non-Goals

- Version ranges, semantic-version constraints, or any resolution policy beyond an exact ref. Recorded as an open question in [Updates](../specs/updates/index.md#open-questions).
- Pinning a local reference. A reference is live by definition.
- A lockfile, or any record of installed versions outside the checkouts themselves.
- Verifying that a pinned tag has not been moved on the remote. Tag immutability is the remote's contract, not `tx`'s.
- Pinning individual plugins inside a marketplace.
- Any change to `src/`, to classification, or to the clone path beyond what is checked out after it.

## Tasks

- [ ] Specify pins
  - [ ] Add [Updates: Marketplace Versions and Pins](../specs/updates/index.md#marketplace-versions-and-pins) covering the suffix, its precedence against classification, the separator rule and the `/` it cannot carry, ref resolution including the `v`-prefixed retry, name derivation, pin recording, pin-aware gathering, semantic-version tag comparison, the pin commands, and the version column
  - [ ] State in [Updates: Marketplace Updates](../specs/updates/index.md#marketplace-updates) that a pin may move a checkout in either direction
  - [ ] Add the pointer bullet to [Plugin System: Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership)
  - [ ] Add scenarios for adding a pinned version, a pin surviving an update, a directory beating a suffix, and unpinning
  - [ ] Update the spec's references and changelog, and both documentation indexes

- [ ] Parse the version suffix in `plugins/marketplace/`
  - [ ] Split a Git source on the last `@` following its last `/`, returning the source unchanged when there is none
  - [ ] Reject an empty ref, and reject a suffix whose ref contains `/` naming `marketplace pin` as the way to set one
  - [ ] Derive the marketplace name from the source without the suffix
  - [ ] Reject a local source that carried a suffix, naming the reason

- [ ] Resolve and record the pin when adding
  - [ ] Resolve a ref in the staged clone as a tag, then a remote branch, then a commit, retrying with a `v` prefix for a ref beginning with a digit
  - [ ] Check out the resolved commit in staging and fail the addition when the ref resolves nowhere, discarding staging as any other publication failure does
  - [ ] Record the pin as the user spelled it, in the checkout's Git configuration

- [ ] Make the update participant pin-aware
  - [ ] Read the pin and target what it resolves to after the fetch, keeping the default-branch target for an unpinned marketplace
  - [ ] Allow a pinned marketplace to move in either direction while keeping the ancestry requirement for an unpinned one
  - [ ] Report the pin, and report a higher tag published by the remote as detail without proposing to apply it

- [ ] Add `marketplace pin` and `marketplace unpin`
  - [ ] Resolve the ref against the fetched remote before recording, leaving the previous pin in place on failure
  - [ ] Reject pinning a referenced local marketplace
  - [ ] Record without moving the checkout, and report what the next update will do
  - [ ] Clear the pin on `unpin`, returning the marketplace to the remote's default branch

- [ ] Cover the new behavior in tests
  - [ ] A table-driven suffix parser test over every accepted source form, with and without a suffix
  - [ ] Precedence: a real temporary directory whose name contains `@` added as a live reference
  - [ ] Adding: a tag, a branch, a commit, a `v`-prefixed fallback, an unresolvable ref that publishes nothing, and a name derived without the suffix
  - [ ] Updating: a tag pin that does not move, a branch pin that does, a backwards pin that is allowed, an unpinned non-ancestor that is not, and the newer-tag detail
  - [ ] Pinning: an accepted ref, a rejected ref leaving the previous pin, a rejected local reference, and an unpin that resumes tracking
  - [ ] Listing: a pinned marketplace's version label

- [ ] Document pins in `docs/manual/plugins.md` and the version syntax in `README.md`, in the pull request that implements them
- [ ] Verify 100% coverage and `bun run check`

## Open Questions

- [ ] Should `marketplace list` mark which marketplaces are pinned, beyond showing the version they hold? A column of mostly-empty values against a marker in the version label is a formatting decision worth making with real output in front of us.
- [ ] Should a pin be settable at add time for a source that also needs `--name`, in one command? It already is; the question is whether the two interact in a way the manual has to spell out.
- [ ] Should the newer-tag report consider pre-release tags? Excluding them is probably right and needs a definition of pre-release that the marketplace manifest does not currently supply.

## References

- Spec: [Updates](../specs/updates/), [Plugin System](../specs/plugin-system/)
- Related changes: [0012-update-installed-marketplaces](./0012-update-installed-marketplaces.md), [0008-link-local-marketplace-sources](./0008-link-local-marketplace-sources.md), [0010-retry-marketplace-clones-over-ssh](./0010-retry-marketplace-clones-over-ssh.md)
- Manual: [Plugins](../manual/plugins.md)
- External: [`git rev-parse` revisions](https://git-scm.com/docs/gitrevisions), [`git config`](https://git-scm.com/docs/git-config)
