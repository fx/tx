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

`list` prints one tab-separated line per marketplace: its name, its version label, and its source. `add` accepts any Git clone source. Bare `owner/repository` input expands to an HTTPS GitHub clone URL, and an HTTP(S) clone that fails is retried once over the SSH source derived from it, so a private repository installs from the shorthand. The installed name is derived from the source unless `--name` supplies one. The current repository is not auto-loaded; add it as a marketplace if you want `tx` to load its configuration.

## Private repositories over SSH

An HTTP(S) source is always tried over HTTP(S) first. If that clone fails, for any reason, `tx` derives the SSH source from it and clones once more under the same name. Nothing about a public marketplace changes; a private one installs from the shorthand, on the strength of the SSH key you already have.

The derived source is always `git@host:path`, in the SCP syntax a forge's own instructions are written in. Only the host and the path come from the HTTP(S) source: `https://alice@git.company.com/team/tools.git` derives `git@git.company.com:team/tools.git`, and `https://git.company.com:8443/team/tools.git` derives `git@git.company.com:team/tools.git` as well. A user in the source is an HTTPS credential rather than an SSH login — every forge answers SSH as `git` — and an HTTPS port is not an SSH port, so carrying either over would produce a source that cannot work. Percent-escapes in the path are decoded, because Git decodes them in a URL but not in SCP syntax. If you need another SSH login or a non-standard SSH port, give that SSH source yourself; `tx` does not guess it. Sources that are already `ssh://`, SCP syntax, `git://`, `file://`, or a plain path are cloned once, as they were typed.

Clone attempts run without Git's terminal prompt. Without that, a private HTTPS clone with no credential stops on the prompt and waits, and the SSH retry never happens. Credential helpers and `GIT_ASKPASS` are untouched, so a credential you have configured is still found and the HTTPS clone still succeeds. Only Git's own prompt is suppressed, and only while reaching a remote — cloning, and the fetch `tx update` performs, which needs it for a stronger reason: an update walks every marketplace you have, and one prompt would stall the run. Reading Git configuration, `marketplace list`, and dependency installation are unaffected.

Every clone attempt, and every fetch, runs `ssh -o BatchMode=yes` by default, so an unknown host key or a missing key fails rather than asking. For a clone that covers the first attempt as well as the SSH retry, because the first one can be an SSH connection too: an `url.<base>.insteadOf` rule rewrites an HTTP(S) source to SSH before Git dials, and ssh's own host-key and passphrase prompts go to the terminal, where turning off Git's prompt cannot reach them. On a clone that really does speak HTTP(S) the setting does nothing at all.

If you already configure an SSH command — through `GIT_SSH_COMMAND`, through `GIT_SSH`, through Git's own `core.sshCommand` in your global or system configuration, or as command-scope configuration supplied by the environment (`GIT_CONFIG_COUNT` with its `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` entries), any of which is how a CI job usually pins a deploy key — that command is used exactly as it stands, and none of them is overridden. Yours is a deliberate invocation, an identity file, an alternate config, a proxy command, and `tx` has no business rewriting it. That includes its prompting behavior: a key whose passphrase is not already in your agent can still stop and ask. Which configuration files count depends on what is about to run, and the rule is the same one either way: a scope counts when Git will really apply it. A `core.sshCommand` set in a single repository's own configuration does not count for a clone, because `git clone` never applies it — the clone creates its repository rather than joining the one you are standing in — so `tx` would be standing down for a command Git will not run. It does count for the fetch behind `tx update`, which runs inside the installed checkout, where Git applies that checkout's own configuration and it outranks your global and system files: a deploy key you pinned in one marketplace's checkout is used, and is asked for first.

When both attempts fail, the failure names both sources and carries both messages, so you can see which transport failed how. The names are composed from your source with its userinfo cleared, so nothing can corrupt them, and the Git output quoted between them has every `userinfo@` run taken out — the URL you gave, the URL Git echoes with the password stripped, and the host-only form Git prints when a source has a username and no password. That covers the password in every shape Git spells it. A name that appears without its `@`, such as a server message naming the account, is left alone: deleting a bare identifier would rewrite the text around it and report repositories you never typed. A source that leaves the user out and carries its token as the password, `https://:token@host/path`, is covered the same way by its `:token@` run; an empty part of the userinfo is never removed on its own, because that would come to removing a bare `@` and would take one out of every host named. A single attempt that fails is reported exactly as Git reported it.

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

