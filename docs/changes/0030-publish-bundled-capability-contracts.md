# 0030: Publish Bundled Capability Contracts

## Summary

Establish how `tx` publishes a bundled capability's structural contract, make a capability's registry key the specifier that contract is published at, and publish the first two: theming and the grid. A consumer stops restating the shape it reads from the registry and imports it instead, so a contract that moves breaks the consumer's build rather than its command.

**Spec:** [Plugin System](../specs/plugin-system/), [Theming](../specs/theming/), [Grid](../specs/grid/)
**Status:** draft
**Depends On:** —

## Motivation

An external plugin that consumes the grid capability today cannot import its type, because nothing publishes it. What it does instead is declare the shape locally and read `registrations<Grid>("grid")` against that declaration. Both halves work: the registry returns the real value, and structural typing accepts the copy.

That is exactly what makes it dangerous. The generic type asserted at a registry read is a caller-side assertion the host never checks, so a copy that has drifted from the provider still compiles. The consumer learns about the drift when a command reaches for a member that is no longer there — at run time, in the user's terminal, one release after the change that caused it.

The copying is not an oversight. [Change 0016](./0016-add-plugin-capabilities-and-dialogs.md) decided it deliberately: "Only bundled plugins consume it initially. Publishing a new package export would create external compatibility obligations before an external consumer exists." Every capability since has followed that decision, and [Dialogs](../specs/dialogs/) recorded the condition that would reverse it — "a public dialogs type export MAY be considered when an external plugin needs one." That condition is now met, and it was met by a consumer that shipped a copy rather than waiting.

There is a second problem publication would otherwise entrench. The registry is one flat namespace of opaque strings compared by exact equality, with nothing reserved, and the bundled capabilities have taken `"grid"`, `"theme"`, `"dialogs"`, and `"config"` — four of the most collidable words an ecosystem could offer. A third-party plugin providing its own grid cannot avoid landing in the same snapshot as `tx`'s, and a consumer reading that key gets both with no winner and an unchecked assertion over them. Publishing the contracts without fixing this would freeze those names as public API.

The cost is already visible inside the repository, before any external consumer is counted. The theming vocabulary exists three times — in `plugins/theme/index.ts` where the provider declares it unexported, in `plugins/grid/theme.ts`, and in `plugins/dialogs/theme.ts` — and the demo and the capability tests each carry a fourth and fifth. Nothing checks that any of them agree.

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

