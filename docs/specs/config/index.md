# Config

## Overview

`tx` provides a bundled config plugin that lets any plugin persist a small JSON value across invocations, scoped to the current user rather than the current working directory. The plugin MUST expose that capability through the generic registry rather than through core vocabulary, and its contract MUST let a plugin declare the shape it expects under its own key before reading or writing it, so a corrupt or foreign value is rejected rather than silently trusted. The persisted document lives at a fixed, documented location rather than an internal implementation detail, so a user MAY hand-edit or pre-seed it directly; no `tx` command is required to create or populate it.

[Change 0018](../../changes/0018-add-config-store-and-marketplace-installs.md) specifies the config capability and its first consumer, the marketplace plugin's configured-marketplace list. The bundled provider is implemented under `plugins/config/` and composed only in `cli.ts`; marketplace consumption remains pending. The config requirements below describe current behavior, while the configured-marketplace requirements linked from this document remain desired behavior until that consumer lands.

## Background

Plugins already receive generic process and identity context through the [Plugin System](../plugin-system/), and a plugin MAY resolve its own platform-appropriate data paths and own its own mutable state, per [Architecture: State Ownership](../architecture/index.md#state-ownership). Nothing shared validates what a plugin persists there, so each plugin that wants durable state re-derives its own data directory, its own file format, and its own defense against a hand-edited or stale file.

The [Plugin System: Generic Registry](../plugin-system/index.md#generic-registry) explicitly leaves persistence, schemas, and runtime type validation out of its own contract; it is a keyed bag for in-memory capabilities, not a store. The config plugin is, like the dialogs plugin, a concrete capability built on top of that registry rather than a change to it: the registry stays a generic, persistence-free bag, and the config plugin is one more opaque value living inside it.

The first concrete need is the marketplace plugin's list of marketplaces a user wants installed, specified in [Plugin System: Configured Marketplaces](../plugin-system/index.md#configured-marketplaces). A later plugin collecting input through the [Dialogs](../dialogs/) text input MAY persist what it collects through this same capability; this spec keeps the key and value shape generic enough for that without designing that plugin.

## Requirements

### Config Capability

- The bundled config plugin MUST register one config capability under the opaque registry key `config` and MUST NOT claim a command namespace.
- A consumer MUST read the capability while its command runs, after plugin initialization has completed, rather than snapshotting it during initialization.
- The config plugin and its consumers MUST use a local structural contract; the capability MUST NOT add config types or runtime values to `@fx/tx/plugin`.
- The capability MUST persist independently of the current working directory, scoped to the current user, so the same key returns the same value regardless of where `tx` is invoked from.

Conceptual internal shape:

```ts
type ConfigValidator<T> = (value: unknown) => value is T

type Config = {
  define<T>(key: string, isValid: ConfigValidator<T>): void
  read<T>(key: string): Promise<T | undefined>
  write<T>(key: string, value: T): Promise<void>
}
```

The exact structural representation MAY vary, but it MUST preserve the owned contracts above.

#### Scenario: Capability used by a command

- **GIVEN** the config provider and an internal consumer initialized successfully
- **WHEN** the consumer reads `config` while its command runs
- **THEN** it can define, read, and write its own key without importing the provider's implementation

#### Scenario: Provider claims no namespace

- **GIVEN** the config plugin registers its capability and no commands
- **WHEN** root help is rendered
- **THEN** no config namespace appears

### Key Definition

- A consumer MUST call `define` for a key, supplying a type guard, before calling `read` or `write` for that key in the same process.
- `read` or `write` called for a key that has not been defined in that process MUST reject without touching the persisted document.
- `define` MUST reject a second call for a key already defined in that process, so a key's expected shape has exactly one definition per run.
- A key MUST be an opaque string compared by exact equality; the host MUST NOT reserve, normalize, parse, trim, or namespace it. A consumer SHOULD use a key that identifies itself, such as its own plugin identity name, to avoid an accidental collision with an unrelated plugin, but the host MUST NOT enforce that.

#### Scenario: Define before use

- **GIVEN** a consumer has not yet called `define` for a key
- **WHEN** it calls `read` or `write` for that key
- **THEN** the call rejects and the persisted document is unchanged

#### Scenario: Duplicate definition rejected

- **GIVEN** a consumer has already called `define` for a key in the current process
- **WHEN** `define` is called again for that same key
- **THEN** the second call rejects and the key's original guard remains in effect

### Reading and Writing

- `read` MUST return the persisted value for a defined key when one exists and the key's guard accepts it.
- `read` MUST resolve with `undefined`, not reject, when no value is persisted under a defined key.
- `read` MUST reject when a value is persisted under a defined key but that key's guard rejects it, and MUST NOT affect reading any other key.
- `write` MUST reject a value that the key's own guard rejects, before persisting anything.
- `write` MUST persist a value accepted by the key's guard so that a subsequent `read` for that key, in the same process or a later one, resolves with a value equivalent to what was written.
- A value written and later read back MUST be encoded and decoded as JSON; a consumer's guard is responsible for accepting only values that survive that round trip unchanged.

#### Scenario: Read before any write

- **GIVEN** a defined key with nothing ever written under it
- **WHEN** a consumer calls `read`
- **THEN** it resolves with `undefined`

#### Scenario: Write then read

- **GIVEN** a defined key and a value its guard accepts
- **WHEN** a consumer writes that value and a later process reads the same key with an equivalent guard
- **THEN** the read resolves with a value equivalent to what was written

#### Scenario: Guard rejects a foreign value

- **GIVEN** a key's persisted value no longer matches the shape its guard expects
- **WHEN** a consumer reads that key
- **THEN** the read rejects and reading an unrelated, validly-shaped key still succeeds

#### Scenario: Invalid write rejected

- **GIVEN** a value that a key's guard rejects
- **WHEN** a consumer calls `write` with it
- **THEN** the call rejects and the previously persisted value for that key, if any, is unchanged

### Storage and Persistence

- The capability MUST persist every key's value in one document per user, independent of any single plugin's own data directory.
- The document MUST be named `config.json` inside a `tx` subdirectory of the current platform's per-user data directory: `$XDG_DATA_HOME/tx` when set to an absolute path, otherwise `~/.local/share/tx`, on Linux and other non-Windows, non-macOS platforms; `~/Library/Application Support/tx` on macOS; and `%LOCALAPPDATA%\tx`, falling back to `%APPDATA%\tx`, falling back to `~/AppData/Local/tx` when neither is set, on Windows — the same convention `tx`'s bundled marketplace plugin already resolves its own data directory from. This location MUST be fixed and documented, not an internal implementation detail, so a user or an external script can locate and hand-edit the file without running any `tx` command.
- The document's top level MUST be a JSON object whose properties are the defined keys, so a user hand-editing one plugin's key does not have to touch or understand another's.
- A write MUST be atomic: an interruption during a write MUST leave the previously persisted document intact rather than a partially written one.
- The document MUST tolerate being absent; a first write MUST create it and every intermediate directory it needs.
- A read or write MUST reject when the persisted document exists but either cannot be parsed as JSON or parses to a JSON value whose top level is not an object, rather than silently treating it as empty, coercing it, or discarding its content.
- Two `tx` invocations writing at the same time MAY race; the capability MUST NOT corrupt the document when they do, but it MUST NOT provide mutual exclusion across processes. Whichever write finishes last is the value a later read observes.

#### Scenario: First write creates the document

- **GIVEN** no config document exists yet for the current user
- **WHEN** a consumer writes a value for a defined key
- **THEN** the document is created and a later read of that key resolves with that value

#### Scenario: Corrupt document reported rather than discarded

- **GIVEN** the persisted document exists but is not valid JSON
- **WHEN** a consumer calls `read` or `write`
- **THEN** the call rejects and the document is left exactly as it was

#### Scenario: Non-object document root rejected

- **GIVEN** the persisted document exists, parses as valid JSON, and its top level is an array, string, number, boolean, or `null`
- **WHEN** a consumer calls `read` or `write`
- **THEN** the call rejects and the document is left exactly as it was

## Design

### Ownership

The config plugin is an ordinary bundled provider outside `src/`. Core stores its value under an opaque key and has no config vocabulary. Internal consumers depend on a small structural `Config` shape, not on the provider's module graph, exactly as they depend on the `Dialogs` shape rather than the dialogs plugin's implementation.

The provider resolves its own platform-appropriate data directory the same way the marketplace plugin resolves its own, per [Architecture: State Ownership](../architecture/index.md#state-ownership) — independently, since a bundled plugin's complete module graph must stay self-contained and neither bundled plugin imports the other.

### Registry Use

The provider registers during initialization. Consumers read the committed value inside command actions, when all successful root and child plugins have initialized. Repository composition supplies one config provider; behavior with additional values under the same registry key belongs to neither this spec nor the initial consumer contract, exactly as for dialogs.

### Key Ownership Within One Process

`define`'s single-definition-per-key rule is enforced only for the lifetime of one `tx` invocation, not across the persisted document's history. A plugin's command action typically defines the one key it owns and then reads or writes it; two of that plugin's own commands never run in the same process, so they never contend for the same definition. The rule exists to catch two different plugins accidentally choosing the same key, not to model ownership of the persisted document itself.

## Constraints

- One JSON document holds every key; per-plugin files, directories, or namespacing beyond the opaque key are out of scope.
- A schema description language, a validation library dependency, and anything beyond a plain type-guard function are out of scope; a consumer's guard is ordinary code.
- Migration or versioning of a persisted shape is out of scope; a consumer that changes its own shape is responsible for tolerating or rejecting what an older version wrote.
- Cross-process locking, transactions spanning more than one `write` call, partial or nested key paths within a value, encryption, and access control are out of scope.
- A `tx config` inspection or editing command is out of scope. End-user access to the persisted document is by hand-editing the fixed-location file directly, per [Storage and Persistence](#storage-and-persistence); the capability's programmatic surface is consumed by other plugins, not exposed as end-user vocabulary, in this spec.
- Listing every defined or persisted key, subscribing to changes, and deleting a single key without writing a replacement value are out of scope.

## Open Questions

- A `tx config` command that lists or edits persisted keys MAY be specified when a concrete need for direct end-user access arises.
- Deleting a key outright, rather than writing a new value over it, MAY be specified when a concrete consumer needs it.
- A future plugin that collects input through [Dialogs](../dialogs/) text input and persists it through this capability is anticipated but not designed here.

## References

- [Plugin System](../plugin-system/)
- [Plugin System: Configured Marketplaces](../plugin-system/index.md#configured-marketplaces)
- [Architecture](../architecture/)
- [Dialogs](../dialogs/)
- [Change 0018: Add Config Store and Marketplace Installs](../../changes/0018-add-config-store-and-marketplace-installs.md)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-31 | Initial desired config capability, key definition, and persistence behavior | [0018-add-config-store-and-marketplace-installs](../../changes/0018-add-config-store-and-marketplace-installs.md) |
