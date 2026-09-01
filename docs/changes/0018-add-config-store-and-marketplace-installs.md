# 0018: Add Config Store and Marketplace Installs

## Summary

Add a bundled config plugin that lets any plugin persist a validated JSON value per user, on top of the existing generic registry, then use it to let a user seed a list of marketplaces and install every configured-but-missing one with a single explicit command. [Config](../specs/config/) owns the capability's observable behavior, and [Plugin System: Configured Marketplaces](../specs/plugin-system/index.md#configured-marketplaces) owns the marketplace plugin's use of it.

**Specs:** [Config](../specs/config/), [Plugin System](../specs/plugin-system/)
**Status:** complete
**Depends On:** 0016

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

`plugins/config/` gets its own `storage.ts` resolving a per-user data directory the same way `plugins/marketplace/storage.ts` already does (platform-specific: XDG data home or `~/.local/share` on Linux, `~/Library/Application Support` on macOS, `%LOCALAPPDATA%`/`%APPDATA%` falling back to `~/AppData/Local` on Windows), pointed at its own `config.json` rather than the marketplace directory. This path is documented, not merely internal, so a user can find and hand-edit the file directly. A `read`/`write` pair loads and parses that document, rejecting it unless its top level is a JSON object, and a write serializes the whole document and replaces it atomically by writing to a temporary file in the same directory and renaming it into place, mirroring the stage-then-`rename` pattern `MarketplaceManager` already uses for a cloned checkout.

