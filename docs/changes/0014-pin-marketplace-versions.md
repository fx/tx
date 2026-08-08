# 0014: Pin Marketplace Versions

## Summary

Let a user say which version of a marketplace they want. `tx marketplace add fx/cc@1.4.0` installs that version and records the pin; `tx update` then keeps the marketplace there, while still reporting a newer tag when the remote publishes one. `tx marketplace pin` and `tx marketplace unpin` change the decision afterwards.

**Spec:** [Updates](../specs/updates/)
**Status:** complete
**Depends On:** 0013

## Motivation

Without a pin, a marketplace is whatever its default branch happens to be. That is the right default — most users want the current version of the plugins they installed — and it is the wrong and only option for three cases that recur:

A user hit a regression. The remedy today is to stop updating that marketplace, which is not something they can express; the alternative is removing it entirely. A pin to the last good tag is the smallest correct answer, and it is also how a user gets *back* to that version, since a pin may name an older commit than the one installed.

A team wants everyone on the same plugin version. Any instruction that says "add this marketplace" produces a different installation depending on the day, and the difference shows up as a plugin behaving differently on one machine. `tx marketplace add fx/cc@1.4.0` in a setup document is reproducible in the way the document implies.

A marketplace publishes tags and a user wants releases rather than every commit on the default branch. Pinning to a tag with the update command still reporting newer tags gives them a release channel they step through deliberately.

The spelling matters as much as the feature. `fx/cc@1.4.0` reads the way every package manager's version syntax reads, and it costs no flag, no second argument, and no ordering to remember. It has to be parsed carefully, because `@` is also how an SSH source spells its user and how an HTTP(S) source spells a credential — which is why the separator is looked for only outside the source's authority, the part Git reads to find the host, rather than anywhere in the string.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable parsing, resolution, recording, pinning, and update-interaction behavior MUST have automated tests.
- Git execution MUST stay injected. No test may reach the network.
- The suffix parser MUST have a table-driven test covering every source form the plugin accepts: bare shorthand, HTTP(S) with and without userinfo, SCP-style, `ssh://`, `file://`, a bare path, a Windows drive letter, and each of those with and without a suffix. A parser that mistakes `git@host:owner/repo.git` for a pinned source MUST fail that test.
- A ref containing `/` MUST have a test asserting it parses as a ref, for every source form, since that is the case an authority-blind separator rule silently gets wrong.
- The pre-release exclusion MUST have a test asserting a pre-release tag higher than the pin is not reported, alongside one asserting an ordinary tag higher than a pre-release pin is.
- The precedence rule MUST have a test using a real temporary directory whose name contains `@`, asserting it is added as a live local reference under its full name and that no ref is parsed.
- The pin-survives-update requirement MUST have a test that fails against an implementation which moves a pinned checkout to the remote's default branch.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Updates: Marketplace Versions and Pins](../specs/updates/index.md#marketplace-versions-and-pins) owns the suffix syntax, its precedence against local classification, pin recording, pin-aware gathering, and the pin commands. [Updates: Marketplace Updates](../specs/updates/index.md#marketplace-updates) owns what applying a pinned marketplace does. Their scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **Classification runs first and is not modified.** [Plugin System: Local Marketplace Sources](../specs/plugin-system/index.md#local-marketplace-sources) decides local-versus-Git from the argument exactly as typed. Only a source it hands to Git is examined for a suffix, which is what keeps a directory named `tools@2` addable and keeps this change from touching a contract 0008 settled.
- **The pin is marketplace-plugin state.** Nothing about it reaches `src/`, and no new storage format is introduced for it.
- **A pin changes only which commit the update participant targets.** Everything else 0013 specified — blocking checks, preparation, restoration, reporting — applies to a pinned marketplace unchanged, except that a pinned marketplace may move backwards because the user named the commit-ish.
- **Adding at a ref is still one clone.** The clone is unchanged, including the [0010](./0010-retry-marketplace-clones-over-ssh.md) SSH retry; only what is checked out afterwards differs, and a ref that does not resolve fails the addition before anything is published.

## Design

### Approach