`marketplace list` reports a reference's recorded target path as its source and `live` as its version, and `marketplace remove` removes only the reference, leaving the directory and its contents untouched. A reference whose target has been moved, deleted, or replaced stays listed and removable, and is reported through the recovery diagnostics that name its `marketplace remove` invocation.

Marketplaces and their plugins execute in deterministic order: installed marketplace names are sorted, entries retain their manifest order, and the host initializes roots followed by contributed children in FIFO order.

## Update what is installed

`tx update` updates everything `tx` has installed. `tx update --dry-run` reports exactly the same thing and applies nothing, and positional names limit a run to the items you name.

```sh
tx update
tx update --dry-run
tx update tools
```

Gathering prints one tab-separated line per item — its name, its current version label, either `-> <version>` or `up to date`, and whatever detail its owner supplied — followed by one line per item that was applied. An item reporting nothing available is reported and left alone; nothing is asked to update it.

Results go to standard output and failures to standard error, so you can pipe one without losing the other. An item that reports itself as unusable is reported on standard error instead, with `failed: <reason>` in place of what it would have moved to, and is never applied. A name matching no gathered item is a failure too, and so is a participant that cannot report and an item whose update fails; each of those exits `1` while the rest of the run continues. Applying nothing is not a failure. A dry run exits `0` whether or not updates are available: the exit code answers "did the command work", not "is anything out of date".

`tx` never checks for updates on its own. No other invocation contacts a remote to learn what is available, caches a result, or prints a notice, and there is no flag or configuration key that turns such a check on.

### Updating marketplaces

Every installed marketplace is one item in `tx update`, named as it is installed. A cloned one reports the commit its checkout holds — a tag reachable from that commit where the repository publishes tags, an abbreviated hash where it does not — and what its remote's default branch now offers. A marketplace referenced from a local directory reports `live` and has nothing to apply: its contents are whatever the directory holds when you run `tx`, so nothing is fetched, moved, or modified. `marketplace list` reports the same label as its middle column, without contacting anything.

```
$ tx update --dry-run
tools	v1.4.0	-> v1.5.0
mine	live	up to date
```

Gathering fetches, because there is no way to learn what a remote has without asking it, and a dry run whose answer is "probably" is not worth running. The fetch writes remote-tracking refs and the objects behind them and nothing else, so the checkout, the working tree, and the dependencies installed beside them come out of a dry run untouched. Fetching runs non-interactively, exactly as cloning does — an update walks every marketplace you have, and one credential or host-key prompt would stall the whole run. Reading Git configuration, `marketplace list`, and dependency installation keep your environment as it is.

Applying moves the checkout onto the target commit, detached, then validates the marketplace and installs its selected dependency manifests exactly as adding it would — the new commit may declare different plugins or different dependencies. A marketplace whose checkout did not move is not revalidated. If validation or installation fails, the checkout is put back on the commit it held and the marketplace is reported as failed. Putting it back discards whatever the failed preparation rewrote — an install that rewrites a committed lockfile before failing would otherwise strand the marketplace on the commit that just failed — and nothing of yours is in that set, because the update refused to start unless the checkout was clean. What a trusted installation already wrote outside the checkout's tracked files is not put back, and `tx` says so rather than claiming otherwise.

A fetch that fails is reported as Git reported it, with the credential of the recorded remote taken out of the message, so a marketplace installed from a source carrying a token does not print that token when its remote goes unreachable.

Two situations stop an update, and both are reported as detail on a dry run before they refuse anything for real:

- **A tracked file you edited.** The edit is yours and is never discarded. Resolve it in the checkout and run the update again. Untracked files are ignored, because `bun install` writes them into every checkout — except one occupying a path the new commit tracks, which cannot be kept and moved onto: that collision is reported with the path, and the file survives.
- **A rewritten upstream.** If the commit you have is no longer an ancestor of the remote's, the branch was force-pushed or rebuilt, and moving anyway would silently discard the history the checkout was validated against. `tx marketplace remove` and add it again is the remedy.

