# 0011: Add a Generic Update Lifecycle

## Summary

Give the host one more generic contribution — an update participant — and add a bundled `update` plugin that drives whatever has been contributed. `tx update` gathers what could change and applies it; `tx update --dry-run` gathers and stops. Neither the host nor the driver knows what a marketplace or an executable is; the plugins that own those contribute participants in [0012](./0012-update-installed-marketplaces.md) and [0014](./0014-update-the-tx-executable.md).

**Spec:** [Updates](../specs/updates/)
**Status:** draft
**Depends On:** 0007

## Motivation

Nothing installed by `tx` can be brought up to date. A marketplace is cloned once and stays at that commit forever; the only way forward is `marketplace remove` followed by `marketplace add`, which discards the installed name's history and re-runs the whole install. The executable has no update path at all beyond whatever installed it.

The obvious shape — a `marketplace update` subcommand, and separately some `self update` — was rejected deliberately. It puts the user in charge of remembering which of their installed things has its own update verb, and it means every future plugin that installs something invents a third one. A user who wants to be current should type one command.

But one command must not become one command that knows about everything. `tx update` hardcoding marketplace vocabulary would put marketplace knowledge back into a place that does not own it, and would make the marketplace plugin a special case rather than what the [Plugin System](../specs/plugin-system/) insists it is: an ordinary plugin that could be copied to another repository. So the driver has to be able to ask something it has never heard of what it would change.

The host already does exactly this shape twice. A plugin stages commands and child plugin definitions; the host commits them atomically, discards them when the plugin fails, and hands them to whoever consumes them. An update participant is a third contribution with the same lifecycle, and the same reason to exist: it lets a plugin publish a capability without the host learning the capability's domain.