Source parsing gains one function: given a Git source, return the source and its ref. It skips the source's authority and then takes the last `@` in what remains. The authority ends at the first `/` after `://` for a scheme, at the colon for SCP-style syntax, and does not exist for anything else. So `git@github.com:owner/repo.git` and `https://token@github.com/owner/repo.git` parse as unpinned, `fx/cc@1.4.0` and `git@github.com:owner/repo.git@v1.4.0` parse as pinned, and `fx/cc@release/1.4` pins to a slash-bearing branch without an escape syntax.

That boundary does not exist in the plugin today and this change introduces it. `carriesGitSyntax` answers a related question — is the first colon before the first slash — with a boolean, and returns nothing about where the authority ends; the two share a rule and not an implementation. Which makes this the third parser in the module reading a source by its own rules, so implementing it SHOULD settle the open question [0010](./0010-retry-marketplace-clones-over-ssh.md) recorded about unifying them, or record why it still should not be settled.

It runs after classification, so a local directory never reaches it, and `add` rejects a local source that carried a suffix rather than silently ignoring the version the user asked for.

Resolution follows the order the spec fixes — tag, branch, commit, then the `v`-prefixed retry for a ref beginning with a digit — against the staged clone, which already has the remote's refs and tags. A ref that resolves nowhere fails the addition, and staging is discarded exactly as it is for any other publication failure.

The pin is recorded in the checkout's own Git configuration under a `tx` key. Reading it is one local Git call, which the participant makes while it is already reading that repository; removing the marketplace removes the pin with it, because it lives inside the directory being removed.

The update participant changes in one place: resolving the target. Unpinned, the target is the remote's default branch as 0013 specified. Pinned, the target is what the recorded ref resolves to against the freshly fetched remote — a hash is the same commit every time, a branch moves with the branch, and a tag moves if the remote moved it, which the pin follows because it names the ref rather than a commit. When the pin is a tag and the remote publishes a higher release tag, that tag is reported as detail and nothing is applied.

`marketplace pin` resolves the ref against the fetched remote before recording it, so a typo is rejected while the previous pin stands. It does not move the checkout: pinning states an intention, and `tx update` is where intentions become checkouts. `marketplace unpin` deletes the key.

### Decisions

- **Decision:** Spell the version as a `@<ref>` suffix on the source rather than as a `--ref` option.
  - **Why:** It is the spelling every package manager uses, it survives being copied into a setup document as one token, and it puts the version where the eye already looks for it. A flag would also have to be repeated in `pin`, where the ref is the whole argument.
  - **Alternatives considered:** `--ref <ref>` was rejected as a second thing to remember for something that is part of the source's identity. Supporting both was rejected as two syntaxes for one idea, with a conflict rule nobody should need to learn.

- **Decision:** Exclude the source's authority, then split on the last `@` in what remains. Supersedes an earlier decision on this branch that anchored the split on the last `@` following the source's last `/`.
  - **Why:** Every `@` that is *not* a version separator lives in the authority — `git@host:path`, `https://user@host/path` — so excluding the authority is the rule, stated directly. Anchoring on the last `/` instead was an approximation of it that held only while refs contained no `/`: `fx/cc@release/1.4` moves the last `/` past the `@`, so the suffix silently stops being a suffix and `tx` clones a repository nobody typed. Excluding the authority costs the same single scan, keeps the credential case [0010](./0010-retry-marketplace-clones-over-ssh.md) established as real, and admits slash-bearing refs, which is most of what the approximation cost.
  - **Alternatives considered:** Parsing the source as a URL first was rejected: SCP syntax and bare paths do not parse, so it would need a source-form list. Splitting on the first `@` was rejected because it eats an SSH source's user. Forbidding `/` in a suffix ref and directing users to `marketplace pin` was rejected once it became clear the restriction was unenforceable — the parser cannot see a suffix it has already failed to split, so the rejection could never fire and the user would get a clone failure naming a repository they did not ask for. Requiring the ref to look like a version was rejected: branch names and hashes are legitimate refs and look like nothing in particular.