A marketplace whose plugins fail to load updates like any other — the participant reads storage rather than depending on a marketplace having loaded, which is what makes `tx update` the way out of a broken commit. A checkout `tx` cannot read at all is reported as one failed item naming its `marketplace remove` remedy, while the marketplaces around it still report and still update.
### Updating tx itself

One of the items `tx update` gathers is `tx`, contributed by a bundled plugin that owns the running executable and defines no commands of its own. It compares the running version against the project's latest published release as a semantic version and offers only a strictly newer one, so a locally built executable is never dragged backwards. The lookup sends a token when `GH_TOKEN` or `GITHUB_TOKEN` is set — the first of those two that is non-empty, and no other variable is ever sent as one — which raises the rate limit; the release is public, so it works without either.

`tx` is composed last among the bundled plugins, so everything they own finishes updating before the binary is replaced. That ordering covers the bundled plugins only: a participant contributed by a plugin you installed through a marketplace is committed after every one of them, so it may be applied after the executable. Nothing needs it not to be — replacing the executable leaves the running process on the file it started from. How it is replaced depends on who owns the file:

- **A version manager owns it.** mise and npm are recognized from the executable's own resolved location, and from `MISE_DATA_DIR` or `MISE_INSTALLS_DIR` when either moves mise's store off the path that would announce it. The manager is asked which tool owns that path and its own upgrade command is run for that tool — `mise upgrade <tool>` or `npm install --global <package>` — and its output is reported. Nothing inside the manager's store is replaced by `tx`, because a manager that kept recording the old version would silently revert the update on its next install. A recognized manager that cannot be interrogated is a failure, not a reason to write into its store anyway.
- **Nobody owns it.** The published executable and its `SHA256SUMS` are downloaded, the digest is verified, and the file is staged beside the target with its executable bit set, run once to confirm it reports the published version, and moved onto the installed path in a single rename. Any mismatch aborts with the installed executable untouched, and every staged file is removed on every exit path. A location `tx` cannot write to is reported by name; `tx` never tries to acquire privileges.

Two conditions report the release as detail and offer nothing to apply, because applying would only be refused: running from a source checkout — where the running program is the Bun runtime, not `tx` — and a platform with no published executable. Neither is a failure, so `tx update` still exits `0` while your marketplaces update normally.

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

Imports in your plugin resolve exactly as they do in any other Bun or Node program: `exports` maps with their subpaths and conditions, `imports` maps, `main`, directory indexes, and the `node_modules` walk, with each dependency resolving its own dependencies the same way. Import a package by the name its `exports` map publishes rather than by a file path inside it — reaching past the map into a file the package does not publish fails, as it does everywhere else. Nothing is written to your marketplace directory to make this work, `import.meta` still names your own file, and resolution is the same whether `tx` is the released executable or a source checkout.

That applies to specifiers written literally, which is how a package is normally named. A specifier assembled at runtime — `await import(somePath)` — is left as a runtime import and behaves as it always has: a computed path to a file works, a computed package name does not. Write package names literally and you get the resolution above.

A plugin whose graph cannot be resolved does not load, and says which specifier it could not resolve. That is the whole plugin rather than the one import, so a missing dependency is reported when `tx` starts rather than when the command that needs it runs. Other plugins are unaffected.

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

The initialization API provides an immutable `identity`, read-only `env`, the generic command `context`, shared `dependencies`, `command(build)`, `plugin(childDefinition)`, `register(key, value)`, `registrations(key)`, `update(participant)`, and `updaters()`. The `context` carries process streams, environment, working directory, and the owning plugin identity, so your actions keep whatever signature you give them. Loading, initialization, and command actions may be asynchronous.

Use the initialization API's `dependencies.react` and `dependencies.ink` instead of importing separate runtime copies; the injected values share the host's React and Ink instances and include tx and dependency version metadata.

## Share generic capabilities

Plugins can share plugin-owned runtime capabilities through an opaque keyed registry. The public contract is generic and types-only:

```ts
register<T>(key: string, value: T): void
registrations<T>(key: string): readonly T[]
```

A provider declares its own structural type and registers a value during initialization. Registering a value alone claims no command namespace:

