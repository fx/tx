# 0031: Publish the Dialogs and Config Contracts

## Summary

Publish the remaining two bundled capability contracts — dialogs and config — over the mechanism [Change 0030](./0030-publish-bundled-capability-contracts.md) establishes, and retire the local copies their consumers maintain.

**Spec:** [Dialogs](../specs/dialogs/), [Config](../specs/config/)
**Status:** complete
**Depends On:** 0030

## Motivation

[Change 0030](./0030-publish-bundled-capability-contracts.md) settles what publishing a capability contract means and proves it on theming and the grid. Dialogs and config are the two capabilities left, and leaving them behind would be worse than never having started: a consumer would have to learn which capabilities it may import and which it must still restate, with nothing in the type system to tell it apart.

Each has a specific reason its contract is not merely a file to point at:

- **Config.** The provider declares `Config` and `ConfigValidator` file-locally in `plugins/config/index.ts` and exports neither. The only exported copy in the repository lives in `plugins/marketplace/configured.ts`, whose module imports the marketplace manager — some two thousand lines reaching `node:child_process`, `node:fs`, and the marketplace's source and storage modules. The type itself needs none of it. Publishing that file would put the entire marketplace implementation graph behind a config import.
- **Dialogs.** `plugins/dialogs/types.ts` mixes the capability's contract with the provider's internals: `DialogElement` is defined in terms of `CoreDependencies["react"]["createElement"]`, which is a rendering detail no consumer of `select` and `input` needs, and `FilterMode` comes from `plugins/dialogs/filter.ts`, a module of matcher code. The published contract is a subset of that file, not the file.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions)). CI enforces these as merge gates:

- Tests MUST use Bun's test runner, and new observable behavior MUST have automated tests.
- Tests MUST maintain 100% statement, function, and line coverage across production source files; coverage exclusions MUST stay limited to generated or non-executable files and MUST be documented in configuration.
- Every first-party executable file committed MUST be reachable by the linter, the type checker, and the test suite. A published contract module MUST NOT escape those gates by being types-only.
- Committed tests MUST NOT contain focused or skipped cases without a documented reason.
- Biome formatting and lint, and TypeScript, MUST pass with no errors; `bun run check` MUST pass.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional requirements