- **Decision:** The suffix carries refs whose names contain no `@`; a ref that contains one is set with `marketplace pin`.
  - **Why:** Git permits `@` inside a ref name, and no separator rule can find the right `@` in `fx/cc@release@beta` without knowing which side the user meant. Taking the last one splits it as source `fx/cc@release` with ref `beta`, and the addition then fails against a remote nobody named — noisy, but not silent, which is the most that can be promised here. `pin` has the ref as an argument of its own and needs no separator, so nothing is unreachable. The limitation is stated in the spec rather than left to be discovered, and it costs a construction almost nobody writes: `@` in a ref name is legal and vanishingly rare, while the same character is the version separator of every package manager a user has met.
  - **Alternatives considered:** An escape or quoting syntax was rejected as notation invented for a case with no observed users. Trying both splits and preferring whichever resolves was rejected as making the meaning of an argument depend on what happens to exist on a remote. Claiming the suffix accepts any commit-ish was rejected as the claim that was actually wrong.

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

- **Decision:** Unify the authority *rule* rather than the parsers, settling the open question [0010](./0010-retry-marketplace-clones-over-ssh.md) recorded.
  - **Why:** The boundary is the one thing `carriesGitSyntax` and the suffix parser genuinely share, and a disagreement between them is exactly how an SSH login becomes a version. One function answers it for both, so classification and versioning cannot drift apart. Name derivation and SSH derivation answer different questions under their own contracts — what a source is called, and how else it can be reached — and folding them into one `parseGitSource` would produce a single function with three result shapes and three sets of edge cases, which unifies nothing.
  - **Alternatives considered:** One `parseGitSource` returning every reading of a source was rejected for that reason. Leaving the boundary duplicated was rejected because the two rules would then be free to disagree, which is the defect this change exists to avoid.

- **Decision:** Fetch tags forced.
  - **Why:** A pin to a tag follows the tag, so the local answer for that ref has to be what the remote publishes now. An unforced `fetch --tags` refuses to update a tag it already holds *and* fails the whole fetch for it, so a publisher moving one tag would have reported every marketplace on that remote as unreachable — the pin requirement exposes an existing fetch that could not survive a moved tag. Tag immutability is the remote's contract rather than tx's, and the checkout is tx's own.
  - **Alternatives considered:** Resolving a pinned tag through a separate `ls-remote` was rejected as a second network round trip for something the fetch is already carrying.