```ts
import type { Plugin } from "@fx/tx/plugin";

interface Formatter {
  format(value: string): string;
}

const formatter: Formatter = {
  format: (value) => value.toUpperCase(),
};

const plugin: Plugin = ({ register }) => {
  register<Formatter>("formatter", formatter);
};

export default plugin;
```

A consumer declares a compatible local type. Read inside a command action when the consumer needs every provider, because initialization is still in progress while plugins are loading:

```ts
import type { Plugin } from "@fx/tx/plugin";

interface Formatter {
  format(value: string): string;
}

const plugin: Plugin = ({ command, context, registrations }) => {
  command((namespace) => {
    namespace.action(() => {
      const formatters: readonly Formatter[] =
        registrations<Formatter>("formatter");
      for (const formatter of formatters) {
        context.stdout.write(`${formatter.format("hello")}\n`);
      }
    });
  });
};

export default plugin;
```

The registry contract is deliberately small:

- Keys are opaque strings compared by exact equality. tx does not reserve, trim, normalize, parse, namespace, or version them.
- Values are stored and returned unchanged. tx does not inspect, validate, invoke, clone, or freeze them; the generic type supplied to `registrations<T>` is only the caller's TypeScript assertion.
- Every registration remains present, including repeated keys and repeated values. Reads return matching values in FIFO commit order, preserving each plugin's call order and root/child initialization order; there is no selected winner.
- Each read returns a fresh frozen array containing entries committed at that moment. An absent key returns a fresh frozen empty array. The array is immutable, but the opaque values inside it are untouched.
- A plugin's registrations are staged with its commands, children, and update participants. They commit only after successful initialization and namespace validation; any loading, initialization, export, namespace, or collision failure discards the complete stage.
- A read during initialization sees earlier committed plugins only, not the reader's own stage or later plugins. A command-time read sees every provider that initialized successfully.
- Registration closes when initialization finishes. Calling `register` later is rejected; committed entries are append-only.

This is not a dependency-injection or lifecycle container. There are no schemas, runtime type checks, key factories, symbol tokens, ownership metadata, collision or duplicate policy, provider selection, priorities, versions, scopes, unregistering, replacement, subscriptions, events, factories, dependency ordering, disposal, health checks, retries, or caching. Failures while a consumer uses an opaque value belong to that consumer.

## Use the bundled dialogs capability

The namespace-free bundled dialogs provider registers one internal capability under the exact opaque key `dialogs`. Its current local structural shape is:

```ts
type TextField = {
  readonly type: "text"
  readonly name: string
  readonly message: string
  readonly initialValue?: string
}

type Dialogs = {
  input(request: {
    readonly message: string
    readonly initialValue?: string
  }): Promise<string | undefined>
  select<T>(request: {
    readonly message: string
    readonly options: readonly {
      readonly label: string
      readonly value: T
      readonly fields?: readonly TextField[]
    }[]
  }): Promise<
    | {
        readonly value: T
        readonly values: Readonly<Record<string, string>>
      }
    | undefined
  >
}
```

A bundled consumer declares that compatible type locally and reads `registrations<Dialogs>("dialogs")` inside its command action, after initialization has committed every provider. The provider and this shape are implementation details for bundled plugins, not public or stable exports from `@fx/tx/plugin`; an absent capability and multiple registered providers remain the consumer's responsibility, and tx defines no winner semantics.

Every dialog requires both the provider's injected standard input and standard error to be TTYs and rejects a non-interactive stream before rendering or changing terminal state; there is no fallback. Dialogs use the injected React and Ink instances, read only injected standard input, and render only on injected standard error, so standard output stays untouched for the consuming command.

`select` additionally rejects an empty options list before rendering, and renders the message plus every label in supplied order. Labels are display text; values are opaque and returned by exact identity, with duplicates retained and the first option initially active.

Up and Down move one position and clamp at the list boundaries. Enter resolves `{ value, values }`, where `value` is the active option's exact value. Escape and Ctrl-C return `undefined`; the provider does not terminate the process, assign an exit code, or print the selected value. Unrelated input is ignored.

An option that declares `fields` is user-provided: choosing it collects those values instead of resolving immediately, so one dialog can offer known choices alongside "let me type it". An option declaring no fields is plain and resolves with an empty `values` record, which is how a caller tells the two apart. `select` rejects an option whose field list is empty, or that repeats a field name within itself, before rendering — alongside the empty-options and non-interactive rejections. Field names need only be unique within their own option, and only the chosen option is ever collected.

