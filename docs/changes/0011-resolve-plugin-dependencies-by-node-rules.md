# 0011: Resolve Plugin Dependencies By Node Rules

## Summary

Make a plugin's dependencies resolve the way every other Bun and Node program resolves them. A plugin entry is loaded through Bun's bundler, which implements the whole Node resolution algorithm, instead of being handed to the compiled executable's runtime module resolver, which reads no `package.json` at all. A plugin that declares a dependency and has it installed can import it — by its bare name, by a subpath its `exports` map publishes, and transitively through the dependency's own dependencies.

**Spec:** [Plugin System](../specs/plugin-system/)
**Status:** complete
**Depends On:** 0005

## Motivation

[Change 0005](./0005-install-per-plugin-dependencies.md) gave each plugin a `package.json` and installs it with `bun install`. The install works: a plugin declaring `@modelcontextprotocol/sdk` gets it, and its ninety-odd transitive packages, laid out in the plugin's own `node_modules`. Importing any of it from the released executable fails.

```
Cannot find module '@modelcontextprotocol/sdk/server/mcp.js' from '.tx/co/mcp.ts'
```

The install is not at fault. Copying the same `package.json` and the same host-installed `node_modules` into a bare directory and running `bun` there resolves that specifier immediately. What differs is the runtime doing the resolving.

Inside a Bun single-file executable, resolving a specifier against a directory outside the embedded filesystem is reduced to path arithmetic. A literal file path resolves. A directory holding `index.js` resolves. Nothing else is consulted — not `exports`, not `main`, not `type`, not for a bare specifier and not for a relative directory import either.

The whole rule is therefore: **a package resolves if and only if it ships a root `index.js`.** It separates every package observed against the released executable, and nothing else does — not `exports`, not CommonJS versus ESM, not whether the package has dependencies of its own:

| package | `main` | `exports` | `type` | root `index.js` | resolves |
|---|---|---|---|---|---|
| `ms` | `./index` | no | – | yes | yes |
| `indent-string` | – | yes | `module` | yes | yes |
| `date-fns` | `index.cjs` | yes | `module` | yes | yes |
| `zod` | `./index.cjs` | yes | `module` | yes | yes |
| `decimal.js` | `decimal` | yes | – | no | **no** |
| `ajv-formats` | `dist/index.js` | no | – | no | **no** |
| `debug` | `./src/index.js` | no | – | no | **no** |

Three consequences follow, and all three are reachable from an ordinary npm dependency:

- A package whose entry point exists only in an `exports` map is reported missing. `@modelcontextprotocol/sdk/server/mcp.js` is a published subpath and fails.
- A package whose `main` names anything other than `index.js` is reported missing. `debug`, `ajv-formats`, and `decimal.js` are each installed, each have a `main`, and each fail.
- A package carrying both a declared entry point and a root `index.js` resolves — to the `index.js`, which is not the entry point it declares. That failure is silent, and it is the worst of the three.

The reduction applies to every specifier in the graph, not only the ones a plugin writes, so an installed dependency cannot reach its own dependencies either: `ajv-formats` cannot reach `ajv` from its own `dist/limit.js`, and the SDK cannot reach `zod-to-json-schema` from its own `zod-json-schema-compat.js`, whether or not the plugin declares them.

This went unnoticed because the only dependency any plugin had declared until now was `date-fns`, which ships a root `index.js`. It resolves by path arithmetic alone.

