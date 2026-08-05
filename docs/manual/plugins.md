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
    {
      "name": "reports",
      "entry": "plugins/reports/index.ts",
      "package": "plugins/reports/package.json"
    }
  ]
}
```

The `plugins` array must be non-empty. Give every entry a unique name that is one safe path component, and use a non-empty repository-relative entry path. Entries must resolve to regular files contained by the repository, including after symbolic links are resolved. A root `tx.marketplace.json` remains supported for older marketplaces, but `.tx/config.json` takes precedence when both exist.

A plugin needs no build step or package manifest. Without `package`, `tx` looks only for `package.json` beside the entry's real, fully resolved file path. It does not search parent directories, so a nested entry does not inherit a marketplace-root manifest. Use the optional `package` field to select an exact repository-relative `package.json` elsewhere in the marketplace. If `package` is present, its value must be a string. A valid contained override may point to an absent file to skip installation; non-string, empty, absolute, escaping, non-`package.json`, directory, broken-link, looping-link, and externally resolving values are errors that cause marketplace addition to fail.

Before installing anything, `tx` validates all entries and selected package candidates. Existing manifests are resolved to regular contained files, deduplicated by real path, and installed sequentially in first plugin occurrence order with `bun install` running from each manifest's directory. Dependencies and install lifecycle scripts execute unsandboxed with `tx`'s permissions.

## Write a plugin

A plugin entry is a TypeScript module with a default export. Import the public contract as types only; `@fx/tx/plugin` does not provide a runtime API.

```ts
import type { Plugin } from "@fx/tx/plugin";

const plugin: Plugin = ({ command, context }) => {
  command((namespace) => {
    namespace.description("Greet people");

    namespace
      .command("hello")
      .description("Say hello")
      .argument("[name]", "who to greet")
      .option("--loud", "shout the greeting")
      .action((name: string | undefined, options: { loud?: boolean }) => {
        const greeting = `Hello, ${name ?? "world"}!`;
        context.stdout.write(
          `${options.loud ? greeting.toUpperCase() : greeting}\n`,
        );
      });
  });
};

export default plugin;
```

The initialization API provides an immutable `identity`, read-only `env`, the generic command `context`, shared `dependencies`, `command(build)`, and `plugin(childDefinition)`. The `context` carries process streams, environment, working directory, and the owning plugin identity, so your actions keep whatever signature you give them. Loading, initialization, and command actions may be asynchronous.

Use the initialization API's `dependencies.react` and `dependencies.ink` instead of importing separate runtime copies; the injected values share the host's React and Ink instances and include tx and dependency version metadata.

## One namespace per plugin

`command(build)` hands you your plugin's namespace: a command object named after your plugin's identity and already attached to the tree tx dispatches. Declaring commands, subcommands of any depth, arguments, options, and descriptions beneath it requires no parser dependency of your own. If you also want the parser itself — to build a detached command, share option definitions, or reuse its helpers — take it from `dependencies.commander` so you share the host's instance.

A few rules follow from the host owning the naming decision:

- A plugin that never calls `command` claims no namespace. A plugin that calls it claims exactly one, named after its own identity — never after a parent marketplace or plugin.
- An identity name that claims a namespace must be non-empty, must not contain whitespace, and must not begin with `-`. Names that break those rules are rejected rather than reshaped.
- Renaming the namespace or giving it an alias fails the plugin. Aliases on the commands you define beneath it are fine.
- Repeated `command(build)` calls accumulate onto the same namespace instead of replacing it.
- The builder must finish before it returns. An `async` builder is rejected, because the rest of its work would land after tx has already committed what you staged.
- A second plugin claiming a name that is already committed is rejected, and the diagnostic names both plugins.

## What tx interprets and what you own

tx resolves the first argument only. The host owns exactly two root options — help, spelled `--help` or `-h`, and version, spelled `--version` or `-V` — and recognizes either one only in that position; `tx --version extra` behaves exactly like `tx --version`. Any other first argument selects a plugin namespace, and every argument after it — including options tx itself defines, and including help requests — is yours to interpret. `tx notes --version` gives `--version` to the `notes` plugin. tx reserves no top-level `help` word, so a plugin may be named `help`.

Root help lists every claimed namespace with the description its owner supplied, and per-command help is generated from your declarations, so no plugin hand-writes a usage string.

Every byte the host writes — root help, generated usage, version, and parser diagnostics — goes through the injected context streams, and dispatch itself never terminates the process: help, version, and usage rejections all resolve to an exit code returned to the composition root. Write your own output through the `context` streams rather than `process.stdout` or `process.stderr`, and let your actions return or throw instead of calling `process.exit`; plugins are trusted code, so nothing stops you from bypassing either, and both guarantees are yours to keep inside your own actions.

## Exit codes

- `0` — a command action that returns, a version request (`--version`, `-V`), or any help a user asked for: `--help` and `-h` at any depth, and a `help` subcommand inside your namespace if you keep the parser's default one. Requested help prints on standard output.
- `1` — everything else: an unrecognized first argument, arguments your parser rejects, a namespace invoked without one of its subcommands, or an action that throws. tx does not distinguish usage failures from runtime failures by exit code.

Usage that a user did not ask for — the help printed because your namespace needed a subcommand and got none — prints on standard error and counts as a failure, exactly as `tx` with no arguments prints root help on standard error and exits non-zero.

Commands and child definitions registered during initialization form one atomic contribution; registration ends when initialization does. If loading, initialization, export validation, namespace validation, or collision detection fails, the plugin contributes nothing while healthy plugins can still dispatch. Failures are diagnosed on standard error and do not change the exit code of the command you ran, so a dispatched command keeps its own exit code — an action that succeeds still exits `0` — while a broken plugin is reported alongside it. Because a failed plugin claims nothing, invoking the namespace it would have owned is reported as an unknown command.

## Bundled plugins

Bundled feature plugins live under `plugins/<name>/`, conventionally at `plugins/<name>/index.ts`. Only the root `cli.ts` composition root selects and orders defaults. Modules under `src/` must remain feature-neutral and must not import or name bundled plugins; a bundled plugin's complete module graph must not import private core implementation under `src/`.

Use type-only imports from `@fx/tx/plugin`, standard Node.js or Bun APIs, and plugin-owned modules. Plugin-owned nonliteral dynamic imports of configured entry paths are allowed.

## Validate changes

Run `bun run check` to lint, type-check, test, and build. Add Bun tests for observable behavior and preserve 100% statement, function, and line coverage of production code.

For normative detail, see the [plugin system specification](../specs/plugin-system/) and [architecture specification](../specs/architecture/). The completed [external marketplace boundary change](../changes/0003-externalize-marketplace-plugin.md) records the implementation history.