Fields are collected one at a time in declared order, each using the `input` behavior below, including its own `initialValue`. The next field appears only after the previous one is submitted, and the option list stops accepting navigation and selection the moment collection begins. After the last field, `select` resolves with the chosen option's exact value and one collected value per declared field, keyed by the field's name rather than by its displayed message. Escape or Ctrl-C at any stage cancels the whole dialog, resolves `undefined`, and discards everything already collected: there is no return to the option list, no back-navigation key, and no partial result. A field's `type` is the extension point for a later field kind; `text` is the only one that exists, and there is no form presenting several fields at once, no focus movement, and no validation — a caller validates what it receives.

`input` collects a single line of text. It renders the message and the current value, starting from `initialValue` when one is supplied and from an empty value otherwise. Printable characters append in typed order; input arriving as one multi-character chunk, as a paste does, appends whole, minus any control characters it carries. Backspace drops the last character, counted by code point so a non-BMP character leaves whole, and does nothing when the value is empty. Any other input leaves the value unchanged: arrow keys, Tab, and Ctrl and Alt combinations append nothing. A control sequence Ink does not resolve to a key appends nothing when it arrives in the usual `CSI` form — Ink strips the leading escape before a handler sees it, so that case is recognized by shape, which is also why pasting exactly such a string, `[25~` on its own say, enters nothing. A modifier does not change what Enter, Escape, and Backspace themselves do, matching `select` — Alt-Enter still submits, and a double Escape still cancels. Enter returns the value exactly as entered, including the empty string, so an intentionally empty value stays distinguishable from the `undefined` that Escape and Ctrl-C return. The provider never trims, validates, or transforms the value and never writes it to standard output; whether an empty value is acceptable is the consuming command's decision. There is no caret movement, entry history, completion, or masking.

Both dialogs are built on the same render session and obey the same cleanup contract, and a `select` that collects fields is one such session for the whole interaction: it does not unmount, restore terminal state, or settle between its selection and field stages. Completion, cancellation, rendering failure, and interaction failure all finish renderer unmounting, restoration of the prior terminal/input state, listener teardown, and pending output before the promise fulfills or rejects. If an injected raw-mode disable, unref, or renderer unmount method persistently throws, the provider retries finitely and rejects with the first applicable cleanup failure; restoration or renderer teardown is necessarily best-effort only on that exceptional path. There is no non-interactive fallback, concurrency policy, nested-dialog support, or multi-provider selection policy.

## One namespace per plugin

`command(build)` hands you your plugin's namespace: a command object named after your plugin's identity and already attached to the tree tx dispatches. Declaring commands, subcommands of any depth, arguments, options, and descriptions beneath it requires no parser dependency of your own. If you also want the parser itself — to build a detached command, share option definitions, or reuse its helpers — take it from `dependencies.commander` so you share the host's instance.

A few rules follow from the host owning the naming decision:

- A plugin that never calls `command` claims no namespace. A plugin that calls it claims exactly one, named after its own identity — never after a parent marketplace or plugin.
- An identity name that claims a namespace must be non-empty, must not contain whitespace, and must not begin with `-`. Names that break those rules are rejected rather than reshaped.
- Renaming the namespace or giving it an alias fails the plugin. Aliases on the commands you define beneath it are fine.
- Repeated `command(build)` calls accumulate onto the same namespace instead of replacing it.
- The builder must finish before it returns. An `async` builder is rejected, because the rest of its work would land after tx has already committed what you staged.
- A second plugin claiming a name that is already committed is rejected, and the diagnostic names both plugins.

## Participate in updates

Anything your plugin installs on a user's behalf can appear in `tx update`. Contribute an update participant during initialization; the driver knows nothing about what you own, and you never learn about anyone else's.

```ts
import type { Plugin, UpdateItem } from "@fx/tx/plugin";

const plugin: Plugin = ({ update }) => {
  update({
    gather: async () => [
      { name: "tools", current: "1.0.0", available: "1.1.0", detail: "two commits behind" },
      { name: "notes", current: "3.2.0" },
    ],
    apply: async (item: UpdateItem) =>
      item.available === undefined
        ? { applied: false }
        : { applied: true, version: item.available },
  });
};

export default plugin;
```

