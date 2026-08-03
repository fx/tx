# Plugins

Plugins extend `tx` with commands and other plugins. Install only code you trust: plugins are not sandboxed and run with the same permissions as `tx`. Git clones, plugin modules, dependencies, and package lifecycle scripts are trusted execution surfaces; there is no signing, provenance, permissions, rollback, catalog, or automatic-update layer.

Install the Linux x64 standalone release with `mise use -g github:fx/tx`. Plugin authors who install `@fx/tx` from GitHub Packages for its public types must configure `npm.pkg.github.com` with a classic PAT that has `read:packages`; GitHub requires this authentication even for public npm packages. See the [installation guide](../../README.md#install).

## Install and manage marketplaces

A marketplace is a Git repository containing one or more plugins.

```sh
tx marketplace add owner/repository
tx marketplace add https://example.com/tools.git --name tools
tx marketplace list
tx marketplace remove tools
```

`add` accepts any Git clone source. Bare `owner/repository` input expands to an HTTPS GitHub clone URL. The installed name is derived from the repository unless `--name` supplies one. The current repository is not auto-loaded; install it as a marketplace if you want `tx` to load its configuration.

Marketplaces and their plugins execute in deterministic order: installed marketplace names are sorted, entries retain their manifest order, and the host initializes roots followed by contributed children in FIFO order.

## Marketplace layout

The canonical manifest is `.tx/config.json` at the repository root:

```json
{
  "plugins": [
    { "name": "notes", "entry": "plugins/notes.ts" },
    { "name": "reports", "entry": "plugins/reports.ts" }
  ]
}
```

The `plugins` array must be non-empty. Give every entry a unique name that is one safe path component, and use a non-empty repository-relative entry path. Entries must resolve to regular files contained by the repository, including after symbolic links are resolved. A root `tx.marketplace.json` remains supported for older marketplaces, but `.tx/config.json` takes precedence when both exist.

A marketplace needs no build step or package manifest. If `package.json` exists, `tx` runs `bun install` from the marketplace root before loading plugins; dependencies and install lifecycle scripts execute unsandboxed with `tx`'s permissions.

## Write a plugin

A plugin entry is a TypeScript module with a default export. Import the public contract as types only; `@fx/tx/plugin` does not provide a runtime API.

```ts
import type { Plugin } from "@fx/tx/plugin";

const plugin: Plugin = ({ command }) => {
  command("hello", (_args, context) => {
    context.stdout.write("Hello from tx!\n");
  });
};

export default plugin;
```

The initialization API provides an immutable `identity`, read-only `env`, shared `dependencies`, `command(path, handler)`, and `plugin(childDefinition)`. A command path may be a whitespace-separated string or an array of segments. Handlers receive remaining arguments plus process streams, environment, working directory, and the owning plugin identity. Loading, initialization, and command handlers may be asynchronous.

Use the initialization API's `dependencies.react` and `dependencies.ink` instead of importing separate runtime copies; the injected values share the host's React and Ink instances and include tx and dependency version metadata.

Commands and child definitions registered during initialization form one atomic contribution; registration ends when initialization does. If loading, initialization, export validation, or collision detection fails, the plugin contributes nothing while healthy plugins can still dispatch. Failures are diagnosed, and the invocation exits nonzero if any plugin failed.

## Bundled plugins

Bundled feature plugins live under `plugins/<name>/`, conventionally at `plugins/<name>/index.ts`. Only the root `cli.ts` composition root selects and orders defaults. Modules under `src/` must remain feature-neutral and must not import or name bundled plugins; a bundled plugin's complete module graph must not import private core implementation under `src/`.

Use type-only imports from `@fx/tx/plugin`, standard Node.js or Bun APIs, and plugin-owned modules. Plugin-owned nonliteral dynamic imports of configured entry paths are allowed.

## Validate changes

Run `bun run check` to lint, type-check, test, and build. Add Bun tests for observable behavior and preserve 100% statement, function, and line coverage of production code.

For normative detail, see the [plugin system specification](../specs/plugin-system/) and [architecture specification](../specs/architecture/). The completed [external marketplace boundary change](../changes/0003-externalize-marketplace-plugin.md) records the implementation history.
