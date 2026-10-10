# 0034: Add Marketplace tx Compatibility

## Summary

Let a marketplace say which `tx` releases it supports and which commit carried each of its own versions, and act on it. The manifest gains three optional top-level fields — `version`, `tx`, and a `versions` release history mapping each released version to an immutable commit and its supported `tx` range. Loading refuses a marketplace whose checkout the running `tx` does not support, as an isolated plugin failure with a diagnostic, unless `TX_IGNORE_COMPATIBILITY=1` forces it. Adding and updating an unpinned marketplace install the newest version that supports the running `tx` rather than whatever its default branch holds.

**Spec:** [Updates](../specs/updates/), [Plugin System](../specs/plugin-system/)
**Status:** complete
**Depends On:** 0013, 0014, 0019

## Motivation

`tx` injects its own React, Ink, and command parser into every plugin, so a `tx` release that changes those changes the API every marketplace plugin is written against. Nothing today lets a marketplace say which `tx` it was written for. A marketplace that adopts a new `tx` API is installed and loaded by an older `tx` exactly as by a newer one, and fails there in whatever way the mismatch happens to produce — usually an error from inside a rendering library that names nothing the user can act on. The reverse is the same failure: a marketplace that has not caught up with a breaking `tx` release keeps loading under it, and breaks.

The user's remedy today is a pin, which they can only set after they have diagnosed the failure, found the last commit that worked, and learned that pins exist. That is the wrong way round. The publisher knows which `tx` each release supports at the moment they release it; the user's `tx` knows what version it is. Neither needs the user to bridge them.

