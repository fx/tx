# 0016: Add Plugin Capabilities and Dialogs

## Summary

Add the smallest generic runtime registry that lets plugins contribute opaque capabilities, then use it for a bundled dialogs provider whose initial surface is only a single-choice `select`. [Plugin System: Generic Registry](../specs/plugin-system/index.md#generic-registry) owns the host contract, and [Dialogs](../specs/dialogs/) owns the provider's observable behavior.

**Specs:** [Plugin System](../specs/plugin-system/), [Dialogs](../specs/dialogs/)
**Status:** complete
**Depends On:** —

## Motivation

Plugins can render terminal interfaces with the injected React, Ink, and process streams, but one plugin cannot make a reusable runtime capability available to another. The first concrete need is a dialogs provider for bundled plugins.

A dialog-specific core dependency would solve that one need by making generic core own dialog vocabulary. Direct imports between bundled plugin graphs would couple their implementations and violate the existing boundary enforcement. A generic registry preserves the neutral host while avoiding a service container larger than the one internal consumer requires.

This change deliberately stops at that concrete need. It does not design collision resolution, deduplication, provider selection, dependency injection, version negotiation, or lifecycle management.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable registry staging, snapshot, failure-isolation, terminal-input, stream-routing, selection, cancellation, cleanup, and non-interactive behavior MUST have automated tests.
- Registry tests MUST use opaque in-memory values and MUST NOT depend on duplicate-key winner semantics.
- Dialog tests MUST use injected streams or controlled terminal doubles and MUST NOT read from or write to the process-global streams.
- `test/plugin-boundary.test.ts` MUST keep passing for the new bundled plugin graph.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Plugin System: Generic Registry](../specs/plugin-system/index.md#generic-registry) owns opaque keyed registration, atomic staging, commit-time ordering, snapshot reads, and absence behavior. [Dialogs](../specs/dialogs/) owns the provider, `select`, terminal interaction, stream routing, cancellation, and cleanup. Their scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **The public plugin contract gains generic methods only.** `PluginAPI` gains a method to stage an opaque value under an opaque string key and a method to read a frozen snapshot of committed values for one key. Dialog names and types MUST NOT enter `src/` or `@fx/tx/plugin`.
- **Registry entries join the existing atomic stage.** Entries are committed or discarded with the contributing plugin's commands, children, and update participants. The host stores values without interpreting, invoking, cloning, freezing, or validating them.
- **The registry is append-only and plural.** Repeated values under one key remain distinct entries in commit order. The host adds no uniqueness, overwrite, collision, or deduplication policy.
- **The provider is a bundled plugin.** The dialogs implementation lives under `plugins/`, claims no namespace, uses only injected React, Ink, and context streams, and registers its capability under `dialogs`.
- **The initial capability stays internal.** Provider and bundled consumers use compatible local structural types. No public dialogs export, shared runtime module, or direct bundled-plugin import is added.
- **The first implementation proves consumption.** Tests exercise an internal consumer that reads the capability during a command action and drives `select`; no permanent example command or dialogs namespace is required.

## Design

### Approach

`src/plugin.ts` adds generic registry methods to the type-only `PluginAPI`. The intended minimal shape is conceptually:

```ts
register<T>(key: string, value: T): void
registrations<T>(key: string): readonly T[]
```

`src/plugins.ts` stores committed registry entries and gives each initializing plugin a local staged list. Registration is accepted only during initialization. Successful initialization appends the stage in call order; failure drops it. A read filters currently committed entries by exact key and returns a frozen snapshot, so a read during initialization sees earlier commits but not the caller's own stage or later plugins. Commands read at execution time to see every successful initialization.

The dialogs provider registers one local structural service under `dialogs`. Its `select` implementation renders through the injected terminal streams, resolves the selected opaque value or `undefined` for cancellation, and completes renderer cleanup before settling. A controlled test consumer proves that the registry crosses plugin boundaries without creating a production namespace solely for demonstration.

### Decisions

- **Decision:** Use a plural append-only keyed registry rather than singular `get` semantics.
  - **Why:** Returning all committed values avoids inventing first-wins, last-wins, overwrite, or rejection behavior. It implements the requested absence of collision and deduplication policy directly.
  - **Alternatives considered:** `provide/get` was rejected because duplicate provision necessarily gains an implicit winner. Rejecting duplicates was rejected as collision handling the current need does not require.

- **Decision:** Keep values and keys opaque to the host.
  - **Why:** Generic core needs only to stage and return values. Calling, validating, freezing, or describing them would turn the registry into a service container and create lifecycle and error contracts with no consumer.
  - **Alternatives considered:** Schemas, symbols, factories, and owner metadata were rejected as speculative public surface.

- **Decision:** Retain specialized update participation alongside the registry.
  - **Why:** Update participants have a stable public contract, provider identity, ordering, and driver-specific failure reporting already owned by the update lifecycle. Recasting them as opaque values would weaken that contract and expand this change.
  - **Alternatives considered:** Migrating update participants into the registry was rejected as unrelated churn and a regression in type and ownership information.

- **Decision:** Add a new generic registry despite Change 0012 rejecting one for updates.
  - **Why:** Change 0012 correctly preferred a typed first-class contribution for a host-wide update lifecycle. Dialogs present the different concrete requirement that change did not have: sharing a plugin-owned runtime capability without putting its domain types in generic core.
  - **Alternatives considered:** A dialog-specific core dependency and direct plugin-to-plugin imports were rejected because both break the current ownership boundary.

- **Decision:** Keep the dialogs contract internal and structural.
  - **Why:** Only bundled plugins consume it initially. Publishing a new package export would create external compatibility obligations before an external consumer exists.
  - **Alternatives considered:** Adding dialog types to `@fx/tx/plugin` was rejected as feature vocabulary in the generic contract; exporting a bundled plugin module was rejected as a new runtime package surface.

- **Decision:** Render interaction on standard error and reserve standard output for the caller.
  - **Why:** A consuming command can prompt interactively and still emit pipeable data after selection. The provider owns UI only; the caller owns results.
  - **Alternatives considered:** Rendering on standard output was rejected because it mixes prompt control sequences with command data.

- **Decision:** Clamp selection at list boundaries and use `undefined` for cancellation.
  - **Why:** Clamping is the smallest navigation policy, and `undefined` lets the caller decide whether cancellation is success, failure, or no action.
  - **Alternatives considered:** Wrapping navigation and a provider-owned cancellation error were rejected as extra policy.

### Non-Goals

- Collision detection, duplicate rejection, deduplication, overwrite or winner semantics, provider selection, or priority.
- Key factories, symbols, schemas, runtime type checks, ownership metadata, version negotiation, scopes, unregistering, replacement, subscriptions, events, disposal, health checks, lazy factories, dependency ordering, or lifecycle hooks.
- Migrating update participants or any other existing contribution into the registry.
- A public or externally stable dialogs package, type export, or runtime export.
- Any dialog beyond `select`.
- Search, filtering, text input, multi-select, disabled or grouped options, configurable defaults, custom rendering, paging, mouse input, themes, layouts, non-interactive fallback, nested dialogs, concurrent dialogs, or persistence.
- A permanent demo command or a dialogs command namespace.

## Tasks

- [x] Add the minimal generic plugin registry (PR #38)
  - [x] Extend `PluginAPI` in `src/plugin.ts` with generic registration and plural lookup methods while keeping the module types-only
  - [x] Stage, commit, discard, and snapshot opaque keyed values in `src/plugins.ts` alongside existing contributions
  - [x] Preserve exact key matching, value identity, registration order, repeated entries, frozen snapshots, and empty results without runtime value validation
  - [x] Cover root and child ordering, snapshot timing, atomic failure drop, late registration, repeated entries, namespace-free providers, and packed external type consumption in tests
  - [x] Update `docs/manual/plugins.md` with the implemented registry contract
  - [x] Verify 100% coverage and `bun run check`

- [x] Add the bundled dialogs provider after the registry lands
  - [x] Add a namespace-free provider under `plugins/dialogs/` and compose it in `cli.ts`
  - [x] Implement the local structural `Dialogs` capability with only `select`, using injected React, Ink, standard input, and standard error
  - [x] Reject empty options and non-interactive streams before rendering; preserve order, duplicates, and opaque value identity
  - [x] Implement clamped Up/Down movement, Enter selection, Escape and Ctrl-C cancellation, and complete cleanup before settlement
  - [x] Add controlled Bun tests covering rendering, streams, navigation, selection, cancellation, invalid requests, failures, cleanup, and consumption through the registry
  - [x] Keep the bundled plugin boundary and coverage gates passing
  - [x] Document the implemented provider for plugin authors without promising a public dialogs package
  - [x] Verify 100% coverage and `bun run check`

## Open Questions

None. Additional registry policy or dialog types require a concrete consumer and a later specification change.

## References

- Specs: [Plugin System](../specs/plugin-system/), [Dialogs](../specs/dialogs/), [Architecture](../specs/architecture/)
- Related changes: [0003-externalize-marketplace-plugin](./0003-externalize-marketplace-plugin.md), [0012-add-generic-update-lifecycle](./0012-add-generic-update-lifecycle.md)
- Manual: [Plugins](../manual/plugins.md)