- `gather` reports what you have. Leave `available` out when there is nothing to apply, and set `failure` on an item to report that one thing as unusable while your other items are still reported and applied. Gathering may contact a remote — that is what gathering is — but must change nothing installed, in a dry run or a real one.
- `apply` returns a result or throws. Returning `applied: false` means you deliberately changed nothing and is not a failure; throwing is, and neither one stops the items beside it. It is called only for an in-scope item that reported an `available` version and no `failure`, and never at all on a dry run.
- Version labels are opaque strings the driver never parses, compares, or orders. Deciding whether something is out of date is yours.
- Participants are staged with your commands and child definitions: a plugin that fails initialization contributes none. Contributing one claims no namespace, so a plugin may participate without defining a single command.
- `updaters()` returns what is committed at the moment you call it, so read it inside a command action rather than during initialization. Participants come back in the host's FIFO commit order, which for the bundled plugins is the order `cli.ts` composes them in.

## What tx interprets and what you own

tx resolves the first argument only. The host owns exactly two root options — help, spelled `--help` or `-h`, and version, spelled `--version` or `-V` — and recognizes either one only in that position; `tx --version extra` behaves exactly like `tx --version`. Any other first argument selects a plugin namespace, and every argument after it — including options tx itself defines, and including help requests — is yours to interpret. `tx notes --version` gives `--version` to the `notes` plugin. tx reserves no top-level `help` word, so a plugin may be named `help`.

Root help lists every claimed namespace with the description its owner supplied, and per-command help is generated from your declarations, so no plugin hand-writes a usage string.

Every byte the host writes — root help, generated usage, version, and parser diagnostics — goes through the injected context streams, and dispatch itself never terminates the process: help, version, and usage rejections all resolve to an exit code returned to the composition root. Write your own output through the `context` streams rather than `process.stdout` or `process.stderr`, and let your actions return or throw instead of calling `process.exit`; plugins are trusted code, so nothing stops you from bypassing either, and both guarantees are yours to keep inside your own actions.

## Exit codes

- `0` — a command action that returns, a version request (`--version`, `-V`), or any help a user asked for: `--help` and `-h` at any depth, and a `help` subcommand inside your namespace if you keep the parser's default one. Requested help prints on standard output.
- `1` — everything else: an unrecognized first argument, arguments your parser rejects, a namespace invoked without one of its subcommands, or an action that throws. tx does not distinguish usage failures from runtime failures by exit code.

Usage that a user did not ask for — the help printed because your namespace needed a subcommand and got none — prints on standard error and counts as a failure, exactly as `tx` with no arguments prints root help on standard error and exits non-zero.

Commands, child definitions, generic registry entries, and update participants contributed during initialization form one atomic contribution; registration ends when initialization does. If loading, initialization, export validation, namespace validation, or collision detection fails, the plugin contributes nothing while healthy plugins can still dispatch. Failures are diagnosed on standard error and do not change the exit code of the command you ran, so a dispatched command keeps its own exit code — an action that succeeds still exits `0` — while a broken plugin is reported alongside it. Because a failed plugin claims nothing, invoking the namespace it would have owned is reported as an unknown command.

## Bundled plugins

Bundled feature plugins live under `plugins/<name>/`, conventionally at `plugins/<name>/index.ts`. Only the root `cli.ts` composition root selects and orders defaults. Modules under `src/` must remain feature-neutral and must not import or name bundled plugins; a bundled plugin's complete module graph must not import private core implementation under `src/`.

Use type-only imports from `@fx/tx/plugin`, standard Node.js or Bun APIs, and plugin-owned modules. Plugin-owned nonliteral dynamic imports of configured entry paths are allowed.

## Validate changes

Run `bun run check` to lint, type-check, test, and build. Add Bun tests for observable behavior and preserve 100% statement, function, and line coverage of production code.

For normative detail, see the [plugin system specification](../specs/plugin-system/) and [architecture specification](../specs/architecture/). The completed [external marketplace boundary change](../changes/0003-externalize-marketplace-plugin.md) records the implementation history.