So a marketplace declares, at the commit it publishes, which `tx` range that commit supports. A `tx` that falls outside it refuses to load the marketplace's plugins and says why — refusing is better than running code against an API it was not written for, and a refusal is isolated exactly as any other plugin failure is. And because a refusal alone would leave the user with nothing to run, the default branch also carries the marketplace's release history: each released version, the commit that carried it, and the `tx` range it supports. When the newest commit does not support the running `tx`, adding or updating installs the newest release that does — the last working version for this `tx` — and moves back to the newest commit as soon as the running `tx` supports it.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable validation, range, loading, override, selection, reporting, and listing behavior MUST have automated tests.
- Git execution MUST stay injected. No test may reach the network, and no test may depend on an SSH key, an agent, or a reachable host.
- Tests MUST create every marketplace root inside a temporary directory they own and MUST remove it afterwards.
- Manifest validation MUST have a table-driven test covering every field rule in [Plugin System: Marketplace Compatibility](../specs/plugin-system/index.md#marketplace-compatibility): each field absent, valid, of the wrong type, and malformed; a `v`-prefixed `version`; an empty and a whitespace-only `tx`; a `versions` element missing each required key; an abbreviated, uppercase, and non-hexadecimal `ref`; a 64-character `ref`; duplicate versions including two differing only in build metadata; and unknown keys at both levels. Each rejection MUST assert the message names the field and, for an element, its position.
- The range grammar MUST have a table-driven test of acceptance and of satisfaction whose expected outcomes are those of npm's reference `semver` implementation in its default mode. It MUST include every string Bun 1.4.2's built-in `Bun.semver.satisfies` was observed to treat as matching `1.8.0` although the grammar rejects it or the reference implementation does not match it — `garbage`, `latest`, `^1.0.0 garbage`, `>=1.0.0, <2`, and `1.8.0 1.9.0` — so an implementation that delegates to that function fails it. It MUST cover the pre-release rule in both directions, build metadata, every operator, X-ranges, tilde, caret including the `0.x` and `0.0.x` cases, hyphen ranges, and `||`.
- Load-time refusal MUST have a test that fails against an implementation which imports a plugin entry before refusing its marketplace, using an entry whose import has an observable side effect.
- Refusal MUST have a test asserting the dispatched command's exit code is unchanged, another marketplace's plugins load, and the marketplace management commands and update participant remain available.
- The override MUST have a test asserting `1` loads an incompatible marketplace with exactly one warning line for it and none for a compatible one, and that `true`, `0`, an empty value, and an unset variable do not.
- Selection MUST have a test that fails against an implementation which falls back to a lower history element when the candidate is unusable, one that fails against an implementation which records a pin when selecting from the history, and one that fails against an implementation which moves a compatible installation backwards.
- A test MUST assert that gathering — including any fetch of a candidate commit by its object name — leaves the checked-out commit, the working tree, and installed dependencies unchanged.
- Every scenario in [Plugin System: Marketplace Compatibility](../specs/plugin-system/index.md#marketplace-compatibility) and [Updates: Compatible Marketplace Versions](../specs/updates/index.md#compatible-marketplace-versions) MUST have a test that exercises it.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Plugin System: Marketplace Compatibility](../specs/plugin-system/index.md#marketplace-compatibility) owns the manifest fields, their validation, the range grammar and its pre-release rule, load-time refusal, its diagnostic, and the `TX_IGNORE_COMPATIBILITY` override. [Updates: Compatible Marketplace Versions](../specs/updates/index.md#compatible-marketplace-versions) owns selection on add and update, the backwards move, held reporting, the pin and local-source warnings, and the declared-version list column. Their scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **Everything lives in `plugins/marketplace/`.** The fields are marketplace-plugin state, read from the marketplace's own manifest; the running `tx` version is the one the host already injects as `dependencies.tx.version`, and the override is read from the `env` the host already exposes. Nothing reaches `src/`, and the public `@fx/tx/plugin` contract gains nothing.
- **One parser validates the fields wherever a manifest is parsed.** `parseMarketplaceManifestDocument` in `storage.ts` is already the single point every manifest read goes through — the working-tree read behind loading and `prepareMarketplace`, the reduced-retrieval plan, and `planMarketplaceManifestAtRevision` for an update's target. The new fields are validated there and returned with the plan, so add, update, and load cannot disagree about what a manifest declares.
- **Range parsing and satisfaction are implemented in the plugin, without a new dependency and without `Bun.semver`.** See Decisions.
- **Refusal happens in the marketplace definition, before any entry definition is contributed.** `marketplaceDefinition` in `index.ts` already reads the manifest before contributing one child per entry; the comparison sits between the two, so a refused marketplace contributes no child and no entry is imported.
- **Selection reads manifests at revisions, and never through the working tree.** Gathering reads the tip's manifest and the candidate's manifest by revision, as `planMarketplaceManifestAtRevision` already does for an update's target, so gathering still changes nothing installed. Fetching a candidate commit by object name writes only objects.
- **Adding at a selected commit reuses the pinned-add path, minus the pin.** `#stageVersion` already moves a staged clone onto a resolved commit before validation; selection uses the same move and records nothing.

## Design

### Approach

The change lands in two implementation pull requests after this one.

The first implementation pull request teaches the manifest parser the three fields and the plugin to refuse. A new module under `plugins/marketplace/` holds the version and range grammar — a strict SemVer 2.0.0 parser, a range parser for npm's grammar, and a satisfaction check following npm's default mode — and exports nothing but those. The manifest plan gains `version`, `tx`, and `versions`. `createMarketplacePlugin` passes `dependencies.tx.version` and the override's state to the discovery and marketplace definitions; `marketplaceDefinition` compares the manifest's range with the running version and either throws a compatibility diagnostic, which the existing failure isolation reports once for the marketplace, or contributes its children — writing the override's warning through `context.stderr` when it loaded one it would have refused. `marketplace list` reads each manifest's `version` for its fourth column, from the checkout, without Git.

The second implementation pull request adds selection. Both `MarketplaceUpdater#target` and the add path in `MarketplaceManager` call one selection function: given a checkout, the tip commit, and the running version, it reads the tip's manifest at that revision, returns the tip when it is compatible or unreadable, and otherwise picks the candidate from the tip's history, fetches its commit by object name when absent, and reads the candidate's own manifest at its revision. It returns the target together with what the reports need: whether the target came from the history, the tip's description and range, and the candidate's description or the reason it is unusable. The updater's blocking check consults the installed commit's compatibility before applying the forward-only rule to a history-selected target, and reports held, moved-back, and unusable outcomes as the spec requires. A pinned target is never passed through selection; it only gains a compatibility note in its detail. `marketplace add` with a ref or a local source, and `marketplace pin`, read the installed or pinned commit's manifest and warn.

### Decisions

- **Decision:** Declare compatibility once, for the whole marketplace, as a top-level `tx` range in the manifest.
  - **Why:** A marketplace is one checkout that moves as one — [Updates](../specs/updates/index.md#constraints) already makes updating one plugin independently of the rest out of scope — so the unit that can be installed at a compatible commit is the marketplace, and that is the unit that has to declare compatibility. This was decided by the user before specification.
  - **Alternatives considered:** A range per plugin entry was rejected with that decision: a checkout cannot hold one plugin at one commit and its sibling at another, so a per-plugin range could only refuse, never select, and would multiply what an author has to keep true.

- **Decision:** Keep the release history as a `versions` array in the default branch's manifest, not in Git tags.
  - **Why:** Selection needs, for every release, its commit and its supported `tx` range. Tags carry the commit and not the range, so a tag-based history would mean reading the manifest of every tagged commit on every gather — one blob fetch per release in a partial clone — to learn what one array states in a file the gather already reads. A manifest array also lets a publisher correct a release's range after the fact, which a tagged commit's own manifest cannot. This was decided by the user before specification.
  - **Alternatives considered:** Scanning tags was rejected for the cost above and with the user's decision. A separate history file was rejected as a second manifest location for [Minimal Clone Footprint](../specs/plugin-system/index.md#minimal-clone-footprint) to materialize and validate for no gain over a field in the one it already reads.

- **Decision:** A history element names its commit by full object name, not by tag or abbreviated hash.
  - **Why:** The history exists to say "this commit was version 1.5.0 and supports this `tx`". Only a full object name cannot be moved by the publisher or become ambiguous as the repository grows. The rule admits 64-character names because Git supports SHA-256 repositories and a rule written for 40 would reject them for nothing.
  - **Alternatives considered:** A tag name was rejected because [Marketplace Versions and Pins](../specs/updates/index.md#marketplace-versions-and-pins) deliberately follows a moved tag, which would let a history entry silently start describing a different commit. Accepting uppercase or abbreviated hashes was rejected as a second spelling of the same thing, and an abbreviation as one that can stop being unique.

- **Decision:** An absent top-level `tx` means compatible with every `tx`, while `tx` is required inside a history element.
  - **Why:** Every existing manifest has no `tx`, and treating that as incompatible with anything would break every marketplace on the release that ships this change. A history element has no existing manifests to preserve, and an element without a range would be selected under every `tx` there is, which is a claim an author should have to write down (`*`) rather than get by omission.
  - **Alternatives considered:** Requiring `tx` at the top level was rejected as a breaking change to every marketplace. Making it optional in elements too was rejected for the reason above.

- **Decision:** Confirm, and rely on, the parser ignoring unknown keys.
  - **Why:** `parseMarketplaceManifestDocument` reads only `plugins` from the document and only `name`, `entry`, and `package` from an entry, and [Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership) says the manifest MAY contain additional configuration. So every released `tx` already ignores `version`, `tx`, and `versions`, and a marketplace can adopt them today without breaking a single installation. Keeping unknown keys ignored, inside a history element too, is what lets a later change add keys this one does not know.
  - **Alternatives considered:** Rejecting unknown keys was rejected: it would make every future field a breaking change for whichever `tx` releases predate it.

- **Decision:** Implement the range grammar and its satisfaction rule in the marketplace plugin, rather than calling Bun's built-in `Bun.semver.satisfies` as first sketched.
  - **Why:** Bun's function does not reject anything. Under the pinned Bun 1.4.2 it was observed to return `true` for version `1.8.0` against `garbage`, `latest`, `^1.0.0 garbage`, and `>=1.0.0, <2`, none of which is a valid range, and against `1.8.0 1.9.0`, which is a valid range nothing satisfies. A typo in a manifest would therefore read as "compatible with every `tx`" — the precise opposite of what the field exists to say — and no validator in front of it can fix the last case, which is a valid range evaluated wrongly. The plugin also already avoids Bun's global types, because it is type-checked by consumers that install `@fx/tx` without them: `module.ts` declares the slice of the runtime it uses, and `manager.ts` orders release tags with its own comparison for the same reason.
  - **Alternatives considered:** A strict validator in front of `Bun.semver.satisfies` was rejected because two parsers can disagree about a valid string, as `1.8.0 1.9.0` shows they do. Depending on npm's `semver` package was rejected as a new runtime dependency in the compiled executable and in the plugin's module graph for one function, when the grammar is small, fixed, and covered by a table-driven test whose expected outcomes are that package's own; it remains the fallback if the hand-written grammar ever proves costly, and is recorded as an open question.

- **Decision:** Accept npm's whole range grammar, not a subset.
  - **Why:** Authors already write npm ranges. More importantly, a range this release cannot parse is a manifest error, so if a later release accepted more syntax, every `tx` implementing this change would reject — not merely refuse — a marketplace using it. Accepting the whole established grammar now means the grammar never has to grow.
  - **Alternatives considered:** A caret-and-comparator subset was rejected for that forward-compatibility cost. Treating an unparseable range as "incompatible" rather than invalid was rejected because it hides an author's typo behind a refusal that blames the user's `tx`.

- **Decision:** Match pre-release `tx` versions by npm's default pre-release rule.
  - **Why:** A pre-release of a major `tx` version is exactly the window in which its breaking changes land, so `2.0.0-rc.1` should not satisfy `^1.0.0 || ^2.0.0` merely because its core does; a marketplace that has tested against the release candidate says so with `^2.0.0-rc.0`. It is also what every npm user already expects a range to mean. A tester running a pre-release `tx` against marketplaces that have not opted in has the override.
  - **Alternatives considered:** Ignoring the pre-release component (npm's `includePrerelease`) was rejected for the reason above.

- **Decision:** Exclude pre-release history elements from selection.
  - **Why:** [Marketplace Versions and Pins](../specs/updates/index.md#marketplace-versions-and-pins) already never offers a pre-release tag as an upgrade, because a pre-release is the version its publisher has not offered yet. Selecting one automatically would contradict that. A user who wants one pins it.
  - **Alternatives considered:** Treating pre-release elements as ordinary candidates was rejected as installing what the publisher has not released.

- **Decision:** An invalid compatibility field is a manifest error, and the override does not bypass it.
  - **Why:** The override answers "I know this `tx` is outside the range you declared"; it cannot answer a range that does not parse, because there is no declaration to override. Reporting it as an invalid manifest names the field and points at the author, where the fault is.
  - **Alternatives considered:** Letting the override load a marketplace whose range is invalid was rejected as turning an author's typo into something every user has to work around.

- **Decision:** Refuse once per marketplace, before importing anything, rather than failing each plugin.
  - **Why:** The point of refusing is not to run code written against a different API, and importing an entry runs its top-level code and resolves its dependency graph. Refusing at the marketplace definition stops that before it starts, and reports one diagnostic for one cause instead of one per plugin. It is also exactly how an invalid manifest is already reported.
  - **Alternatives considered:** Contributing each entry and failing it when it loads was rejected for importing what it means to refuse, and for repeating one diagnostic per plugin.

- **Decision:** Name the override `TX_IGNORE_COMPATIBILITY` and enable it only for the exact value `1`.
  - **Why:** The name says what it does, under a `TX_` prefix no other variable `tx` reads uses yet. An exact value keeps `TX_IGNORE_COMPATIBILITY=0` and `=false` from meaning "on", which a presence test would make them, and one accepted spelling is one thing to document. A warning per loaded marketplace keeps the override from becoming invisible in a shell profile.
  - **Alternatives considered:** A command-line flag was rejected because refusal happens while plugins load, before any command's options are parsed, and the flag would have to be global. Accepting any non-empty value was rejected for the `=0` case. A per-marketplace list of names was rejected as surface without a need yet, and is recorded as an open question.

- **Decision:** The override changes loading only, never selection.
  - **Why:** Loading is per invocation and reversible: unset the variable and the refusal is back. Selection moves checkouts. A variable left set in a shell profile would otherwise make every `tx update` move every marketplace to its newest commit regardless of what the running `tx` supports, and leave them there after it is unset. A user who wants an incompatible version installed names it with a pin, which is persistent on purpose.
  - **Alternatives considered:** Having the override also select the tip was rejected for that reason.

- **Decision:** Select from the tip's history only, and treat the selected commit's own manifest as the authority.
  - **Why:** The tip is the one commit every installation reads, so it is where a publisher corrects or withdraws an entry. The released commit's own manifest is what the plugins at that commit were actually shipped with, so when the two disagree the history is wrong and installing on its word would install exactly the refused marketplace this change exists to avoid.
  - **Alternatives considered:** Merging the histories of the tip and the installed commit was rejected as making the outcome depend on which commit happened to be installed. Trusting the history element without reading the commit was rejected for the reason above.

- **Decision:** Never fall back past an unusable candidate to a lower release.
  - **Why:** An unusable candidate — a commit the remote does not serve, or one whose manifest contradicts the history — is a publisher's mistake, and silently installing an even older release in its place hides that mistake behind a version the user did not expect. Failing, or holding, names the problem; the user can still pin any release they want.
  - **Alternatives considered:** Walking down the history to the next compatible element was rejected as trading a visible error for an invisible downgrade.

- **Decision:** Selection records nothing.
  - **Why:** A pin means "the user chose this", and a selected version is not a choice anyone made: it is the answer to a question that changes when `tx` does. Leaving the marketplace unpinned is what returns it to the tip as soon as the running `tx` supports the tip, with no command the user has to know to run.
  - **Alternatives considered:** Writing a pin when selecting from the history was rejected for that reason. Recording a separate "held" marker was rejected as state that the next gather recomputes anyway.

- **Decision:** An unpinned marketplace moves backwards only when the running `tx` refuses the commit it is on.
  - **Why:** [Change 0013](./0013-update-installed-marketplaces.md) held unpinned marketplaces to moving forward because a non-descendant target signals something wrong upstream. A history-selected target is not that signal, but moving a working installation back to an older release would still trade working code for older code. The only installation worth moving backwards is one that does not load — which is precisely "install the last working version for this `tx`". An installed commit whose manifest cannot be read or is invalid counts as not compatible because it does not load either.
  - **Alternatives considered:** Exempting history-selected targets from the ancestry rule entirely was rejected as downgrading working installations. Never moving backwards was rejected as leaving a refused installation refused until the publisher ships something newer.

- **Decision:** A held marketplace is not a failure; a refused installation with nothing to move to is.
  - **Why:** [The Update Command](../specs/updates/index.md#the-update-command) reserves non-zero exits for refusals the user has to resolve. A marketplace held on a working commit needs nothing from anyone until a newer `tx` arrives. A marketplace whose installed commit is refused and that has no compatible release is refused on every invocation; that is outstanding, and `tx update --dry-run` exiting zero over it would hide it.
  - **Alternatives considered:** Reporting both as failures was rejected because a held marketplace would then fail every update run while working. Reporting neither as a failure was rejected because a refused installation with nothing to move to would then exit zero.

- **Decision:** A pinned or local addition, and `marketplace pin`, warn rather than refuse when what they name is incompatible.
  - **Why:** The user named that version or that directory. Refusing would leave them unable to install what they then intend to run with the override — or, for a local reference, unable to develop a marketplace against a `tx` its manifest does not yet admit. A warning tells them what will happen on the next invocation.
  - **Alternatives considered:** Failing the addition was rejected for that reason. Saying nothing was rejected as letting the first sign be a refused command.

- **Decision:** Show the declared `version` as a fourth `marketplace list` column, after the source, rather than in the version label column.
  - **Why:** The label column is required to equal the label `tx update` reports, and identifies the commit; a declared version does not — the commit that appends a release's history element declares that release's version too. Appending a column keeps every existing column where scripts reading the tab-separated output expect it, and a fixed placeholder keeps the column non-empty exactly as the source column already is.
  - **Alternatives considered:** Replacing the label with the declared version was rejected because two commits can declare the same version. Combining both in one column was rejected as changing a label the spec requires to be shared with `tx update`.

### Non-Goals

- Per-plugin compatibility ranges, or installing plugins of one marketplace at different commits. A marketplace remains one checkout that moves as one.
- Reading release history from Git tags.
- Any change to how a `tx` release predating this change treats a manifest. It ignores the new fields, and nothing a marketplace declares can change that.
- Selection for a pinned marketplace or a live reference. A pin is the user's choice and a reference is live; both are still refused at load when incompatible.
- Resolving `<source>@<version>` through the history when no tag exists, and version ranges in pins. Both are recorded as open questions in [Updates](../specs/updates/index.md#open-questions).
- Selecting marketplaces for a `tx` the same `tx update` run is about to install. Recorded as a constraint and an open question in [Updates](../specs/updates/index.md#constraints).
- Signing, provenance, or verifying that a history element's commit is what its publisher released.
- Any change to `src/` or to the public `@fx/tx/plugin` contract.
- Timeouts on Git or Bun operations, per [PR Review](../../REVIEW.md).

## Tasks

- [x] Specify marketplace tx compatibility and version history (PR #81)
  - [x] Add [Plugin System: Marketplace Compatibility](../specs/plugin-system/index.md#marketplace-compatibility) covering the `version`, `tx`, and `versions` fields and their validation, ignored unknown keys, npm's range grammar and pre-release rule, the running `tx` version, load-time refusal and its diagnostic, and the `TX_IGNORE_COMPATIBILITY` override, with scenarios (PR #81)
  - [x] Add the pointer bullet to [Plugin System: Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership) and the constraint about `tx` releases that predate the fields (PR #81)
  - [x] Add [Updates: Compatible Marketplace Versions](../specs/updates/index.md#compatible-marketplace-versions) covering selection, candidate fetching, the commit's own manifest as authority, no fallback, no recorded pin, add reporting and failure, pin and local-source warnings, the backwards move, held and failed reporting, pinned detail, and the list column, with scenarios (PR #81)
  - [x] Point the forward-only and target-resolution bullets of [Updates: Marketplace Updates](../specs/updates/index.md#marketplace-updates) at the new section, and add the design note, the same-run constraint, and the open questions (PR #81)
  - [x] Update both specs' overviews, references, and changelogs, and both documentation indexes (PR #81)

- [x] Declare compatibility and refuse incompatible marketplaces (PR #82)
  - [x] Add a module under `plugins/marketplace/` parsing strict SemVer 2.0.0 versions, parsing npm's range grammar in its default mode, and deciding satisfaction including the pre-release rule and ignored build metadata, with no new dependency and no use of `Bun.semver` (PR #82)
  - [x] Validate `version`, `tx`, and `versions` in `parseMarketplaceManifestDocument`, as content failures naming the field and element position, and return them with the manifest plan and the resolved manifest (PR #82)
  - [x] Pass `dependencies.tx.version` and the override's state from `createMarketplacePlugin` into discovery and `marketplaceDefinition` (PR #82)
  - [x] Refuse an incompatible marketplace in `marketplaceDefinition` after reading its manifest and before contributing any entry definition, with the diagnostic the spec requires and without the removal remedy (PR #82)
  - [x] Load it instead when `TX_IGNORE_COMPATIBILITY` is exactly `1`, writing one warning line per such marketplace to standard error (PR #82)
  - [x] Add the declared-version column to `marketplace list`, with a fixed placeholder, read from the checkout without Git (PR #82)
  - [x] Cover the new behavior: the table-driven validation and range tests from Testing Requirements; refusal before import; exit-code and sibling isolation; management commands and the participant still available; override values; a live reference and a pinned clone both refused; the list column for a clone, a reference, an undeclared version, and an unreadable manifest (PR #82)
  - [x] Document declaring compatibility in `docs/manual/plugins.md` — the three fields with an example, the range grammar and pre-release rule, what a refusal looks like, and the override — and the new list column, in the pull request that implements them (PR #82)
  - [x] Verify 100% coverage and `bun run check` (PR #82)

- [x] Select compatible versions when adding and updating
  - [x] Add one selection function under `plugins/marketplace/` that reads the tip's manifest at its revision, returns the tip when it is compatible or unreadable, otherwise picks the candidate from the tip's history excluding pre-releases, fetches its commit by object name non-interactively when absent, and checks the candidate's own manifest at its revision, returning the target with what reports need
  - [x] Use it in `MarketplaceManager` for an unpinned Git `add`, moving staging onto a history-selected commit through the path `#stageVersion` uses without writing a pin, reporting the selected version, and failing with nothing published when there is no usable target
  - [x] Warn on a pinned or local `add`, and on `marketplace pin`, when the installed or pinned commit is not compatible
  - [x] Use it in `MarketplaceUpdater#target` for unpinned marketplaces, in both gathering and applying
  - [x] Decide the installed commit's compatibility from its own manifest, counting an unreadable or invalid one as not compatible, and apply the backwards move and the held outcome in `#blockingCondition` and gathering
  - [x] Report held, moved-back, unusable-candidate, and no-target outcomes with the detail and failure the spec requires, and add the compatibility note to a pinned marketplace's detail
  - [x] Cover the new behavior: every [Updates: Compatible Marketplace Versions](../specs/updates/index.md#compatible-marketplace-versions) scenario; no fallback past an unusable candidate; no pin recorded; a compatible installation never moved backwards; a candidate fetched by object name and one the remote does not serve; an unreadable tip manifest targeting the tip, reported by validation when the tip is a new commit and not revalidated when it is the installed commit; dry-run invariance including the candidate fetch; `marketplace install` selecting as `add` does
  - [x] Document selection in `docs/manual/plugins.md`, with a release recipe for authors: set `version` and `tx` in the release commit; once that commit exists, append a `versions` element carrying its full object name and range in a later commit on the default branch, since a commit cannot contain its own object name; and make sure the last release supporting the previous `tx` range is in the history before the default branch raises `tx`
  - [x] Verify 100% coverage and `bun run check`, and mark this change complete

## Open Questions

- [ ] Should the hand-written range grammar be replaced by a dependency on npm's `semver` package if it ever needs more than the fixed grammar this change specifies? Its table-driven test already takes that package's outcomes as the expected ones, so the swap would be mechanical.
- [ ] Should `TX_IGNORE_COMPATIBILITY` accept a list of marketplace names, so one marketplace can be forced without forcing every other? Nothing needs it yet, and a second accepted shape is a second thing to document.
- [ ] Should `marketplace list` mark a marketplace the running `tx` refuses? The diagnostic already appears on every invocation, and a fifth column is a formatting decision worth making with real output in front of us.
- [ ] Should selection follow a `tx update` run that replaces the executable, so one run finishes what now takes two? Tracked in [Updates: Open Questions](../specs/updates/index.md#open-questions).

## References

- Spec: [Updates](../specs/updates/), specifically [Compatible Marketplace Versions](../specs/updates/index.md#compatible-marketplace-versions); [Plugin System](../specs/plugin-system/), specifically [Marketplace Compatibility](../specs/plugin-system/index.md#marketplace-compatibility)
- Related changes: [0033-upgrade-to-ink-8-and-react-19-3](./0033-upgrade-to-ink-8-and-react-19-3.md), [0013-update-installed-marketplaces](./0013-update-installed-marketplaces.md), [0014-pin-marketplace-versions](./0014-pin-marketplace-versions.md), [0019-reduce-marketplace-clone-footprint](./0019-reduce-marketplace-clone-footprint.md), [0006-isolate-plugin-failure-exit-codes](./0006-isolate-plugin-failure-exit-codes.md)
- Manual: [Plugins](../manual/plugins.md)
- External: [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html), [npm `semver` ranges](https://github.com/npm/node-semver#ranges), [`git fetch`](https://git-scm.com/docs/git-fetch), [`git cat-file`](https://git-scm.com/docs/git-cat-file)