The registered `Config` value keeps an in-memory `Map` from key to type guard, populated by `define` and consulted by `read` and `write`. `define` throws when a key is already present in that map; `read`/`write` throw when a key is absent from it. `read` parses the persisted document, looks up the requested key, and either returns `undefined` (key absent from the document), the value (guard accepts it), or throws (guard rejects it). `write` validates the incoming value against the key's guard before touching the document, then merges the new value for that key into a freshly-read copy of the whole document before the atomic replace, so a `write` for one key does not require every other consumer to have written first. That merge only narrows the race, it does not close it: two processes writing different keys at nearly the same moment can each read the same prior document, merge their own key into their own copy, and atomically replace the file in turn, so the later replace's document is exactly what [Config: Storage and Persistence](../specs/config/index.md#storage-and-persistence) already says to expect — the earlier writer's key is silently gone, not merely stale. Nothing in this change closes that window; a consumer that cannot tolerate losing a concurrent write needs a mechanism this store does not provide.

The marketplace plugin's `add`, `remove`, and new `install` command actions each obtain the `config` capability, `define("marketplace", isMarketplaceEntryList)`, and then read or write that key, where `isMarketplaceEntryList` validates the JSON shape and rejects a list containing two entries with the same explicit `name`. Both `add`'s upsert and `remove`'s delete locate the existing entry to replace or remove by resolved name — an entry's explicit `name`, or, when it has none, the same derivation `manager.ts` uses for a name-less source — never by comparing the literal `name` property alone; otherwise a hand-seeded, name-less entry could survive a `marketplace remove` that was supposed to delete it, and `marketplace install` would reinstall it later. `add` writes back the resolved name paired with a recorded source that depends on which kind of source it resolved: for a Git source, `credentialFreeSource(repository)` — the same function `manager.ts` already uses to build a failure's label — so a source carrying HTTP(S) userinfo never reaches the persisted document; for a local source, the same fully resolved real path `#reference` already records the live reference against, never the path as the user typed it, so a relative path cannot later resolve against a different working directory into different, untrusted code. If a recorded source carries a version-pin suffix once [Change 0014](./0014-pin-marketplace-versions.md) is implemented, it is written back exactly as resolved, so the pin travels with the source rather than needing separate storage.

`install` reads the persisted list and, before installing anything, resolves every entry's name using the same derivation `manager.ts`'s `add` already uses internally for an entry with no explicit name, then rejects the whole list — naming the collision, installing nothing — if two entries resolve to the same name. This name-resolution pass is `install`'s own responsibility, not the type guard's: deriving a name requires the same source classification `manager.ts` performs, which is not something a pure shape-validating guard should do. Past that check, for each entry not returned by `discoverInstalledMarketplaces`, `install` calls the same internal path `add` uses, tolerating an "already installed" outcome as a no-op so a race between the check and the install is harmless; a failure for one entry is caught, reported, and does not stop the remaining entries.

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

- **Decision:** Document the config file's exact location and require its top level to be a JSON object, rather than treating both as an internal implementation detail.
  - **Why:** The concrete marketplace use case requires a user to be able to seed the configured-marketplace list before ever running `tx`. Without a fixed, documented location and a guaranteed object root, there is no way for a user or an external tool to write that seed, and `write`'s key-scoped merge has no defined behavior for a document whose root is not an object.
  - **Alternatives considered:** Keeping the path undocumented and adding a `tx config` command as the only way to populate it was rejected as exactly the CLI-surface expansion [Change 0016](./0016-add-plugin-capabilities-and-dialogs.md)'s minimalism and this change's own Non-Goals deliberately avoid; a hand-editable file needs no new command.

- **Decision:** `marketplace add` records a local source's fully resolved real path in the persisted list, never the path as the user typed it.
  - **Why:** [Local Marketplace Sources](../specs/plugin-system/index.md#local-marketplace-sources) already requires a live reference to be recorded against its fully resolved real path specifically so a later working-directory change cannot redirect it. Recording the raw, possibly relative, path in the persisted list instead would reopen exactly that hole for `marketplace install`: run from a different directory, or after the original checkout moved, it could resolve the recorded path to a different directory and load whatever trusted marketplace code happens to live there.
  - **Alternatives considered:** Recording the source exactly as given, uniformly for Git and local sources, was rejected once it was clear a local source's relative path has no meaning independent of the directory a command happens to run from — unlike a Git source, which is a fixed address regardless of where `tx` runs.

- **Decision:** `marketplace add` records a credential-free form of the source in the persisted list, never the source as given.
  - **Why:** The persisted list is explicitly meant to be portable and hand-seedable, which means copied between machines and potentially committed to a dotfiles repository. Writing a raw HTTP(S) source containing a token or password into it would create a new durable plaintext copy of that credential outside the protections `manager.ts` already applies to every reported failure and listing.
  - **Alternatives considered:** Persisting the source exactly as given was rejected as a credential leak. Rejecting `marketplace add` outright for a credential-bearing source was rejected as breaking a currently-supported installation method for no benefit, when redacting only the persisted copy achieves the same protection `marketplace list` already relies on.

- **Decision:** `marketplace install` rejects a persisted list containing two entries that resolve to the same name — whether both name it explicitly or one or both leave `name` out and derive a colliding one — installing nothing from it, rather than installing only the first match.
  - **Why:** Write-back from `marketplace add` cannot itself create an explicit-name collision, since it replaces the existing same-named entry, but nothing stops two hand-seeded entries with no explicit name from deriving the same one — for example two different repositories that both happen to be named `notes`. Checking only explicit names would silently miss that case and install only the first, satisfying "every configured marketplace" in name only.
  - **Alternatives considered:** Checking only explicit-name duplicates was rejected as covering just the collision write-back already prevents and missing the one write-back cannot. Silently installing the first and skipping the second as "already installed" was rejected as indistinguishable, from the user's side, between an intentional single marketplace and a mistake in a hand-edited file.

- **Decision:** A configured entry's recorded source preserves a version-pin suffix once pins exist, and `marketplace install` is required to honor it, even though [Change 0014](./0014-pin-marketplace-versions.md) is still draft and unimplemented.
  - **Why:** This change's own requirement that a configured install become "subject to every other marketplace requirement... exactly as one added directly through `marketplace add`" already covers pins once they exist; stating that explicitly now, while the persisted entry shape is being designed, avoids a future implementer of Change 0014 discovering only after shipping pins that configured installs silently ignore them.
  - **Alternatives considered:** Leaving pin interaction as an open question until Change 0014 lands was rejected because the persisted entry shape decided in this change determines whether a pin has anywhere to live at all; deciding it later could force a breaking change to entries already written by earlier `marketplace add` runs.

- **Decision:** `add` and `remove` match an existing persisted entry by resolved name (explicit, or derived when absent), never by comparing the literal `name` property.
  - **Why:** A hand-seeded entry carrying only `source` has no explicit `name` to compare against. Matching only the literal property would let `remove` leave such an entry behind after deleting the marketplace it named, and the desired-set invariant this whole feature exists to keep — write-back always reflecting what a user actually wants installed — breaks the moment `marketplace install` reinstalls something the user just removed.
  - **Alternatives considered:** Requiring an explicit `name` on every persisted entry, so literal comparison would always work, was rejected as pushing an internal implementation convenience onto the hand-seeding workflow this change exists to support; a user seeding a list by source alone is exactly the case this change intends to work.

### Non-Goals

- A `tx config` command for end users to inspect or edit persisted keys; end-user access is by hand-editing the documented file directly.
- A schema description language, validation library dependency, or anything beyond a plain type-guard function.
- Migration or versioning of a persisted shape between versions of a plugin.
- Cross-process locking, transactions spanning more than one `write` call, or mutual exclusion between concurrent `tx` invocations.
- Deleting a single key without writing a replacement value, or listing every persisted key.
- Automatic installation of configured marketplaces outside the explicit `marketplace install` command.
- The future plugin that would collect input through dialogs text input and persist it here; this change keeps the key and value shape generic enough for that without designing it.

## Tasks

- [x] Add the config capability
  - [x] Add `plugins/config/storage.ts` resolving a platform-appropriate per-user data directory and its `config.json` path, documented as a fixed, hand-editable location
  - [x] Add `plugins/config/index.ts` implementing `define`/`read`/`write` over an atomically-replaced JSON document, registered under `config` with no command namespace
  - [x] Preserve exact key matching, per-process single-definition enforcement, guard-checked reads and writes, absence returning `undefined`, and document-corruption and non-object-root rejection
  - [x] Cover define-before-use, duplicate definition, read/write round trips, guard rejection on read and on write, first-write document creation, corrupt-document rejection, non-object document root rejection, and concurrent-write non-corruption in tests
  - [x] Compose the config plugin in `cli.ts`
  - [x] Update `docs/manual/plugins.md` with the implemented config contract
  - [x] Verify 100% coverage and `bun run check`

- [x] Consume the config capability in the marketplace plugin
  - [x] Define the `marketplace` config key with a type guard for an ordered list of `{ source, name }` entries that rejects a list containing two entries with the same explicit name
  - [x] Write back the resolved name from `marketplace add`, with a credential-free source for a Git source (preserving a version-pin suffix once Change 0014 adds one) or the fully resolved real path for a local source, replacing any existing entry whose name — explicit or derived — matches; delete the same way in `marketplace remove`, deriving a name-less entry's name rather than comparing only the literal property
  - [x] Report a write-back failure separately from, and without undoing, the install or removal that already succeeded
  - [x] Add `marketplace install`: resolve every entry's name (explicit, or derived exactly as `add` derives one), reject the whole list on any collision, otherwise install every persisted entry not currently installed and leave already-installed entries unchanged
  - [x] Ensure one entry's install failure is reported without stopping the remaining entries
  - [x] Cover write-back on add and remove, removing a name-less hand-seeded entry by its derived name, credential-free write-back for an HTTP(S) source with userinfo, resolved-real-path write-back for a local source given as a relative path, write-back failure after a successful install or removal, install of missing entries including a hand-seeded entry, no-op on already-installed entries, explicit- and derived-name collision rejection, and per-entry failure isolation in tests
  - [x] Update `docs/manual/plugins.md` and any `marketplace` command help text for the new command
  - [x] Verify 100% coverage and `bun run check`

## Open Questions

None. A `tx config` command, key deletion, and schema migration require a concrete consumer and a later specification change.

## References

- Specs: [Config](../specs/config/), [Plugin System](../specs/plugin-system/), [Updates](../specs/updates/), [Architecture](../specs/architecture/)
- Related changes: [0016-add-plugin-capabilities-and-dialogs](./0016-add-plugin-capabilities-and-dialogs.md), [0008-link-local-marketplace-sources](./0008-link-local-marketplace-sources.md), [0014-pin-marketplace-versions](./0014-pin-marketplace-versions.md)
- Manual: [Plugins](../manual/plugins.md)