[Plugin System: Published Capability Contracts](../specs/plugin-system/index.md#published-capability-contracts) owns what publication means — the key-is-the-specifier rule, the types-only rule, the closure over published files, the breaking-change status, and the boundary rules — together with its scenarios. [Theming](../specs/theming/) and [Grid](../specs/grid/) own their own contracts' content. Those are this change's acceptance criteria and are not restated here. What implementing them requires of this change:

- Every registry key a bundled plugin uses becomes the specifier its contract is published at: `"@fx/tx/theme"`, `"@fx/tx/dialogs"`, `"@fx/tx/grid"`, `"@fx/tx/config"`, and `"@fx/tx/theme-override"` replace the bare words in use today. Providers, consumers, the demo, and every test that names a key change together.
- The rename is a breaking change to anything reading a bundled capability, and is accepted as one. No alias, dual registration, or deprecation period is provided: registering under both spellings would put two entries in one snapshot and hand every consumer the ambiguity the rename exists to remove.
- `@fx/tx/theme-override` gets a published subpath of its own like every other key, carrying the shape of the value registered under it. It is not a capability, which changes nothing about the rule: the rule is about keys, and every key names the type of what is registered under it.
- Each published capability gets a contract module of its own holding type declarations alone. The existing type-bearing files cannot be published as they stand: `plugins/grid/theme.ts`, `plugins/theme/variables.ts`, and `plugins/theme/colour.ts` all carry executable code beside their types, and the package publishes no runtime condition for anything.
- The theme contract MUST be authored rather than extracted. `ThemeVariable` in `plugins/theme/variables.ts` is derived from a runtime value as `keyof typeof defaultAppearances`, and `Theme`, `Theming`, and `ThemeOverride` are declared file-locally in `plugins/theme/index.ts` and exported from nowhere. The derivation inverts: the contract declares the variable union, and the default appearance table is typed against it, so a variable added to one without the other fails to compile.
- The grid contract takes `ThemeVariable` from the published theme contract rather than restating it, which deletes `plugins/grid/theme.ts`'s copy of the theme vocabulary.
- The `exports` map gains one entry per published capability, carrying a `types` condition and no runtime condition, so `test/plugins.test.ts`'s existing proof that the public contract cannot be imported at run time extends to every new subpath.
- `files` grows to the transitive closure of every published contract module. `test/plugin-consumer.test.ts` asserts the packed file list exactly and MUST be updated in the same PR; a subpath whose types reach a file outside `files` resolves in the repository and fails against the installed package, which is the one failure mode the repository's own type check cannot see.
- **Boundary enforcement MUST be extended before the first subpath exists.** `test/plugin-boundary.test.ts` keys its type-only, no-runtime-load rules on the literal specifier `"@fx/tx/plugin"`, and its escape rule and its `src/` rule both inspect only specifiers beginning with `.`. A bare `@fx/tx/<capability>` specifier is therefore invisible to every check in that file: publishing the subpaths without extending it would make cross-plugin coupling and `src/`-to-capability coupling expressible for the first time, silently. Every published subpath MUST be held to what `@fx/tx/plugin` is already held to.
- The consumer fixture in `test/plugin-consumer.test.ts` MUST import every published subpath and type check it against the installed tarball, because that fixture is the only place the `exports` map is exercised end to end.
- Bundled consumers, `demo/scenarios.ts`, and the capability tests stop declaring their own copies and import the published contracts.
- The four capability sections of [the plugin guide](../manual/plugins.md) instruct consumers to declare the shape locally; the two this change publishes MUST instead tell them to import it. The guide describes shipped behavior, so it changes with the code rather than ahead of it.

#### Scenario: The key and the specifier are one string

- **GIVEN** a consumer that imports a bundled capability's contract and reads that capability from the registry
- **WHEN** the import specifier and the key passed to the read are compared
- **THEN** they are the same string, and no other string identifies that capability

#### Scenario: A published subpath ships nothing to run

- **GIVEN** the packed package
- **WHEN** every file a published capability subpath resolves to is inspected
- **THEN** each contains type declarations alone and the package declares no runtime condition for that subpath

#### Scenario: Boundary enforcement sees a published subpath

- **GIVEN** a module loads a published capability subpath at run time, imports it as a value, or imports it from under `src/`
- **WHEN** the boundary checks run
- **THEN** each of those is reported as a violation, exactly as it is for `@fx/tx/plugin`

#### Scenario: A published subpath resolves from the installed package

- **GIVEN** the packed package installed into a consumer with no repository checkout present
- **WHEN** the consumer type checks an import of each published capability subpath
- **THEN** each resolves against published files alone

## Design

### Approach

One contract module per capability at `plugins/<name>/`, containing `export type` declarations and nothing else, imported type-only by its own provider so the value the provider registers is checked against the contract it publishes. `package.json` gains a types-only `exports` entry per capability and the matching `files` entries. `test/plugin-boundary.test.ts` generalizes its `@fx/tx/plugin` rules over the published subpath set.

Theming lands first because the grid contract depends on its vocabulary; the grid then demonstrates the cross-contract import that makes the whole arrangement worth having.

### Decisions

- **Decision**: a capability's registry key becomes the specifier its contract is published at — the key is `"@fx/tx/theme"`, imported from `@fx/tx/theme` — replacing the bare `"theme"`, `"dialogs"`, `"grid"`, `"config"`, and `"theme-override"` keys.
  - **Why**: one string instead of two that have to be kept agreeing. A consumer cannot import one capability's contract while reading another's key, because there is only one string to get wrong. It is also the only form of the rule that survives a plugin shipped outside `tx`: "the subpath is the key" silently means "`@fx/tx/` plus the key", and that prefix is not something another package can follow. Keys then inherit the package namespace, where a name already has one owner, so unrelated providers cannot collide without the host reserving or parsing anything.
  - **Why now**: the keys are internal today. Once this change publishes the contracts, the key strings are public API beside them and changing one breaks every consumer rather than the few in this repository. This is the last point at which the rename is cheap.
  - **Alternatives considered**: keeping the bare keys and stating the subpath rule as `@fx/tx/` plus the key, which does not generalize and leaves `tx` holding the four most collidable names in the ecosystem — a third-party plugin providing its own grid could not avoid landing in the same snapshot; a single `@fx/tx/capabilities` barrel, which would hand every consumer every capability's vocabulary and make one capability's change a rebuild for all of them; a `@fx/tx/plugin` re-export, which is the feature vocabulary in the generic contract that [Change 0016](./0016-add-plugin-capabilities-and-dialogs.md) rejected and this change does not revisit.

- **Decision**: publish types alone, with no runtime condition on any subpath.
  - **Why**: the capability's value comes from the registry and must keep coming from there. A runtime export would be a second way to obtain it — one that bypasses composition, gives a consumer a value the host never committed, and turns a bundled plugin's module graph into a package surface. It would also break the guarantee `test/plugins.test.ts` already pins for `@fx/tx/plugin`.
  - **Alternatives considered**: exporting the provider module, rejected in [Change 0016](./0016-add-plugin-capabilities-and-dialogs.md) for the same reason and rejected again here.

- **Decision**: a dedicated contract module per capability rather than pointing the `types` condition at the files that hold these types today.
  - **Why**: three separate reasons converge on it. The existing files carry runtime code, which a types-only package should not ship. The theme's `Theme` and `Theming` are unexported file-locals inside the provider, whose module also imports `@fx/tx/plugin` and two runtime modules. And a contract module with no imports and no statements is trivially checkable as types-only, which is what lets the boundary test enforce the rule mechanically rather than by review.
  - **Alternatives considered**: publishing `plugins/grid/types.ts` as it stands, which drags `plugins/grid/theme.ts` and its `requireThemeCapability` into the package; publishing the provider's `index.ts`, which drags the whole implementation graph.

- **Decision**: the grid contract imports the theme contract through `@fx/tx/theme`, not through a relative path.
  - **Why**: a relative import into `../theme/` is precisely the escape `test/plugin-boundary.test.ts` exists to forbid, and forbidding it is right — it is what stops two bundled plugins sharing a runtime module graph. The published path shares no runtime graph at all, because it is erased. It is also the mechanism `@fx/tx/plugin` already uses between the same two directories.
  - **Alternatives considered**: keeping each contract self-contained and adding a test that the duplicate declarations stay mutually assignable, which keeps the copies and only makes their drift loud; lifting the shared vocabulary into `src/`, which is theme vocabulary in core.

- **Decision**: extend the boundary test in the same PR that adds the first subpath.
  - **Why**: the gap is not hypothetical. Both of that file's structural rules test `specifier.startsWith(".")`, and its type-only rules compare against one literal string, so the first published subpath is invisible to all of them the moment it exists. Landing the export first would remove an enforced guarantee and leave nothing red to say so.
  - **Alternatives considered**: a follow-up change, rejected because the window between them is exactly when a `src/`-to-capability import would be merged unnoticed.

- **Decision**: publish raw TypeScript as the `types` target, as `./plugin` already does.
  - **Why**: consistency with the one convention the package already has, and the consumer fixture already proves it works. Introducing emitted declarations for four subpaths while the fifth stays raw would mean two publication mechanisms and a build step this repository does not otherwise need.
  - **Alternatives considered**: emitting `.d.ts` files, which is the more conventional answer and remains available if the raw-source approach ever bites; it is recorded as an open question rather than adopted here.

### Non-Goals

- Publishing the dialogs and config contracts. [Change 0031](./0031-publish-the-dialogs-and-config-contracts.md) does that over the mechanism this change establishes.
- Any runtime export, from any subpath.
- A capability package versioned separately from `tx`.
- Any change to the registry contract or mechanism. The keys change; what a key *is* does not. It stays an opaque string compared by exact equality, and the host gains no schemas, runtime validation, key-to-type relationship, key parsing, namespace reservation, or provider selection. Publishing a contract makes the consumer's assertion checkable against a written shape; it does not make the host check anything.
- Any change to what the theming or grid capabilities do. Only where their contracts live changes.
- Changing the appearance, layout, or behavior of anything drawn.

## Tasks

- [ ] Rename every bundled registry key to its published specifier
  - [ ] `@fx/tx/theme`, `@fx/tx/theme-override`, `@fx/tx/dialogs`, `@fx/tx/grid`, and `@fx/tx/config` at every provider, consumer, demo, and test that names one
  - [ ] Confirm no bare key survives, including in the capability lookups and in `plugins/marketplace/configured.ts`
- [ ] Establish the publication mechanism and publish the theming contract
  - [ ] `plugins/theme/contract.ts` declaring `Hue`, `Appearance`, `ThemeVariable`, `Theme`, `Theming`, and `ThemeOverride` as types alone
  - [ ] Invert the derivation in `plugins/theme/variables.ts` so the default appearance table is typed against the contract's variable union
  - [ ] Have `plugins/theme/index.ts` import the contract type-only and register a value checked against `Theming`
  - [ ] `exports` entry `./theme` with a `types` condition and no runtime condition, plus its `files` entries
  - [ ] Extend `test/plugin-boundary.test.ts` so every published subpath is type-only, never loaded at runtime, and never imported from `src/`, with fixture cases for each new violation
  - [ ] Update the exact packed-file assertion in `test/plugin-consumer.test.ts` and extend its consumer fixture to import and type check `@fx/tx/theme`
  - [ ] Assert the published contract modules contain no runtime code
- [ ] Publish the grid contract over the theming contract
  - [ ] `plugins/grid/contract.ts` taking `ThemeVariable` from `@fx/tx/theme` and declaring the grid vocabulary as types alone
  - [ ] Delete the theme vocabulary copied into `plugins/grid/theme.ts`, leaving it the capability lookup alone
  - [ ] `exports` entry `./grid`, its `files` entries, and the consumer fixture import
- [ ] Move consumers and documentation off the restated copies
  - [ ] `demo/scenarios.ts` imports the published grid and theme contracts instead of restating them
  - [ ] `test/grid-plugin.test.ts`, `test/grid-select.test.ts`, and `test/theme-plugin.test.ts` import the published contracts
  - [ ] Rewrite the theming and grid sections of [the plugin guide](../manual/plugins.md) to instruct importing rather than declaring locally, and drop the "not a public export" sentences
  - [ ] Document the consumer-side TypeScript settings a raw-`.ts` `types` target requires, which the fixture proves but no document currently states

## Open Questions

- [ ] Whether the published contracts should eventually be emitted `.d.ts` files rather than raw TypeScript. Raw source is what `./plugin` already publishes and what the consumer fixture proves, so this change follows it; the cost is that every consumer needs `moduleResolution` set to a mode that reads an `exports` map and needs `allowImportingTsExtensions`, which is a requirement no document states today. This change adds that documentation; whether to remove the requirement altogether is separate and affects `./plugin` equally.
- [ ] Whether a consumer should be able to import a capability's contract without the package's `react`, `ink`, and `commander` dependencies being resolvable. The theming and grid contracts need none of them, but `@fx/tx/plugin` does, so a consumer importing only `@fx/tx/grid` still installs them today. It is not a problem this change creates and not one it fixes.
- [ ] Whether the boundary test should also forbid a bundled plugin importing another capability's *published* contract when it does not consume that capability, rather than only forbidding relative escapes. The grid legitimately imports `@fx/tx/theme`; nothing would currently stop it importing `@fx/tx/config` for no reason.

## References

- Spec: [Plugin System: Published Capability Contracts](../specs/plugin-system/index.md#published-capability-contracts), [Theming](../specs/theming/), [Grid](../specs/grid/)
- Related changes: [0016-add-plugin-capabilities-and-dialogs](./0016-add-plugin-capabilities-and-dialogs.md) (records the decision this change reverses), [0026-add-theme-variables](./0026-add-theme-variables.md), [0028-add-the-grid-plugin](./0028-add-the-grid-plugin.md), [0029-add-interactive-grid-row-actions](./0029-add-interactive-grid-row-actions.md), [0031-publish-the-dialogs-and-config-contracts](./0031-publish-the-dialogs-and-config-contracts.md)
