# 0018: Add Config Store and Marketplace Installs

## Summary

Add a bundled config plugin that lets any plugin persist a validated JSON value per user, on top of the existing generic registry, then use it to let a user seed a list of marketplaces and install every configured-but-missing one with a single explicit command. [Config](../specs/config/) owns the capability's observable behavior, and [Plugin System: Configured Marketplaces](../specs/plugin-system/index.md#configured-marketplaces) owns the marketplace plugin's use of it.

**Specs:** [Config](../specs/config/), [Plugin System](../specs/plugin-system/)
**Status:** draft
**Depends On:** —

## Motivation

Plugins can already own their own mutable state and resolve their own data paths, but nothing shared lets a plugin persist a small JSON value with any assurance that what it reads back still matches the shape it expects. Every plugin that wants durable state has to invent its own file, its own format, and its own defense against a corrupt or foreign value. The concrete need driving this change is the marketplace plugin: a user who manages several marketplaces across machines wants to write down the list once and install all of them, rather than typing `marketplace add` for each.

The generic registry deliberately excludes persistence and runtime validation from its own contract (see [Plugin System: Generic Registry](../specs/plugin-system/index.md#generic-registry)), so this change does not reopen that. It adds a second concrete capability on top of the registry, following the same shape [Change 0016](./0016-add-plugin-capabilities-and-dialogs.md) used for dialogs: a bundled provider registers an opaque value, and consumers depend on a small structural contract rather than the provider's implementation.

This change deliberately stops at that concrete need. It does not add a `tx config` command, a schema description language, cross-process locking, or automatic installation of configured marketplaces outside an explicit command.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable config definition, read, write, persistence, atomicity, corruption-handling, and marketplace-install behavior MUST have automated tests.
- Config store tests MUST use an injected or temporary directory and MUST NOT read or write the real user data directory.
- `test/plugin-boundary.test.ts` MUST keep passing for the new bundled plugin graph.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Config](../specs/config/) owns the capability's registration, key definition, read/write behavior, persistence, and atomicity, and [Plugin System: Configured Marketplaces](../specs/plugin-system/index.md#configured-marketplaces) owns the marketplace plugin's persisted list, its write-back from `marketplace add`/`marketplace remove`, and `marketplace install`. Their scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **The public plugin contract is unchanged.** The config capability is a local structural type consumed through the existing `register`/`registrations` methods on `PluginAPI`; no config vocabulary enters `src/` or `@fx/tx/plugin`.
- **The provider is a new bundled plugin.** The config implementation lives under `plugins/config/`, claims no namespace, and registers its capability under `config`.
- **The provider resolves its own data directory independently.** It does not import the marketplace plugin's existing data-directory resolution, and the marketplace plugin's own storage is unchanged; each bundled plugin's module graph stays self-contained.
- **The marketplace plugin becomes a config consumer without a new dependency between bundled plugins.** It obtains the `config` capability through the registry inside its own command actions, not through a direct import of `plugins/config/`.
- **`marketplace add` and `marketplace remove` write back.** After a successful install, `add` upserts the resolved `{ source, name }` entry into the persisted list; after a successful removal, `remove` deletes the matching entry if present.
- **A new `marketplace install` command reads the persisted list and installs what is missing.** It reuses the existing add path for each configured entry not currently installed, and an already-installed entry is left untouched. One entry's failure MUST NOT stop the rest from being attempted.
- **Composition adds the new plugin.** `cli.ts` composes the config plugin alongside the existing default plugins; because every consumer reads the capability during its own command action rather than during another plugin's initialization, the new plugin's position in that list does not affect correctness.

## Design

### Approach

`plugins/config/` gets its own `storage.ts` resolving a per-user data directory the same way `plugins/marketplace/storage.ts` already does (platform-specific: XDG data home or `~/.local/share` on Linux, `~/Library/Application Support` on macOS, `%LOCALAPPDATA%`/`%APPDATA%` on Windows), pointed at its own `config.json` rather than the marketplace directory. A `read`/`write` pair loads and parses that document, and a write serializes the whole document and replaces it atomically by writing to a temporary file in the same directory and renaming it into place, mirroring the stage-then-`rename` pattern `MarketplaceManager` already uses for a cloned checkout.

The registered `Config` value keeps an in-memory `Map` from key to type guard, populated by `define` and consulted by `read` and `write`. `define` throws when a key is already present in that map; `read`/`write` throw when a key is absent from it. `read` parses the persisted document, looks up the requested key, and either returns `undefined` (key absent from the document), the value (guard accepts it), or throws (guard rejects it). `write` validates the incoming value against the key's guard before touching the document, then merges the new value for that key into a freshly-read copy of the whole document before the atomic replace, so a `write` for one key does not require every other consumer to have written first and cannot drop a value a concurrent process is not itself touching.

The marketplace plugin's `add`, `remove`, and new `install` command actions each obtain the `config` capability, `define("marketplace", isMarketplaceEntryList)`, and then read or write that key. `install` reads the persisted list, and for each entry not returned by `discoverInstalledMarketplaces`, calls the same internal path `add` uses, tolerating an "already installed" outcome as a no-op so a race between the check and the install is harmless; a failure for one entry is caught, reported, and does not stop the remaining entries.

### Decisions

- **Decision:** Build the config capability as a second registry-backed bundled plugin rather than extending the generic registry itself.
  - **Why:** [Change 0016](./0016-add-plugin-capabilities-and-dialogs.md) already decided persistence, schemas, and runtime validation stay out of the host's own registry contract; a second capability on top of it is the same shape that already worked for dialogs.
  - **Alternatives considered:** Adding `read`/`write` methods directly to `PluginAPI` was rejected as putting a feature-specific, stateful, filesystem-owning contract into generic core. Extending the registry's own rules to support validation was rejected as reopening a settled decision for one consumer.

- **Decision:** Require an explicit `define` call per key, with a type-guard function, before `read` or `write` will accept that key.
  - **Why:** A predicate function needs no new dependency and matches the codebase's existing preference for plain structural contracts over a schema description language. Requiring definition first means a corrupt or foreign value under a key is caught by the same guard every time that key is used, rather than trusted by some call sites and checked by others.
  - **Alternatives considered:** Passing a validator on every `read`/`write` call, with no separate `define` step, was rejected because it does not match a "registered type" for a key — two call sites could pass different guards for the same key with no way to notice. A schema object or library dependency was rejected as more machinery than a plain predicate requires.

- **Decision:** Scope `define`'s single-definition rule to one key within one process, not across the persisted document's history.
  - **Why:** A `tx` invocation dispatches exactly one command action, so a plugin's own commands never contend for the same key's definition; the rule exists to catch two different plugins colliding on the same key, and a per-process map is the simplest thing that catches that.
  - **Alternatives considered:** Persisting the guard or a schema description alongside the value was rejected as far more machinery than the concrete need justifies, and as coupling the store to a serializable schema format.

- **Decision:** `marketplace install` is a new explicit command; installing configured-but-missing marketplaces never happens as a side effect of plugin initialization or of an unrelated command.
  - **Why:** [Updates: Never Automatic](../specs/updates/index.md#never-automatic) already commits this project to never performing update-shaped network operations without an explicit invocation. Installing a marketplace clones a Git repository, which is exactly that shape of operation, and doing it implicitly on every invocation would silently retry a broken clone on every `tx` command a user runs.
  - **Alternatives considered:** Installing configured marketplaces during the marketplace plugin's own initialization, before any command runs, was rejected for the reason above, and would also have forced an ordering dependency between the config and marketplace plugins that reading during a command action avoids entirely.

- **Decision:** `marketplace add` and `marketplace remove` write back to the persisted list.
  - **Why:** Without write-back, a marketplace installed or removed directly would silently drift from the seeded list, and a later `marketplace install` could reinstall something a user deliberately removed. Keeping the two in sync means the persisted list always reflects the last-known-desired set.
  - **Alternatives considered:** Treating the persisted list as a write-once seed file that `tx` never updates was rejected because it lets `marketplace install` resurrect a marketplace the user explicitly removed.

- **Decision:** One JSON document holds every plugin's keys, replaced whole on each write.
  - **Why:** A single small file keeps the store's persistence and atomicity story simple: one atomic replace covers every key, and there is exactly one place to look for what is persisted.
  - **Alternatives considered:** One file per key was rejected as more filesystem surface than the concrete need (a handful of small values) justifies, and would have complicated the atomicity guarantee across keys written together.

### Non-Goals

- A `tx config` command for end users to inspect or edit persisted keys.
- A schema description language, validation library dependency, or anything beyond a plain type-guard function.
- Migration or versioning of a persisted shape between versions of a plugin.
- Cross-process locking, transactions spanning more than one `write` call, or mutual exclusion between concurrent `tx` invocations.
- Deleting a single key without writing a replacement value, or listing every persisted key.
- Automatic installation of configured marketplaces outside the explicit `marketplace install` command.
- The future plugin that would collect input through dialogs text input and persist it here; this change keeps the key and value shape generic enough for that without designing it.

## Tasks

- [ ] Add the config capability (PR #1)
  - [ ] Add `plugins/config/storage.ts` resolving a platform-appropriate per-user data directory and its `config.json` path
  - [ ] Add `plugins/config/index.ts` implementing `define`/`read`/`write` over an atomically-replaced JSON document, registered under `config` with no command namespace
  - [ ] Preserve exact key matching, per-process single-definition enforcement, guard-checked reads and writes, absence returning `undefined`, and document-corruption rejection
  - [ ] Cover define-before-use, duplicate definition, read/write round trips, guard rejection on read and on write, first-write document creation, corrupt-document rejection, and concurrent-write non-corruption in tests
  - [ ] Compose the config plugin in `cli.ts`
  - [ ] Update `docs/manual/plugins.md` with the implemented config contract
  - [ ] Verify 100% coverage and `bun run check`

- [ ] Consume the config capability in the marketplace plugin (PR #2)
  - [ ] Define the `marketplace` config key with a type guard for an ordered list of `{ source, name }` entries
  - [ ] Write back the resolved entry from `marketplace add` and delete the matching entry in `marketplace remove`
  - [ ] Add `marketplace install`, installing every persisted entry not currently installed and leaving already-installed entries unchanged
  - [ ] Ensure one entry's install failure is reported without stopping the remaining entries
  - [ ] Cover write-back on add and remove, install of missing entries, no-op on already-installed entries, and per-entry failure isolation in tests
  - [ ] Update `docs/manual/plugins.md` and any `marketplace` command help text for the new command
  - [ ] Verify 100% coverage and `bun run check`

## Open Questions

None. A `tx config` command, key deletion, and schema migration require a concrete consumer and a later specification change.

## References

- Specs: [Config](../specs/config/), [Plugin System](../specs/plugin-system/), [Updates](../specs/updates/), [Architecture](../specs/architecture/)
- Related changes: [0016-add-plugin-capabilities-and-dialogs](./0016-add-plugin-capabilities-and-dialogs.md), [0008-link-local-marketplace-sources](./0008-link-local-marketplace-sources.md)
- Manual: [Plugins](../manual/plugins.md)
</content>
