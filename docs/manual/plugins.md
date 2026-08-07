# Plugins

Plugins extend `tx` with commands and other plugins. Install only code you trust: plugins are not sandboxed and run with the same permissions as `tx`. Git clones, plugin modules, dependencies, and package lifecycle scripts are trusted execution surfaces; there is no signing, provenance, permissions, rollback, catalog, or automatic-update layer.

Install the Linux x64 standalone release with `mise use -g github:fx/tx`. Plugin authors who install `@fx/tx` from GitHub Packages for its public types must configure `npm.pkg.github.com` with a classic PAT that has `read:packages`; GitHub requires this authentication even for public npm packages. See the [installation guide](../../README.md#install).

## Install and manage marketplaces

A marketplace is a Git repository containing one or more plugins, or a local directory referenced live.

```sh
tx marketplace add owner/repository
tx marketplace add https://example.com/tools.git --name tools
tx marketplace add ./my-plugins
tx marketplace list
tx marketplace remove tools
```

`add` accepts any Git clone source. Bare `owner/repository` input expands to an HTTPS GitHub clone URL, and an HTTP(S) clone that fails is retried once over the SSH source derived from it, so a private repository installs from the shorthand. The installed name is derived from the source unless `--name` supplies one. The current repository is not auto-loaded; add it as a marketplace if you want `tx` to load its configuration.

## Private repositories over SSH

An HTTP(S) source is always tried over HTTP(S) first. If that clone fails, for any reason, `tx` derives the SSH source from it and clones once more under the same name. Nothing about a public marketplace changes; a private one installs from the shorthand, on the strength of the SSH key you already have.

The derived source is always `git@host:path`, in the SCP syntax a forge's own instructions are written in. Only the host and the path come from the HTTP(S) source: `https://alice@git.company.com/team/tools.git` derives `git@git.company.com:team/tools.git`, and `https://git.company.com:8443/team/tools.git` derives `git@git.company.com:team/tools.git` as well. A user in the source is an HTTPS credential rather than an SSH login — every forge answers SSH as `git` — and an HTTPS port is not an SSH port, so carrying either over would produce a source that cannot work. Percent-escapes in the path are decoded, because Git decodes them in a URL but not in SCP syntax. If you need another SSH login or a non-standard SSH port, give that SSH source yourself; `tx` does not guess it. Sources that are already `ssh://`, SCP syntax, `git://`, `file://`, or a plain path are cloned once, as they were typed.

Clone attempts run without Git's terminal prompt. Without that, a private HTTPS clone with no credential stops on the prompt and waits, and the SSH retry never happens. Credential helpers and `GIT_ASKPASS` are untouched, so a credential you have configured is still found and the HTTPS clone still succeeds. Only Git's own prompt is suppressed, and only while cloning — `marketplace list` and dependency installation are unaffected.

Every clone attempt runs `ssh -o BatchMode=yes` by default, so an unknown host key or a missing key fails rather than asking. That covers the first attempt as well as the SSH retry, because the first one can be an SSH connection too: an `url.<base>.insteadOf` rule rewrites an HTTP(S) source to SSH before Git dials, and ssh's own host-key and passphrase prompts go to the terminal, where turning off Git's prompt cannot reach them. On a clone that really does speak HTTP(S) the setting does nothing at all.

If you already configure an SSH command — through `GIT_SSH_COMMAND`, through `GIT_SSH`, or through Git's own `core.sshCommand` in your global or system configuration, which is how a CI job usually pins a deploy key — that command is used exactly as it stands, and none of the three is overridden. Yours is a deliberate invocation, an identity file, an alternate config, a proxy command, and `tx` has no business rewriting it. That includes its prompting behavior: a key whose passphrase is not already in your agent can still stop and ask. A `core.sshCommand` set in a single repository's own configuration does not count, because `git clone` never applies it — the clone creates its repository rather than joining the one you are standing in — so `tx` would be standing down for a command Git will not run.

When both attempts fail, the failure names both sources and carries both messages, so you can see which transport failed how. Any credential in the source's userinfo is taken back out of all of it — the sources it names and the Git output quoted between them, which repeats the clone URL with only the password removed.

## Local sources

`add` classifies its argument before doing anything else, without touching the network:

- An empty source is rejected, because resolving it would name whatever directory you are standing in.
- A source carrying a URL scheme or SCP-style `host:path` syntax — a colon ahead of the first slash, as Git itself reads one — goes to Git. A directory whose own name contains such a colon stays reachable as a local source through a path, such as `./host:path`.
- Otherwise the source is resolved against the working directory: an existing directory is a local source, an existing non-directory is an error, and a path that is genuinely absent goes to Git — which is what keeps `owner/repository` shorthand working. Only a missing path counts as absent; an unreadable ancestor or a link cycle is reported as itself rather than handed to `git clone`.
- Where a bare `owner/repository` argument also names an existing directory, the directory wins. The remote stays reachable by its full URL.

A local source is recorded as a live reference to the directory, never as a copy, so every later `tx` invocation reads whatever is on disk right now — edit a plugin and rerun it, with no commit, push, or reinstall. The reference is recorded against the source's fully resolved real path, so moving to another directory or repointing an intermediate symbolic link afterwards cannot redirect it. Without `--name`, the name comes from the final component of that real path exactly as it is on disk, so a directory called `tools.git` installs as `tools.git`.

`tx marketplace add ./repo` used to hand the path to `git clone`, installing a snapshot of the repository's checked-out commit. It now records a reference instead. To keep the old behavior, add the same path as a `file://` URL — classification leaves it with Git:

```sh
tx marketplace add "file://$PWD/repo"
```

A local source is validated and has its selected dependency manifests installed exactly as a clone does, except that `bun install` runs in your own directory rather than in a copy — that is the point of a live reference. It runs only when the marketplace is added; dependencies you add to the source afterwards are yours to install. If validation or installation fails, no reference is published and `tx` neither deletes nor rolls back your directory. That guarantee covers `tx`'s own cleanup only: install lifecycle scripts are trusted code running with `tx`'s permissions, so what they do to the tree they run in is outside it.

`marketplace list` reports a reference's recorded target path as its source, and `marketplace remove` removes only the reference, leaving the directory and its contents untouched. A reference whose target has been moved, deleted, or replaced stays listed and removable, and is reported through the recovery diagnostics that name its `marketplace remove` invocation.

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