The gap is in the executable's runtime resolver specifically, and it cannot be worked around from inside one. A runtime module hook does not see a literal import specifier — Bun resolves those before consulting one, and fails there. `Bun.resolveSync` is degraded identically. What is not degraded is the bundler: `Bun.build` implements Node resolution in full and implements it identically compiled and uncompiled. Loading a plugin through it resolves the graph correctly and hands the runtime a module with nothing left to resolve.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors, including the consumer-project check that compiles the marketplace plugin against `@fx/tx` alone. The plugin MUST NOT acquire a type dependency on Bun's global types.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Resolution MUST be tested against the compiled executable. A resolution test running only in-process proves nothing: uncompiled, every specifier in this change already resolves, so such a test passes against the defect it is meant to catch.
- The dependency fixture MUST be unresolvable by path arithmetic in every case it covers: a package with no `main` and no root `index.js` whose `exports` map selects by condition, a subpath export whose name differs from the file behind it, a package reached through another package's dependency, and an installed package whose `main` names something other than `index.js`. A fixture package that ships a root `index.js` passes before the fix and covers nothing.
- CommonJS MUST be covered in both shapes that any candidate rule has to separate: a CommonJS package with a dependency of its own (`debug`'s shape) and a CommonJS package with no dependencies and an extensionless `main` (`decimal.js`'s shape).
- The silent failure MUST be covered: a package declaring an entry point *and* shipping a root `index.js` holding something else MUST resolve to its declared entry. This is the one case that reports no error before the fix, so a test asserting only that the import succeeds would pass against the defect; the test MUST assert which file was loaded.
- Fixture packages MUST be written by the test rather than installed, so no test reaches the network or runs `bun install`.
- Both the eager and the lazy import shape MUST be covered: a dependency imported as the entry module is evaluated, and one imported inside a command action, which is the shape that reported the defect.
- Lazy evaluation MUST be pinned by a module that announces its own evaluation and a command that does not dispatch it. Resolving a plugin's graph ahead of time MUST NOT evaluate a module whose command was not invoked, and a test asserting only that the dispatched command works would not notice if it did.
- A specifier assembled at runtime MUST be pinned by a test, so a later change to the build options cannot turn a plugin that loads and runs into one that fails to load at all.
- A plugin whose dependency is genuinely absent MUST have a test that its failure names the unresolved specifier.
- Tests MUST create every fixture inside a temporary directory they own and MUST remove it afterwards. No test may reach the network or run `bun install`.

### Functional Requirements

- A plugin entry MUST be loaded with its dependency graph resolved by Node's resolution algorithm, in the compiled executable exactly as outside it.
- Resolution MUST honour `exports` maps, including subpath exports, subpath patterns, and conditions; `imports` maps; the legacy `main` and directory-index fallbacks; and the `node_modules` walk.
- A resolved dependency MUST resolve its own dependencies by the same rules, to any depth.
- The loaded module MUST keep the identity of the entry file: `import.meta.url` and `import.meta.dir` MUST name the plugin's own file and directory, so a plugin reading a file beside itself still finds it.
- Loading MUST write nothing into a marketplace checkout and MUST NOT modify an installed `node_modules`. A referenced local marketplace is the author's own working tree.
- A plugin whose graph cannot be resolved MUST fail as a plugin failure, reporting the specifier that could not be resolved, and MUST leave healthy plugins loadable — the existing isolation contract.
- Loading MUST behave identically whether or not tx is running compiled, so a plugin author working against a source checkout exercises the module graph the released executable builds.

## Design

### Approach

`plugins/marketplace/module.ts` owns loading a plugin entry as a module. It registers a Bun module loader keyed to that entry's exact path, and the loader returns the entry bundled by `Bun.build` with `target: "bun"`. The runtime then loads the bundle *as* that path, so the module keeps its real identity while its whole graph arrives already resolved.

`plugins/marketplace/index.ts` calls `importPluginEntry(entryPath)` where it previously called `import()` directly. Nothing else about entry definition, failure mapping, or recovery changes.

### Decisions

**Bundle rather than resolve.** The alternative was a Node resolution implementation of our own, fed to the runtime through a resolver hook. Two things rule it out. A runtime hook never sees a literal import specifier, which is nearly all of them — Bun resolves those itself and fails before any hook runs — so the hook would fix only the rare dynamic specifier computed at runtime. And a hand-written resolver would be a second implementation of `exports`, `imports`, conditions, patterns, and the legacy fallbacks, maintained here, wrong in its own ways. `Bun.build` is Bun's own implementation of exactly that algorithm, and it is not degraded inside an executable.

**Keyed to the entry path, returning source rather than a file.** The bundle is never written anywhere. Returning it from a loader keyed to the entry's own path is what preserves `import.meta`, and it is also what keeps a referenced local marketplace clean: that checkout is the author's working tree, and an artifact appearing in it on every `tx` invocation would show up in their `git status`. Bundling the graph of the real `@modelcontextprotocol/sdk` costs about 12ms, so nothing is cached and nothing can go stale — a live reference stays live.

**Bundling applies uncompiled too.** Restricting it to a compiled executable would leave a plugin author's source-checkout runs more permissive than the executable their users install, which is the arrangement that hid this defect for six changes. The same module graph is built either way.

**A lazily imported module is still evaluated lazily, but its graph is now resolved eagerly.** A plugin that defers work behind `await import('./mcp.ts')` does so to keep an expensive dependency off the path of its cheap commands. That deferral survives in the sense that matters: the module is evaluated when the action runs and not before, which a test pins by having a module announce its own evaluation and asserting the announcement is absent until its command is dispatched. What no longer waits is resolving and parsing the graph, which now happens once as the plugin loads, whichever command was invoked.