[Plugin System: Published Capability Contracts](../specs/plugin-system/index.md#published-capability-contracts) owns what publication means, and [Change 0030](./0030-publish-bundled-capability-contracts.md) owns the mechanism, the boundary enforcement, and the packaging rules this change reuses without re-deciding. [Dialogs](../specs/dialogs/) and [Config](../specs/config/) own their contracts' content. Those are this change's acceptance criteria and are not restated here. What implementing them requires of this change:

- This change renames the `dialogs` and `config` keys to `@fx/tx/dialogs` and `@fx/tx/config`, each in the same commit that publishes its contract. [Change 0030](./0030-publish-bundled-capability-contracts.md) deliberately left these two bare for that reason: a key renamed ahead of its contract would name a specifier publishing nothing, which is a `tx` violating the rule its own specification states.
- The config contract MUST be reachable without the marketplace implementation graph. `plugins/marketplace/configured.ts` becomes a consumer of the published contract rather than the place the type is declared, and `requireConfigCapability` stays where it is — it is a lookup, not a contract.
- [Dialogs](../specs/dialogs/) owns what the capability's contract contains; what this change owns is which of `plugins/dialogs/types.ts`'s declarations move into the contract module and which stay behind. The provider's rendering vocabulary stays behind, so `plugins/dialogs/types.ts` keeps its `CoreDependencies` import and no consumer acquires React's element type by importing a dialogs contract.
- Publishing the dialogs contract MUST NOT change who owns the absent-capability decision. [Dialogs](../specs/dialogs/index.md) requires the consumer to own that behavior, and a published type says nothing about how many providers registered.
- Each capability's `exports` entry, `files` entries, and consumer-fixture import follow the pattern established by [Change 0030](./0030-publish-bundled-capability-contracts.md); the exact packed-file assertion in `test/plugin-consumer.test.ts` MUST be updated in the same PR as each addition.
- Bundled consumers, `demo/scenarios.ts`, and the capability tests stop declaring their own copies and import the published contracts. `plugins/dialogs/theme.ts` and `plugins/grid/dialogs.ts` are copies of another capability's vocabulary and lose their type declarations, keeping only their capability lookups.
- The dialogs and config sections of [the plugin guide](../manual/plugins.md) instruct consumers to declare the shape locally and state that it is not a public export; both MUST instead tell them to import it. The guide describes shipped behavior, so it changes with the code rather than ahead of it.
- After this change no contract type is declared in TypeScript source — `src/`, `plugins/`, `demo/`, `test/` — outside the published contract module that owns it, which is the observable this change is finished by. The living specs are deliberately excluded: [Config](../specs/config/), [Dialogs](../specs/dialogs/), [Theming](../specs/theming/), and [Grid](../specs/grid/) each state their contract as a conceptual shape, which is the specification of the contract rather than a copy of it, and none of them is a declaration an implementer may delete. Within that file set the file lists in this document are illustrative of where the declarations sit today and the search is authoritative, because two of these lists have already been found incomplete.

#### Scenario: The config contract carries no implementation

- **GIVEN** a consumer imports the published config contract
- **WHEN** the modules that import resolves are inspected
- **THEN** none of them is the marketplace manager, its storage, or its source module

#### Scenario: No capability vocabulary is declared twice

- **GIVEN** the repository's TypeScript source after this change, excluding the living specs' conceptual shapes
- **WHEN** every declaration of a capability's contract types is counted
- **THEN** each type is declared once, in the published contract module that owns it

## Design

### Approach

Two contract modules — `plugins/config/contract.ts` and `plugins/dialogs/contract.ts` — authored the way [Change 0030](./0030-publish-bundled-capability-contracts.md) authors the first two: type declarations alone, imported type-only by their own providers so each registered value is checked against the contract it publishes. Two `exports` entries, their `files` entries, two consumer-fixture imports.

The cleanup is the larger half. The sites are found by searching for the declarations rather than worked from a list, because a hand-kept list has already gone stale twice: `plugins/grid/dialogs.ts`, `plugins/dialogs/theme.ts`, `plugins/marketplace/configured.ts`, `demo/scenarios.ts`, and every test declaring a contract type — today `config-plugin`, `marketplace-plugin`, `dialogs-plugin`, `theme-plugin`, `grid-plugin`, and `grid-select`. Every one becomes an import.

### Decisions

- **Decision**: publish a subset of `plugins/dialogs/types.ts` rather than the file.
  - **Why**: the file mixes the capability's contract with the provider's rendering internals. `DialogElement` exists so the provider can name what its own render returns; a consumer that calls `select` never sees one. Publishing it would put React's element type in a consumer's build and make an internal rendering decision a breaking change.
  - **Alternatives considered**: publishing the whole file, which exports rendering internals as public API; splitting the provider's internals into a third module, which is more churn than a contract module and leaves the same split.

- **Decision**: `requireConfigCapability`, `requireThemeCapability`, and `requireDialogsCapability` stay where they are and are not published.
  - **Why**: each is a lookup with a policy baked in — exactly one provider, no fallback — and that policy belongs to the consumer, not to the contract. [Dialogs](../specs/dialogs/index.md) explicitly makes the absent-capability decision the consumer's. Publishing a helper would hand every consumer one answer to a question the specification says they own.
  - **Alternatives considered**: publishing them as a convenience, rejected because it converts a consumer-owned decision into a package-owned one and adds the runtime export this whole design refuses.

- **Decision**: land config before dialogs.
  - **Why**: config is the smaller contract and its extraction from `plugins/marketplace/configured.ts` is the sharper demonstration that publication removes a real coupling rather than adding a file.
  - **Alternatives considered**: either order works; this one puts the clearer win first.

- **Decision**: treat "no capability vocabulary declared twice in TypeScript source" as this change's completion test, with the living specs' conceptual shapes deliberately outside it.
  - **Why**: the drift this whole effort is aimed at comes from copies, and a copy left behind after the contract is published is worse than one left before it — it looks maintained. Counting declarations is something a reviewer can check and a test can assert.
  - **Alternatives considered**: leaving the test copies alone as deliberate independent restatements, rejected because a test that restates the contract stops testing that the provider matches it.

### Non-Goals

- Any runtime export, from any subpath.
- Publishing `requireConfigCapability`, `requireThemeCapability`, `requireDialogsCapability`, or any other lookup helper.
- Publishing the dialogs provider's rendering internals.
- Any change to what the dialogs or config capabilities do, to the persisted document's location or format, or to what a dialog draws.
- Revisiting the packaging mechanism, subpath naming, or boundary enforcement, all of which [Change 0030](./0030-publish-bundled-capability-contracts.md) owns.
- Changing who owns the absent-capability decision.

## Tasks

- [x] Publish the config contract
  - [x] Rename the `config` key to `@fx/tx/config` at every provider, consumer, demo, and test naming it, in the same commit that publishes the contract
  - [x] `plugins/config/contract.ts` declaring `Config` and `ConfigValidator` as types alone
  - [x] Have `plugins/config/index.ts` import it type-only and register a value checked against `Config`
  - [x] Reduce `plugins/marketplace/configured.ts` to importing the published contract, keeping `requireConfigCapability` and the marketplace's own key and value types
  - [x] `exports` entry `./config`, its `files` entries, the packed-file assertion, and the consumer-fixture import
  - [x] `test/config-plugin.test.ts` and `test/marketplace-plugin.test.ts` import the published contract; the latter declares its own `ConfigValidator` today
- [x] Publish the dialogs contract
  - [x] Rename the `dialogs` key to `@fx/tx/dialogs` at every provider, consumer, demo, and test naming it, in the same commit that publishes the contract
  - [x] `plugins/dialogs/contract.ts` declaring the request, option, field, filter, expand, and result types and `Dialogs`, as types alone
  - [x] Leave `DialogElement` and the provider's rendering types in `plugins/dialogs/types.ts`, which keeps its `CoreDependencies` import
  - [x] Have `plugins/dialogs/index.ts` import the contract type-only and register a value checked against `Dialogs`
  - [x] `exports` entry `./dialogs`, its `files` entries, the packed-file assertion, and the consumer-fixture import
  - [x] Reduce `plugins/grid/dialogs.ts` to its capability lookup, importing the published contract
- [x] Retire every remaining restated copy and update the guide
  - [x] `plugins/dialogs/theme.ts` imports the published theming contract and keeps only its lookup
  - [x] `demo/scenarios.ts` imports the published dialogs contract instead of restating it
  - [x] `test/dialogs-plugin.test.ts` and `test/demo-scenarios.test.ts` import the published contracts
  - [x] Sweep for any remaining declaration rather than trusting the lists above, and make the completion check a search whose empty result is the evidence
  - [x] Rewrite the dialogs and config sections of [the plugin guide](../manual/plugins.md) to instruct importing rather than declaring locally, and drop the "not a public export" sentences
  - [x] Assert that no capability contract type is declared in `src/`, `plugins/`, `demo/`, or `test/` outside its published contract module, leaving the specs' conceptual shapes alone

## Open Questions

- [ ] Whether `plugins/dialogs/types.ts` should keep its name once the contract has moved out of it, since what remains is the provider's rendering vocabulary rather than the capability's types. A rename is cosmetic and is deliberately not attempted here.
- [ ] Whether the marketplace plugin's own `ConfiguredMarketplace` shape and `marketplace` config key belong in a published contract too. They are a consumer's use of the config capability rather than a capability of their own, so nothing here publishes them; a second marketplace-aware plugin would be the thing that changes the answer.

## References

- Spec: [Dialogs](../specs/dialogs/), [Config](../specs/config/), [Plugin System: Published Capability Contracts](../specs/plugin-system/index.md#published-capability-contracts)
- Related changes: [0030-publish-bundled-capability-contracts](./0030-publish-bundled-capability-contracts.md), [0016-add-plugin-capabilities-and-dialogs](./0016-add-plugin-capabilities-and-dialogs.md), [0017-add-dialog-text-input-and-composition](./0017-add-dialog-text-input-and-composition.md), [0018-add-config-store-and-marketplace-installs](./0018-add-config-store-and-marketplace-installs.md)