The other half of the motivation is what this change refuses to build. `tx` will never check for updates on its own — not on startup, not once a day, not behind a flag. A CLI that phones home on an unrelated invocation spends a user's network, latency, and trust on something they did not ask for, and a cached "update available" nag is the same cost paid in disk. The prohibition is recorded as a requirement in [Updates: Never Automatic](../specs/updates/index.md#never-automatic) so that adding it later requires changing a specification rather than adding a feature.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files, which `test/coverage.test.ts` discovers by walking `src/` and `plugins/` — a new plugin directory is covered by that gate the moment it exists.
- Every new observable staging, isolation, ordering, gathering, reporting, and exit-code behavior MUST have automated tests.
- Participants used in tests MUST be stubs defined by the test. No test may reach the network, the filesystem outside a temporary directory it owns, or a real marketplace.
- The driver MUST be tested against stub participants only. A test that reaches the marketplace plugin to exercise the driver proves the coupling this change exists to prevent.
- `test/plugin-boundary.test.ts` MUST keep passing, and MUST cover the new bundled plugin directory on the same terms as the existing one.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Plugin System: Update Participation](../specs/plugin-system/index.md#update-participation) owns the contribution contract, its staging and isolation, and the public type shape. [Updates: The Update Command](../specs/updates/index.md#the-update-command) owns the command's surface, gathering, applying, reporting, and exit codes, and [Updates: Never Automatic](../specs/updates/index.md#never-automatic) owns the prohibition. Their scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **The host gains a third contribution and no vocabulary.** `src/` learns that a participant is a value with a `gather` and an `apply`, that it is staged like a command, and that it is handed back with its owner's identity. It learns nothing about versions, networks, marketplaces, or executables, and `src/` MUST NOT name any of them.
- **The public contract gains types only.** `UpdateItem`, `UpdateResult`, `UpdateParticipant`, and `UpdateParticipation` are declared in the public plugin module, which is the shared vocabulary an externalized plugin already imports type-only. No runtime API is added to `@fx/tx/plugin`.
- **The driver is a bundled plugin, not core.** `tx update` is owned by a plugin under `plugins/`, composed in the root composition file alongside the marketplace plugin, and subject to the same boundary rules.
- **This change ships a driver with nothing to drive.** With no participant contributed, `tx update` reports that there is nothing installed to update and exits zero. That is the correct behavior and it is what the tests assert; 0012 and 0014 supply participants.
- **Composition order becomes observable.** Participant order follows the host's FIFO commit order, which for root definitions is composition order — the property [0014](./0014-update-the-tx-executable.md) relies on to have the executable applied after every other default plugin. It does not order a participant contributed by a *child* definition, which the host queues behind every root, and the spec says so rather than promising an ordering the host does not produce.

## Design

### Approach

Three touched places, in order of how little they change.

`src/plugin.ts` gains the participant types and two members on `PluginAPI`: `update(participant)` to contribute, `updaters()` to read. It is a types-only module, so this costs no runtime.

`src/plugins.ts` gains a `participants` array alongside the existing `namespaces`, and stages contributions into a per-plugin array exactly as it stages `children`. On success the staged participants are pushed onto the shared list, each frozen with the plugin's identity; on failure they are dropped with everything else the plugin staged. `updaters()` returns a frozen snapshot of the shared list at the moment it is called, which is why a plugin reading it during initialization sees only what was committed before it — and why the driver reads it inside its command action, when everything has been committed.

The `update` plugin claims the `update` namespace and puts its behavior on the namespace root: a `--dry-run` flag, optional positional item names, and an action. It calls `api.updaters()`, gathers from each participant in order, prints a line per item, and — unless the run is a dry run — applies each in-scope item, printing its result. It catches around every participant call, so one throw becomes one reported failure rather than an aborted run, and it tracks whether anything failed to decide the exit code. Its only knowledge of what it is updating is the four string fields on an item.

An item is in scope when no names were given, or when its name is one of them. A given name matching nothing is a failure reported before anything is applied, so a typo does not silently update everything.

### Decisions

- **Decision:** One `tx update` command, rather than `marketplace update` plus a separate self-update verb.
  - **Why:** The user asked for one command and for plugins to hook into it, and the two goals are the same goal: a command that covers everything installed is only maintainable if the things installed describe themselves. A per-plugin update verb also scales badly in the direction this project is built for — every marketplace plugin that installs anything would invent its own spelling, and none of them would be reachable from one place.
  - **Alternatives considered:** `tx marketplace update` alongside `tx self update` was the first proposal and was rejected: two commands, two exit-code contracts, and a third one needed the moment anything else installs something. An aggregate `tx update` layered over per-plugin verbs was rejected as all three at once.

- **Decision:** Add update participation to the host as a first-class contribution, rather than a generic keyed service registry (`provide(key, value)` / `consume(key)`).
  - **Why:** A keyed registry is more general and less useful here. It would push the participant contract into whichever plugin defined the key, so the marketplace plugin would have to import the update plugin's types — plugin-to-plugin coupling, and an externalized marketplace plugin would need a second package to compile against. It also trades away type safety at exactly the boundary that needs it: `consume("update")` returns `unknown`, and the driver casts. Making participation first-class keeps the shared vocabulary in `@fx/tx/plugin`, which every plugin already imports, and keeps `src/` free of the domain regardless.
  - **Alternatives considered:** An event bus was rejected for the same reason plus an ordering contract nobody wants to specify. Declaring the participant types inside the update plugin and having the marketplace plugin import them type-only was rejected: it makes one bundled plugin a dependency of another, which the boundary rules do not forbid but the externalization goal does not survive.

- **Decision:** The host stores and hands over participants and never calls one.
  - **Why:** Calling a participant means deciding when, in what order, with what error handling, and what to do with the result — all of which are the driver's policy, and all of which would be marketplace-shaped policy living in `src/`. It also keeps the failure model unchanged: a participant that throws throws inside the driver's command, which is an ordinary command failure with an ordinary exit code, rather than a new class of host failure needing its own isolation rules.
  - **Alternatives considered:** A host-run update lifecycle with hooks was rejected as generic lifecycle hooks, which the [Plugin System](../specs/plugin-system/) constrains out of scope and which nothing here needs.

- **Decision:** `updaters()` reads what is committed at call time, rather than being delivered to the driver as an argument.
  - **Why:** Contributions are committed as plugins initialize, and the driver is one of those plugins. Anything delivered at initialization would be a snapshot taken before later plugins ran, so the driver would see participants contributed by plugins composed before it and miss the rest — including the executable plugin, which is composed last on purpose. Reading at call time is the only shape where composition order determines participant order without also determining who is visible.
  - **Alternatives considered:** Passing the committed list into command actions was rejected as a signature the host does not prescribe for plugin commands. Deferring the driver's initialization until after everything else was rejected as an ordering rule that would need enforcing.

- **Decision:** Put the command on the `update` namespace root rather than under a subcommand.
  - **Why:** `tx update` is the whole feature. A namespace whose only content is `tx update update` would be a worse spelling of the same thing, and the host already permits a plugin to define whatever it likes beneath its namespace root, including an action on the root itself.
  - **Alternatives considered:** `tx update all` with room for siblings was rejected as speculative: item names already select subsets.

- **Decision:** A dry run exits zero when updates are available.
  - **Why:** The exit code answers "did the command work", not "is anything out of date". A dry run that exits non-zero because an update exists cannot be used in a script that also has to detect a *failed* check, since both spellings collapse onto 1 — and the project maps every failure onto exactly that code. Callers who want the other question answered read the output.
  - **Alternatives considered:** A distinct exit code for "updates available" was rejected: [Architecture: Core CLI](../specs/architecture/index.md#core-cli) requires that failures not be distinguished by exit code, and inventing a third value for a non-failure would be a worse violation of the same rule.

- **Decision:** Report every item, including those that are current.
  - **Why:** The dry run's job is to answer a question, and silence is not an answer — a user cannot tell "everything is current" from "the participant found nothing" from "no participants are installed". Listing everything makes the same output serve as an inventory.
  - **Alternatives considered:** Printing only actionable items with a summary count was rejected as strictly less information for the same number of lines in the common case.

- **Decision:** Version labels are opaque strings the driver never parses.
  - **Why:** The two known participants version incomparably — a marketplace's version is a commit ordered only by its own history, the executable's is a semantic version — and a third could be anything. Comparing centrally would force every participant into one scheme and would put the comparison rules in the plugin least equipped to know them.
  - **Alternatives considered:** Requiring semantic versions everywhere was rejected because a marketplace has none. A comparator supplied per participant was rejected as a callback with one caller that only re-answers a question `available` already answers.

### Non-Goals

- Any participant. This change adds the mechanism and the command; 0012 and 0014 add the things to update.
- Machine-readable output. Recorded as an open question in [Updates](../specs/updates/index.md#open-questions); line-oriented output is what `marketplace list` already produces and greps the same way.
- Progress reporting while a participant applies. A result per item is what the contract carries today.
- Concurrency. Participants apply sequentially, and a run that installs dependencies has output a user needs to read in order.
- Any automatic check, cache, notice, daemon, or configuration key that could enable one. This is a requirement, not an omission.
- Generic lifecycle hooks beyond this one contribution.
- Any change to how commands, child definitions, or namespaces are staged and committed.

## Tasks

- [ ] Specify the update lifecycle
  - [ ] Add [Updates](../specs/updates/) covering the never-automatic prohibition, the command surface, and the participant-facing contract
  - [ ] Add [Plugin System: Update Participation](../specs/plugin-system/index.md#update-participation) with the contribution mechanics, isolation, ordering, and public type shape
  - [ ] Extend the Plugin System's atomic-staging requirement and scenario to cover participants
  - [ ] Record in [Architecture: Composition Root](../specs/architecture/index.md#composition-root) that composition order fixes participant order
  - [ ] Replace the Architecture and Plugin System statements that automatic updates are out of scope with pointers to the prohibition
  - [ ] Update the specs' references and changelogs, and both documentation indexes

- [ ] Add the participant contract to the public plugin module
  - [ ] Declare `UpdateItem`, `UpdateResult`, `UpdateParticipant`, and `UpdateParticipation` in `src/plugin.ts`
  - [ ] Add `update(participant)` and `updaters()` to `PluginAPI`
  - [ ] Confirm the module stays types-only and adds no runtime export

- [ ] Stage and commit participants in `src/plugins.ts`
  - [ ] Stage contributions per plugin, rejecting a contribution made after initialization exactly as a late command registration is rejected
  - [ ] Commit staged participants frozen with their owner's identity, in FIFO order, and drop them with everything else when the plugin fails
  - [ ] Return a frozen snapshot from `updaters()` at call time
  - [ ] Confirm no marketplace, network, version, or update-domain vocabulary enters `src/`

- [ ] Add the bundled `update` plugin under `plugins/update/`
  - [ ] Claim the `update` namespace and define the action on its root with `--dry-run` and optional item names
  - [ ] Gather from every committed participant in order, reporting each item's name, current label, available label or its absence, and detail
  - [ ] Reject item names that match nothing before applying anything
  - [ ] Apply in-scope items sequentially, skipping every apply on a dry run
  - [ ] Report results on standard output and failures on standard error through the injected context streams
  - [ ] Isolate each participant call so one failure neither aborts the run nor hides the remaining items, report an item that carries its own failure as failed without applying it, and exit non-zero when anything failed
  - [ ] Compose the plugin in `cli.ts` after the marketplace plugin, with the ordering stated

- [ ] Cover the new behavior in tests
  - [ ] Extend `test/plugins.test.ts` with staging, commit-order, late-contribution, and failure-drop cases for participants
  - [ ] Add `test/update-plugin.test.ts` driving stub participants: gather-only dry runs, applied runs, selection by name, an unmatched name, gather failures, apply failures, an item carrying its own failure alongside healthy siblings that still apply, an applied-nothing result that does not fail the run, mixed outcomes, and exit codes
  - [ ] Assert a dry run calls no participant's apply
  - [ ] Assert the driver never imports marketplace or executable modules, through `test/plugin-boundary.test.ts`
  - [ ] Assert `tx update` with no participants reports nothing to update and exits zero

- [ ] Document `tx update` and the participant contract in `docs/manual/plugins.md`, in the pull request that implements it
- [ ] Verify 100% coverage and `bun run check`

## Open Questions

- [ ] Should a participant be able to declare that its items are mutually exclusive, or that one must apply before another? Nothing needs it; composition order covers the only ordering constraint known today.
- [ ] Should `updaters()` be exposed on `initializePlugins`' result as well, for a future consumer that is not a plugin? No such consumer exists, and adding it would be an untested public surface.
- [ ] Should the driver print a summary line after a run? A per-item line is enough at the scale of two participants, and a summary is easy to add once a run can be long.

## References

- Spec: [Updates](../specs/updates/), [Plugin System](../specs/plugin-system/)
- Related changes: [0007-delegate-dispatch-to-plugins](./0007-delegate-dispatch-to-plugins.md), [0012-update-installed-marketplaces](./0012-update-installed-marketplaces.md), [0014-update-the-tx-executable](./0014-update-the-tx-executable.md)
- Manual: [Plugins](../manual/plugins.md)