That costs measurable startup time, and the cost scales with the graph rather than being a flat penalty. Against the released executable, `status` on a plugin whose only dependency is `date-fns` goes from 76.8ms to 83.9ms; on a plugin declaring `@modelcontextprotocol/sdk` and its 92 packages, from 56.3ms to 99.8ms. (The two baselines are not comparable with each other — different fixtures — only within each pair.) Dispatching the command that actually uses the SDK costs 117.9ms, the difference being the SDK evaluating.

Caching the bundle would remove the repeated cost, and is deliberately not done here: a cache keyed well enough to stay correct against a live local marketplace is a larger design than this defect fix, and 43ms on the largest graph anyone has is not yet worth it. It is recorded as an open question.

**A specifier assembled at runtime is left alone.** `await import(computed)` cannot be resolved ahead of time, and the bundler does not fail over it — it survives into the output as a runtime import, so the plugin loads and runs. It then meets the executable's own resolver, with exactly the behaviour it has today: a computed path resolves, a computed bare specifier does not. Nothing about this shape changes, and a test pins it so that a future change to the build options cannot quietly turn it into a plugin that fails to load at all.

**Encapsulation is now enforced.** A specifier reaching past a package's `exports` map into a file it does not publish used to resolve, because the degraded resolver treated it as a path and never read the map. It now fails, as it does in Node and in Bun outside an executable. This is a behaviour change and it is the correct one; a plugin reaching into a dependency's internals was relying on the defect.

**Bun's global types stay out of the plugin.** `test/plugin-consumer.test.ts` compiles the marketplace plugin inside a consumer project that installs `@fx/tx` and nothing else, where `@types/bun` is absent — the check that keeps the plugin externalizable. The two runtime entry points the loader needs are therefore declared locally and read off `globalThis`. The plugin already reaches the same runtime through Node's own `process.execPath` to install dependencies.

### Non-Goals

- Resolving a specifier computed at runtime rather than written literally. It is not resolvable at bundle time, and the resolver it falls to is the degraded one. The behaviour is unchanged by this fix and pinned by a test.
- Caching bundles between invocations. It would remove the repeated resolution cost, but a cache key that stays correct against a live local marketplace has to cover the whole input set, which is a larger design than this fix.
- Sharing one dependency instance between two plugins that install the same package. Per-plugin dependency isolation is already what [Change 0005](./0005-install-per-plugin-dependencies.md) specifies.
- Fixing the executable's runtime resolver. It belongs to Bun; this change routes around it.

## Tasks

- [x] Specify plugin dependency resolution in [Plugin System: Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership)
- [x] Add `plugins/marketplace/module.ts` and load entries through it from `plugins/marketplace/index.ts`
- [x] Cover the compiled executable's resolution of an `exports`-only package, a subpath export, a transitively required package, an installed package whose `main` is not `index.js`, both CommonJS shapes, and an entry point shadowed by a root `index.js`, in `test/plugin-dependencies.test.ts`
- [x] Cover the unresolved-dependency failure and repeated loading of one entry
- [x] Document dependency resolution in `docs/manual/plugins.md`
- [x] Verify 100% coverage and `bun run check`

## Open Questions

- [ ] Should the host, rather than the marketplace plugin, own loading a plugin entry as a module? It is a host concern in principle, but the spec assigns dynamic import to the marketplace plugin today, and moving it would mean a new public runtime API rather than a defect fix.
- [ ] Should a plugin be able to declare a dependency as external, so two plugins share one installed copy? Nothing wants it yet, and dependency isolation is the current contract.
- [ ] Should resolved graphs be cached between invocations? It would return the startup time this change spends, and it needs a cache key covering every input a bundle drew on, so that a live local marketplace never serves a stale one. Worth revisiting if a plugin's graph grows past the 43ms measured here.
- [ ] Should a plugin's own modules stay unbundled, so each is resolved only when its command runs? It would restore the deferral in full, but each would then bundle its own copy of every dependency it names, and two copies of a package like `zod` break value identity across the plugin's own files. Not worth that to save the startup time above.
- [ ] Should the failure for an unresolved dependency suggest reinstalling the marketplace rather than removing it? The recovery advice is shared with every other plugin failure and is not specific to this one.

## References

- [Plugin System](../specs/plugin-system/)
- [Change 0005: Install Per-Plugin Dependencies](./0005-install-per-plugin-dependencies.md)
- [Change 0008: Link Local Marketplace Sources](./0008-link-local-marketplace-sources.md)
- [Bun bundler](https://bun.sh/docs/bundler)
- [Bun single-file executables](https://bun.sh/docs/bundler/executables)
- [Node.js package entry points](https://nodejs.org/api/packages.html#package-entry-points)