- **Decision:** Admit `@` in an installed marketplace's name.
  - **Why:** [Local Marketplace Sources](../specs/plugin-system/index.md#local-marketplace-sources) derives a reference's name from the directory on disk, and this change requires a directory named `tools@2` to be added under that name. Without it the precedence rule would resolve correctly and then refuse to name the result, sending the user to `--name` for a directory that is unremarkable. The character is inert for path safety: a name is still one component, with no separator and no leading dot. Manifest plugin names are unaffected — they have no directory to agree with, so they keep the narrower rule.
  - **Alternatives considered:** Reporting `tools@2` as unnameable was rejected as failing the scenario for a reason that has nothing to do with versions.

### Non-Goals

- Version ranges, semantic-version constraints, or any resolution policy beyond an exact ref. Recorded as an open question in [Updates](../specs/updates/index.md#open-questions).
- Pinning a local reference. A reference is live by definition.
- A lockfile, or any record of installed versions outside the checkouts themselves.
- Freezing a pin to the commit it first resolved to. A pin names a ref and is re-resolved on every update, so a tag the remote moves is followed; tag immutability is the remote's contract, not `tx`'s, and recording the commit would mean reporting a marketplace as current while its pinned ref points somewhere else.
- Pinning individual plugins inside a marketplace.
- Any change to `src/`, to classification, or to the clone path beyond what is checked out after it.

## Tasks

- [x] Specify pins (PR #30)
  - [x] Add [Updates: Marketplace Versions and Pins](../specs/updates/index.md#marketplace-versions-and-pins) covering the suffix, its precedence against classification, the authority-excluding separator rule, ref resolution including the `v`-prefixed retry, name derivation, pin recording, pin-aware gathering and re-resolution, semantic-version tag comparison, the pin commands, and the version column (PR #30)
  - [x] State in [Updates: Marketplace Updates](../specs/updates/index.md#marketplace-updates) that a pin may move a checkout in either direction (PR #30)
  - [x] Add the pointer bullet to [Plugin System: Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership) (PR #30)
  - [x] Add scenarios for adding a pinned version, a pin surviving an update, a directory beating a suffix, and unpinning (PR #30)
  - [x] Update the spec's references and changelog, and both documentation indexes (PR #30)

- [x] Parse the version suffix in `plugins/marketplace/`
  - [x] Introduce the authority boundary — first `/` after `://`, the colon in SCP syntax, absent otherwise — and split a Git source on the last `@` outside it, returning the source unchanged when there is none
  - [x] Reject an empty ref
  - [x] Derive the marketplace name from the source without the suffix
  - [x] Reject a local source that carried a suffix, naming the reason

- [x] Resolve and record the pin when adding
  - [x] Resolve a ref in the staged clone as a tag, then a remote branch, then a commit, retrying with a `v` prefix for a ref beginning with a digit
  - [x] Check out the resolved commit in staging and fail the addition when the ref resolves nowhere, discarding staging as any other publication failure does
  - [x] Record the pin as the user spelled it, in the checkout's Git configuration

- [x] Make the update participant pin-aware
  - [x] Read the pin and target what it resolves to after the fetch, keeping the default-branch target for an unpinned marketplace
  - [x] Allow a pinned marketplace to move in either direction while keeping the ancestry requirement for an unpinned one
  - [x] Report the pin, and report a higher release tag published by the remote as detail, excluding pre-releases, without proposing to apply it

- [x] Add `marketplace pin` and `marketplace unpin`
  - [x] Resolve the ref against the fetched remote before recording, leaving the previous pin in place on failure
  - [x] Reject pinning a referenced local marketplace
  - [x] Record without moving the checkout, and report what the next update will do
  - [x] Clear the pin on `unpin`, returning the marketplace to the remote's default branch

- [x] Cover the new behavior in tests
  - [x] A table-driven suffix parser test over every accepted source form, with and without a suffix
  - [x] Precedence: a real temporary directory whose name contains `@` added as a live reference
  - [x] Adding: a tag, a branch, a commit, a `v`-prefixed fallback, an unresolvable ref that publishes nothing, and a name derived without the suffix
  - [x] Updating: a tag pin that does not move, a branch pin that does, a tag the remote moved that is followed, a backwards pin that is allowed, an unpinned non-ancestor that is not, and the newer-tag detail including a non-semantic-version tag that produces no comparison
  - [x] Pinning: an accepted ref, a rejected ref leaving the previous pin, a rejected local reference, and an unpin that resumes tracking
  - [x] Listing: a pinned marketplace's version label

- [x] Document pins in `docs/manual/plugins.md` and the version syntax in `README.md`, in the pull request that implements them
- [x] Verify 100% coverage and `bun run check`

## Open Questions

- [ ] Should `marketplace list` mark which marketplaces are pinned, beyond showing the version they hold? A column of mostly-empty values against a marker in the version label is a formatting decision worth making with real output in front of us.
- [ ] Should a pin be settable at add time for a source that also needs `--name`, in one command? It already is; the question is whether the two interact in a way the manual has to spell out.
- [ ] Should a marketplace be able to opt into pre-release tags being reported? They are excluded outright today, which is right for a user tracking releases and wrong for one testing a marketplace's next version — and an opt-in needs somewhere to live that is not a pin.

## References

- Spec: [Updates](../specs/updates/), [Plugin System](../specs/plugin-system/)
- Related changes: [0013-update-installed-marketplaces](./0013-update-installed-marketplaces.md), [0008-link-local-marketplace-sources](./0008-link-local-marketplace-sources.md), [0010-retry-marketplace-clones-over-ssh](./0010-retry-marketplace-clones-over-ssh.md)
- Manual: [Plugins](../manual/plugins.md)
- External: [`git rev-parse` revisions](https://git-scm.com/docs/gitrevisions), [`git config`](https://git-scm.com/docs/git-config)
