# 0007: Delegate Dispatch to Plugins

## Summary

Replace the core command trie with a Commander-based root program that resolves only the first argument to a plugin namespace and hands every remaining argument to that plugin, including options and help requests. Each plugin that defines commands owns one namespace named after its identity, builds its own command tree, and receives the parser both pre-built and injected.

**Spec:** [Plugin System](../specs/plugin-system/)
**Status:** complete
**Depends On:** 0006

## Motivation

Core currently owns far more of the command line than it should:

- `src/commands.ts` intercepts `--help` anywhere in the argument vector before a handler ever runs, so a plugin cannot describe its own flags, print its own usage, or treat `--help` as a value.
- The command tree has no place for descriptions, options, or arguments. Leaf help degrades to a bare `Usage: tx marketplace add` with no mention of `--name`, and every plugin hand-rolls its own flag loop (`plugins/marketplace/manager.ts`) with its own ad-hoc usage strings.
- Registration lets any plugin claim any top-level path, so a marketplace-installed plugin can silently occupy a name unrelated to its identity.
- Usage errors thrown by handlers surface as generic runtime failures, indistinguishable from a crash.

The result is that "the plugin owns its commands" holds for the handler body only. Everything a user actually types — flags, subcommand structure, help — is still core's business. This change moves that boundary to where the spec always claimed it was, and adopts a maintained parser instead of growing a bespoke one, closing the architecture spec's standing open question about the final parser choice.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable dispatch, help, output-routing, and exit-code behavior MUST have automated tests.
- Every rewritten exit-code assertion MUST keep its paired stream assertion, so a test cannot pass by checking the code while the diagnostic silently moves streams.
- Dispatch tests MUST assert against the injected context streams, never against real process streams, so an escape from output routing fails the suite rather than polluting test output.
- Standalone-executable parity MUST be exercised without relying on a separate Bun executable on `PATH`.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Architecture: Core CLI](../specs/architecture/index.md#core-cli) owns the root dispatch contract, delegation boundary, help behavior, and exit codes. [Plugin System: Public Plugin Contract](../specs/plugin-system/index.md#public-plugin-contract) and [Plugin System: Namespace Ownership](../specs/plugin-system/index.md#namespace-ownership) own the namespace, registration, and dependency-injection contracts. Their scenarios are this change's acceptance criteria and are not restated here. This change amends both specs; the index records Plugin System as its primary spec.

What implementing them requires of this change:

- The bundled marketplace plugin MUST be migrated to the new registration API in the same change; there is no compatibility period, because `PluginAPI.command` changes shape.
- The marketplace plugin's hand-written argument parsers MUST be replaced by declared arguments and options. Validation that is genuinely marketplace-owned — local-name safety in particular — MUST remain, and MUST keep rejecting the same inputs it rejects today.
- `EXIT_USAGE` becomes unreachable and MUST be removed rather than left as dead configuration.
- The streams and exit codes required by [Architecture: Core CLI](../specs/architecture/index.md#core-cli) differ from what ships today, and `docs/manual/plugins.md` documents today's values. The manual MUST be corrected to match that contract in the same pull request that changes the behavior, rather than in a follow-up.
- Two existing guards cover contracts this change puts under new pressure and MUST keep passing rather than being relaxed: `test/plugin-consumer.test.ts` guards the parser-free authoring contract in [Plugin System: Public Plugin Contract](../specs/plugin-system/index.md#public-plugin-contract) as the published type surface grows a parser dependency, and `test/plugin-boundary.test.ts` guards [Plugin System: Composition and Boundaries](../specs/plugin-system/index.md#composition-and-boundaries) as core and the marketplace plugin are rewritten together.

#### Scenario: Marketplace name validation survives the parser migration

- **GIVEN** the marketplace plugin declares its options through the parser instead of a hand-written loop
- **WHEN** a local marketplace name that the plugin's own safety rules reject is supplied
- **THEN** the plugin still rejects it, and the rejection is reported through the plugin's namespace rather than as a core parsing error

## Design

### Approach

`src/commands.ts` loses `CommandRegistry`, `normalizeCommandPath`, and the trie entirely. In its place, core builds one root program, collects a namespace command from each successfully initialized plugin that staged commands, validates the first argument, and parses. The marketplace's intermediate discovery definitions stage no commands, so the collection step skips them and they never reach the root program.

Registration staging in `src/plugins.ts` is preserved verbatim in behavior: a plugin's namespace command is built into a staged object and only attached to the root program if initialization succeeds. The queue, FIFO ordering, failure isolation, and diagnostics are untouched.

Handing the plugin a live command object opens two escapes that path-string registration did not have, so staging gains two checks. A builder returning a thenable is refused outright — that is the `async`-builder accident, where the rest of the function lands past the commit point. The staged namespace is then re-checked against the plugin's identity name before it is attached, since the builder holds an object whose own name and aliases it can change.

Neither check can catch a synchronous builder that schedules work and returns cleanly, and no return-value inspection could. The design does not try. Staging fixes the namespace when the plugin's initialization completes — which is also what lets repeated registration calls accumulate — and the hardening pass runs immediately before parse, after every plugin has initialized, so anything reachable by then is hardened whenever it was added. What remains is a plugin mutating its own tree mid-parse, which is inside its own action and therefore its own business. Plugins are trusted in-process code; the contract states what the host honours, not what a plugin is prevented from doing.

`src/plugin.ts` changes `PluginAPI.command` from `(path, handler)` to a builder that receives the plugin's pre-built namespace command, and gains `PluginAPI.context` so a plugin can reach the injected streams from inside an action without threading them through a handler signature. `CoreDependencies` gains the parser module and its version alongside React and Ink.

`plugins/marketplace/index.ts` declares `add`, `list`, and `remove` as real subcommands with declared arguments and options. `parseAddMarketplaceArguments`, `parseListMarketplaceArguments`, and `parseRemoveMarketplaceArguments` in `plugins/marketplace/manager.ts` are deleted; `validateMarketplaceName`, `normalizeMarketplaceRepository`, and `deriveMarketplaceName` stay, because they encode marketplace safety rules rather than argument syntax.

### Decisions

- **Decision:** Use Commander (`commander@15`) as the parser.
  - **Why:** It is the only widely used Node parser that supports both halves of this change out of the box — nested subcommands with generated per-level help, and positional option scoping so options after a subcommand name are not stolen by the root. It requires Node `>=22.12`, which Bun satisfies.
  - **Alternatives considered:** Extending the existing trie was rejected — descriptions, typed options, variadic arguments, and per-level help are exactly the surface a parser library exists to provide, and the manual said as much. `citty` and `cac` were considered and rejected for weaker nested-subcommand help and smaller ecosystems.

- **Decision:** The root program enables positional-option scoping, and core does nothing else to the plugin's own option handling.
  - **Why:** Root scoping alone is what makes "everything after the plugin name belongs to the plugin" literally true. Verified experimentally: without it, `tx notes --version` prints tx's version and the plugin never sees the flag; with it, the flag reaches the plugin's own parser, which accepts or rejects it on the plugin's terms.
  - **Alternatives considered:** Also forcing pass-through onto every namespace was rejected after testing — pass-through stops option parsing at the first operand, so a namespace declaring both an argument and an option rejects `tx notes file --format json` as excess arguments while accepting `tx notes --format json file`. That silently constrains valid syntax the plugin contract permits. Pass-through remains available to any plugin that wants it, chosen by the plugin rather than imposed by core. Slicing `argv` at the namespace and calling the plugin's parser directly was rejected because the root then cannot generate a namespace listing with descriptions, and every plugin has to re-derive its own program name for usage lines.

- **Decision:** Core validates the first argument itself, before handing the vector to the parser.
  - **Why:** Positional scoping engages only after a *recognized* namespace, so it does not cover an unrecognized one. Verified experimentally: with scoping enabled but no first-argument check, `tx missing --version` prints the version and exits `0`, and `tx missing --help` prints root help and exits `0`, instead of reporting that `missing` is not a namespace. Only `tx missing` on its own reports the error. A first-argument check closes the gap without weakening delegation, because it inspects exactly one token and never the remainder.
  - **Alternatives considered:** Root pass-through was rejected because it also suppresses root help and version in the positions where they must work. Accepting the behavior was rejected: a typo'd namespace silently succeeding is worse than the bug this change removes.

- **Decision:** Core hardens the entire assembled command tree — output routing and termination override — immediately before parsing, recursively.
  - **Why:** Attaching a pre-built command does **not** propagate these settings to it or to subcommands it already created. Verified experimentally: an un-hardened plugin subcommand printing help calls `process.exit()` directly, killing the host mid-parse and bypassing the injected streams entirely. A single recursive pass after all plugins have registered is the only point where the full tree is known.
  - **Alternatives considered:** Copying settings at attach time was rejected — it reaches the namespace command but not the subcommands the plugin already built underneath it, which is precisely the failing case.

- **Decision:** Map parser outcomes to exit codes by code, not by the parser's own numbers.
  - **Why:** Help and version requests resolve to success; every usage error and every action failure resolves to failure. Owning the mapping keeps the CLI's contract independent of the parser's internal numbering across upgrades.
  - **Alternatives considered:** Passing the parser's exit code through was rejected as an unstated dependency on library internals.

- **Decision:** The root claims no implicit `help` subcommand.
  - **Why:** A reserved top-level `help` word would shadow any plugin whose identity is `help`, reintroducing exactly the core-owns-your-namespace problem this change removes. Plugins remain free to enable one inside their own namespace.
  - **Alternatives considered:** Reserving the word was rejected; special-casing it only when unclaimed was rejected as behavior that changes based on what else is installed.

- **Decision:** Expose the parser both ways — pre-built namespace command *and* injected module.
  - **Why:** A plugin author who only wants to add a subcommand should never install or import the parser; a plugin author who wants to build detached commands, reuse parser helpers, or share option definitions needs the host's exact instance to avoid a dual-package hazard, exactly as React and Ink already work.
  - **Alternatives considered:** Injection alone was rejected as forcing a dependency on trivial plugins; the pre-built command alone was rejected as blocking advanced composition.

### Non-Goals

- Lazy plugin initialization. Every plugin still initializes on every invocation that reaches dispatch, in order to build the root listing; the root version fast path continues to return before initialization. Making initialization lazy is deferred to a future change and recorded as an open question.
- Removing `PluginAPI.env` even though `PluginAPI.context.env` now overlaps it. It is public, harmless, and its removal is unrelated churn.
- Shell completion, colored help, and help-text theming. All become reachable once the parser is in place; none are specified here.
- Changing the marketplace plugin's storage, discovery, installation, or recovery behavior. This change touches only how its commands are declared and parsed.
- Reintroducing a usage-versus-runtime exit-code distinction. The approved contract collapses both to a single failure code.

## Tasks

- [x] Inject the parser as a core dependency (PR #19)
  - [x] Add `commander` to runtime dependencies and the lockfile
  - [x] Extend `CoreDependencies` in `src/plugin.ts` with the parser module and its version, and populate both in `src/plugins.ts`
  - [x] Re-export the parser's command type from `@fx/tx/plugin` so plugins type their builders without declaring their own parser dependency
  - [x] Add tests asserting the injected module is the host instance and that the version metadata matches the manifest
  - [x] Confirm `test/plugin-consumer.test.ts` still type-checks an external consumer with no parser dependency of its own

- [x] Delegate dispatch to plugin namespaces (PR #20)
  - [x] Replace the trie in `src/commands.ts` with root-program construction, first-argument validation, recursive tree hardening, and exit-code mapping
  - [x] Test that an unrecognized first argument reports the error and fails even when a root option follows it, covering both root options in both forms
  - [x] Delete `CommandRegistry`, `normalizeCommandPath`, and `EXIT_USAGE`
  - [x] Change `PluginAPI.command` to the namespace builder and add `PluginAPI.context` in `src/plugin.ts`
  - [x] Derive each namespace from the plugin's own identity name in `src/plugins.ts`, reject identity names the spec disallows, claim a namespace only for plugins that define commands, and keep staging atomic
  - [x] Accumulate repeated registration calls onto the plugin's single namespace instead of replacing it, and test it
  - [x] Reject a builder that returns a thenable, and test that an `async` builder fails the plugin instead of landing its work after the commit
  - [x] Fix the staged namespace when the plugin's initialization completes, harden the whole tree immediately before parse, and test that a command added late is still covered
  - [x] Validate the staged namespace at commit time against the plugin's identity name, and test that renaming it or adding an alias fails the plugin
  - [x] Reject a second plugin claiming an already claimed namespace, naming both plugin identities
  - [x] Extend the pre-initialization version fast path in `src/cli.ts` to match either root version form as the first argument regardless of what follows it, replacing today's single-argument check, and cover both forms with and without a trailing token
  - [x] Migrate `plugins/marketplace/index.ts` to declared subcommands, arguments, and options
  - [x] Delete the three hand-written argument parsers from `plugins/marketplace/manager.ts` and keep the marketplace-owned validators
  - [x] Rewrite `test/commands.test.ts`, `test/cli.test.ts`, `test/plugins.test.ts`, `test/plugin-system.test.ts`, `test/marketplace-plugin.test.ts`, and `test/standalone.test.ts` for the new dispatch, help, stream, and exit-code behavior
  - [x] Add tests proving an un-hardened path cannot escape: a plugin whose subcommand prints help MUST NOT terminate the host and MUST write to the injected stream
  - [x] Add tests proving options after the namespace reach the plugin, including a flag the root itself defines
  - [x] Update `docs/manual/plugins.md` for the new authoring API, namespace rule, help delegation, and exit codes
  - [x] Verify 100% coverage and `bun run check`

## Open Questions

- [ ] Should plugin initialization become lazy once the root listing can be cached? Every plugin currently loads on every invocation that reaches dispatch, solely to contribute its namespace and description. Deferring this keeps the change focused, but startup cost grows linearly with installed plugins.
- [ ] Should the host offer a shared convention for plugins that expose a single action at their namespace root (`tx notes` doing work with no subcommand)? Reachable today without host support; worth revisiting if several plugins hand-roll it.

## References

- Spec: [Architecture](../specs/architecture/), [Plugin System](../specs/plugin-system/)
- Related changes: [0003-externalize-marketplace-plugin](./0003-externalize-marketplace-plugin.md), [0006-isolate-plugin-failure-exit-codes](./0006-isolate-plugin-failure-exit-codes.md)
- External: [Commander.js](https://github.com/tj/commander.js)
