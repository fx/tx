# Plugins

Plugins extend `tx` with commands and other plugins. Install only code you trust: plugins are not sandboxed and run with the same permissions as `tx`. Git clones, plugin modules, dependencies, and package lifecycle scripts are trusted execution surfaces; there is no signing, provenance, permissions, rollback, catalog, or automatic-update layer.

Install the Linux x64 standalone release with `mise use -g github:fx/tx`. Plugin authors who install `@fx/tx` from GitHub Packages for its public types must configure `npm.pkg.github.com` with a classic PAT that has `read:packages`; GitHub requires this authentication even for public npm packages. See the [installation guide](../../README.md#install).

## Install and manage marketplaces

A marketplace is a Git repository containing one or more plugins, or a local directory referenced live.

```sh
tx marketplace add owner/repository
tx marketplace add https://example.com/tools.git --name tools
tx marketplace add owner/repository --full
tx marketplace add ./my-plugins
tx marketplace install
tx marketplace list
tx marketplace pin tools v1.4.0
tx marketplace unpin tools
tx marketplace remove tools
```

`list` prints one tab-separated line per marketplace: its name, its version label, and its source. `add` accepts any Git clone source, optionally with the `@<ref>` version described in [Marketplace versions](#marketplace-versions). Bare `owner/repository` input expands to an HTTPS GitHub clone URL, and an HTTP(S) clone that fails is retried once over the SSH source derived from it, so a private repository installs from the shorthand. The installed name is derived from the source unless `--name` supplies one. The current repository is not auto-loaded; add it as a marketplace if you want `tx` to load its configuration.

Every successful `marketplace add` records the installed marketplace in the
`marketplace` property of the [bundled config document](#use-the-bundled-config-capability),
and every successful `marketplace remove` removes its matching entry. The list
is ordered and can also be hand-seeded before anything is installed:

```json
{
  "marketplace": [
    { "source": "owner/repository" },
    { "source": "https://example.com/tools.git", "name": "tools" }
  ]
}
```

Run `tx marketplace install` explicitly to install every configured marketplace
that is missing. Already-installed names are left unchanged, and one failed
entry does not stop later entries from being attempted; any such failure makes
the overall command fail after the rest have run. The command validates and
resolves the complete list before installing anything, rejecting duplicate
effective names whether names are explicit or derived. It never writes the
config list and never runs automatically.

Write-back stores a Git source without URL userinfo credentials and retains its
`@<ref>` suffix. A local source is stored as its fully resolved real path, so a
later invocation from another working directory cannot redirect it. If config
read or write-back fails after an add or removal succeeded, the successful
marketplace mutation stands and the config failure is reported separately.

By default, a Git-sourced add starts with a partial, sparse clone. It materializes both supported manifest locations, then the directories containing the manifest's validated plugin entries and package selections. Commit history is unchanged; the reduction applies to repository file content and the checked-out tree. If Git or the remote cannot perform the reduced retrieval, tx starts a fresh complete clone of the same source. If a declared repository path exists but the sparse tree cannot resolve it — including a symbolic link whose target was not selected — tx expands that same checkout to the complete tree and validates again before reporting a failure.

Pass `--full` when a plugin imports repository content outside those manifest-derived directories. It skips the reduced attempt and clones the complete Git tree immediately. This option does not change local sources: a local directory remains a live reference and Git is never run for it.

## Private repositories over SSH

An HTTP(S) source is always tried over HTTP(S) first. If that clone fails, for any reason, `tx` derives the SSH source from it and clones once more under the same name. Nothing about a public marketplace changes; a private one installs from the shorthand, on the strength of the SSH key you already have.

The derived source is always `git@host:path`, in the SCP syntax a forge's own instructions are written in. Only the host and the path come from the HTTP(S) source: `https://alice@git.company.com/team/tools.git` derives `git@git.company.com:team/tools.git`, and `https://git.company.com:8443/team/tools.git` derives `git@git.company.com:team/tools.git` as well. A user in the source is an HTTPS credential rather than an SSH login — every forge answers SSH as `git` — and an HTTPS port is not an SSH port, so carrying either over would produce a source that cannot work. Percent-escapes in the path are decoded, because Git decodes them in a URL but not in SCP syntax. If you need another SSH login or a non-standard SSH port, give that SSH source yourself; `tx` does not guess it. Sources that are already `ssh://`, SCP syntax, `git://`, `file://`, or a plain path are cloned once, as they were typed.

Clone attempts run without Git's terminal prompt. Without that, a private HTTPS clone with no credential stops on the prompt and waits, and the SSH retry never happens. Credential helpers and `GIT_ASKPASS` are untouched, so a credential you have configured is still found and the HTTPS clone still succeeds. Only Git's own prompt is suppressed, and only while reaching a remote — cloning, and the fetch `tx update` performs, which needs it for a stronger reason: an update walks every marketplace you have, and one prompt would stall the run. Reading Git configuration, `marketplace list`, and dependency installation are unaffected.

Every clone attempt, and every fetch, runs `ssh -o BatchMode=yes` by default, so an unknown host key or a missing key fails rather than asking. On a clone, that default covers the first attempt as well as the SSH retry, because the first attempt can be an SSH connection too: an `url.<base>.insteadOf` rule rewrites an HTTP(S) source to SSH before Git dials, and ssh's own host-key and passphrase prompts go to the terminal, where turning off Git's prompt cannot reach them. On a clone that really does speak HTTP(S) the setting does nothing at all.

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

## Marketplace versions

`add` takes a version on the source, spelled the way every package manager spells one:

```sh
tx marketplace add fx/cc@1.4.0
tx marketplace add fx/cc@release/1.4
tx marketplace add git@github.com:fx/cc.git@v1.4.0
```

The ref is a commit-ish the remote publishes, resolved as a tag, then a branch, then a commit. A ref beginning with a digit is tried once more with a `v` prefix, so `@1.4.0` finds the `v1.4.0` tag almost every repository publishes, this project included. A ref that resolves nowhere fails the addition and installs nothing. The version never reaches the name: `fx/cc@1.4.0` installs as `cc`.

The separator is the last `@` outside the source's authority — the part Git reads to find the host — so an SSH login and an HTTP(S) credential are never read as one: `git@github.com:fx/cc.git` and `https://token@example.com/fx/cc.git` are unpinned sources. That is also what lets a ref contain `/`. A ref whose own *name* contains `@` cannot be written as a suffix, because nothing can tell which `@` you meant; give it to `tx marketplace pin`, where the ref is an argument of its own. Nothing is unreachable, and the failure is loud either way: the addition fails against the source it actually tried.

Classification runs first, so a version is only ever read from a source that is going to Git. A directory named `tools@2` is added as a live reference under that name, and `./tools@v1.0.0` beside a `./tools` directory is an error rather than a clone — a reference is live, so there is no version to pin it to.

A pin changes afterwards, and takes effect on the next update rather than moving the checkout itself:

```sh
tx marketplace pin cc v1.5.0
tx marketplace unpin cc
```

`pin` fetches first and refuses a ref the remote does not publish, leaving the previous pin exactly as it was, so a mistyped ref never silently unpins anything. It records without checking anything out, because moving a checkout runs validation and a trusted dependency installation — that is `tx update`'s job, and it carries `tx update`'s failure handling. `unpin` clears the pin and the marketplace tracks its remote's default branch again.

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

Gathering fetches, because there is no way to learn what a remote has without asking it, and a dry run whose answer is "probably" is not worth running. The fetch writes remote-tracking refs, tags, and the objects behind them, and nothing else, so the checkout, the working tree, and the dependencies installed beside them come out of a dry run untouched. Refs follow what the remote publishes now, in both directions: a tag its publisher moved moves, and a branch or tag they withdrew goes, so a pin is always answered against what is really there rather than against a ref only your copy still has. Fetching runs non-interactively, exactly as cloning does — an update walks every marketplace you have, and one credential or host-key prompt would stall the whole run. Reading Git configuration, `marketplace list`, and dependency installation keep your environment as it is.

Applying moves the checkout onto the target commit, detached, then validates the marketplace and installs its selected dependency manifests exactly as adding it would — the new commit may declare different plugins or different dependencies. For a marketplace installed with reduced retrieval, `tx` reads that target commit's manifest before moving and adds its entry and package directories to the existing sparse checkout. A checkout installed with `--full`, or one already expanded by an earlier fallback, stays complete: update never turns a complete checkout sparse. If target inspection or sparse expansion is unavailable, or a repository path can only be resolved against the complete tree, `tx` expands the same checkout and continues once; a successful fallback remains complete for later updates. Gathering and dry runs fetch and report only — they do not change the sparse-checkout set.

A marketplace whose checkout did not move is not revalidated. If validation, installation, or final version labeling fails, the checkout is put back on the commit it held and its exact pre-update sparse-checkout state is restored. Putting the commit back discards whatever the failed preparation rewrote — an install that rewrites a committed lockfile before failing would otherwise strand the marketplace on the commit that just failed — and nothing of yours is in that set, because the update refused to start unless the checkout was clean. If an untracked file blocks the move, the commit is never forced over it; the file survives and only a sparse expansion already attempted is rolled back. What a trusted installation already wrote outside the checkout's tracked files is not put back, and `tx` says so rather than claiming otherwise.

A fetch that fails is reported as Git reported it, with the credential of the recorded remote taken out of the message, so a marketplace installed from a source carrying a token does not print that token when its remote goes unreachable.

A [pinned](#marketplace-versions) marketplace targets what its pin resolves to now, rather than the remote's default branch. The pin names a ref and is re-resolved on every run, so a pin to a hash never moves, a pin to a branch moves with that branch, and a pin to a tag moves if its publisher moves the tag — tag immutability is the remote's contract, not `tx`'s. Every run reports the pin, and reports the highest release the remote publishes above it as detail, without proposing to apply it: you pinned a version, and being moved off it unasked would defeat the pin. "Higher" means higher as a semantic version, so a tag that is not one is never reported and a pin that is not one is compared against nothing; a pre-release is never reported, though you may pin to one and hear about the first ordinary release above it.

```
$ tx update --dry-run
tools	v1.4.0	up to date	pinned to v1.4.0; the remote publishes v1.5.0
```

A pin may move a checkout in either direction, because you named the commit — going back to the last version that worked is most of the reason to set one. Only an unpinned marketplace is held to moving forward. A pin naming a ref the remote has stopped publishing is reported as a failed item pointing at `tx marketplace pin` and `tx marketplace unpin`, not at removing the marketplace.

Two situations stop an update, and both are reported as detail on a dry run before they refuse anything for real:

- **A tracked file you edited.** The edit is yours and is never discarded. Resolve it in the checkout and run the update again. Untracked files are ignored, because `bun install` writes them into every checkout — except one occupying a path the new commit tracks, which cannot be kept and moved onto: that collision is reported with the path, and the file survives.
- **A commit that is not an ancestor of the target.** Moving anyway would silently discard the history the checkout was validated against, so an unpinned marketplace is refused — and which refusal you get says what happened. If the remote no longer has that commit anywhere, the branch was force-pushed or rebuilt, and `tx marketplace remove` and add it again is the remedy. If the remote still publishes it, on a side branch or at a tag, nothing is broken: that is where a pin left the checkout, so `tx marketplace pin` names it as the remedy first. A pinned marketplace is never refused for this — you named the commit.

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

## Use the bundled config capability

The namespace-free bundled config provider registers one internal capability under the exact opaque key `config`. It persists small JSON values across invocations in one per-user document. Its local structural shape is:

```ts
type ConfigValidator<T> = (value: unknown) => value is T

type Config = {
  define<T>(key: string, isValid: ConfigValidator<T>): void
  read<T>(key: string): Promise<T | undefined>
  write<T>(key: string, value: T): Promise<void>
}
```

A bundled consumer declares that compatible type locally and reads `registrations<Config>("config")` inside its command action, after initialization has committed every provider. The shape stays an implementation detail for bundled plugins; it is not a public export from `@fx/tx/plugin`.

Call `define` once for each key before reading or writing it in the current process. Keys are opaque and compared exactly: tx does not trim, normalize, parse, namespace, or reserve them. A second definition of the same key is rejected and leaves the first guard in force. An absent property reads as `undefined`; a present value and every value being written must pass that key's guard. A rejected read affects no other key, and a rejected write changes nothing on disk. Values use JSON encoding, so a guard should accept only values that survive a JSON round trip in the form the consumer expects.

The document is named `config.json` in the platform's `tx` user-data directory:

- `$XDG_DATA_HOME/tx/config.json` when `XDG_DATA_HOME` is an absolute path, otherwise `~/.local/share/tx/config.json`, on Linux and other non-Windows, non-macOS platforms.
- `~/Library/Application Support/tx/config.json` on macOS.
- `%LOCALAPPDATA%\tx\config.json` on Windows, falling back to `%APPDATA%\tx\config.json`, then `~/AppData/Local/tx/config.json`.

The file may be absent and is safe to hand-edit or pre-seed. Its top level must be a JSON object whose properties are config keys. Invalid JSON and every non-object root are reported rather than replaced. A write preserves every unrelated property, creates missing parent directories, and atomically replaces the document through a uniquely named temporary file beside it. Concurrent processes therefore leave a complete valid document, but they are not locked: both may read the same old object, and the later whole-document replacement may silently lose the earlier writer's change. Consumers needing merged concurrent writes need a different store.

There is no `tx config` command, key listing or deletion API, schema language, migration mechanism, encryption, or cross-process transaction.

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
    readonly filter?: boolean | "auto"
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

`select` additionally rejects an empty options list before rendering, and renders the message plus the label of every option the filter leaves visible that its viewport has room for, in supplied order. Labels are display text; values are opaque and returned by exact identity, with duplicates retained and the first option initially active.

Up and Down move one position among the visible options and clamp at the first and last of them. Home and End make the first and the last visible option active, and Page Up and Page Down move by the number of option rows on screen, clamped the same way. Enter on a plain option resolves `{ value, values }`, where `value` is that option's exact value and `values` is empty. Escape and Ctrl-C return `undefined` at every stage; the provider does not terminate the process, assign an exit code, or print the selected value. Input the dialog has no meaning for is ignored, and while the filter is disabled that includes printable characters.

`filter` decides whether the dialog offers a type-to-filter prompt: `true` and `false` decide whatever the option count, and an omitted setting means `"auto"`, which turns the filter on exactly when the request carries more than eight options. So a caller that never thinks about the filter still gets one when the list is long, and a caller whose short list is best unfiltered can say so.

When the filter is on it is the element typed text reaches from the moment the dialog opens; no key moves focus to or from it, and Up, Down, Enter, Escape, and Ctrl-C keep the meanings they have without it. Printable characters and Backspace edit the filter text exactly as they edit an `input` value, and the current text is rendered after a `›` prompt. The text's whitespace-separated pieces are its terms: an option is visible when every term occurs in its label under a case-insensitive comparison, so `rel 1.4` finds `release/1.4` in any term order. Matching is substring only — there is no fuzzy matching, ranking, match highlighting, matching against values, caller-supplied matcher, or initial filter text — so visible options keep the order and the duplicates the caller supplied. An option that declares `fields` is the caller's "let me type it" answer and stays visible whatever the text, since typing something nothing matches is exactly when it is needed. Changing the text makes the first visible option active. When nothing is visible the dialog renders `no match`, Enter and navigation do nothing, and Escape still cancels — Escape never clears the filter instead. Field collection stops filter edits along with navigation, and the filter text never appears in the result.

Every `select` renders its options through a viewport, filtered or not, so a long list neither overflows the terminal nor makes rendering cost grow with the option count. At most ten option rows appear at once, and fewer when the terminal is short: the window shrinks so that the whole dialog — its frame, its prompt, its overflow indicators, and its key hints — stays shorter than the terminal, which is what keeps it from clearing or scrolling away what was on screen before it opened. Choosing a user-provided option puts that field's own frame on screen underneath, so the window gives rows back on the frame that first draws it rather than reserving them the whole time; a terminal too short for one option row once the field arrives simply shows none while the field is collected. In a terminal too short for even one option row plus those other rows, the window gives up its last row rather than fill the screen: the dialog keeps its prompt and its hidden counts, still navigates, and still settles on a choice it can no longer draw, because a window the reader cannot see beats a terminal wiped out from under them. The window moves only as far as keeping the active option on screen needs, so the list stays still under the cursor bar rather than recentering on every keystroke, and it follows the terminal: a resize re-derives it. When visible options sit outside the window the dialog says so on that side and counts them, as `▲ N more` above and `▼ N more` below. The window is over the visible options, so it composes with the filter: its rows and its hidden counts describe what the filter left, not the list the caller supplied.

An option that declares `fields` is user-provided: choosing it collects those values instead of resolving immediately, so one dialog can offer known choices alongside "let me type it". An option declaring no fields is plain and resolves with an empty `values` record, which is how a caller tells the two apart. `select` rejects an option whose field list is empty, or that repeats a field name within itself, before rendering — alongside the empty-options and non-interactive rejections. Field names need only be unique within their own option, and only the chosen option is ever collected.

Fields are collected one at a time in declared order, each using the `input` behavior below, including its own `initialValue`. The next field appears only after the previous one is submitted, and the option list stops accepting navigation and selection the moment collection begins. After the last field, `select` resolves with the chosen option's exact value and one collected value per declared field, keyed by the field's name rather than by its displayed message. A name is an opaque key and may be any string, including one that shadows an inherited object property such as `__proto__`; the collected record carries it as an own property either way. Escape or Ctrl-C at any stage cancels the whole dialog, resolves `undefined`, and discards everything already collected: there is no return to the option list, no back-navigation key, and no partial result. A field's `type` is the extension point for a later field kind; `text` is the only one that exists, and there is no form presenting several fields at once, no focus movement, and no validation — a caller validates what it receives.

`input` collects a single line of text. It renders the message and the current value, starting from `initialValue` when one is supplied and from an empty value otherwise. Printable characters append in typed order; input arriving as one multi-character chunk, as a paste does, appends whole, minus any control characters it carries. Backspace drops the last character, counted by code point so a non-BMP character leaves whole, and does nothing when the value is empty. Any other input leaves the value unchanged: arrow keys, Tab, and Ctrl and Alt combinations append nothing. A control sequence Ink does not resolve to a key appends nothing when it arrives in the usual `CSI` form — Ink strips the leading escape before a handler sees it, so that case is recognized by shape, which is also why pasting exactly such a string, `[25~` on its own say, enters nothing. A modifier does not change what Enter, Escape, and Backspace themselves do, matching `select` — Alt-Enter still submits, and a double Escape still cancels. Enter returns the value exactly as entered, including the empty string, so an intentionally empty value stays distinguishable from the `undefined` that Escape and Ctrl-C return. The provider never trims, validates, or transforms the value and never writes it to standard output; whether an empty value is acceptable is the consuming command's decision. There is no caret movement, entry history, completion, or masking.

Both dialogs are drawn the way Norton Commander drew its panels, in greyscale. Each is a framed panel carrying its message as a title set into the top edge — the request message for a `select` or a standalone `input`, the field's own message for a field under collection — with a `select` in a double-line frame and an `input` or a field in a single-line frame. The active option is an inverted bar spanning the frame's inner width rather than a marker character, and the frame edges, the title, the `›` filter prompt, the `▲ N more` and `▼ N more` overflow indicators, and the key hint line are dimmed relative to option labels and entered text. That is the whole palette: the terminal's default foreground and background, their dimmed form, and their inversion. No hue is ever emitted, so a dialog looks the same on a light theme, a dark one, a sixteen-color terminal, and a true-color one, and there is nothing to configure.

A dimmed key hint line follows the lowest frame on screen: `↑↓ move · Enter select · type to filter · Esc cancel` under a `select`, without the filter phrase when the filter is off, and `Enter submit · Esc cancel` under an `input` or a field, which is the line shown while a field is collected because navigation and filtering have stopped by then. A frame is as wide as the wider of its title and its widest row, and never wider than the terminal; twenty columns is the narrowest terminal it lays out for, and how a narrower one wraps the result is unspecified. Nothing wraps: a title or a label too wide for the frame is truncated at its end with an ellipsis, while filter text and a value under entry are truncated at their start so their tail and the `█` caret drawn after them stay in view. Wrapping is what the truncation avoids — a label spilling onto a second row would change the number of rows the viewport counted on.

Three things move, and nothing else does. The `█` caret after entered text and after the filter alternates between visible and hidden about twice a second while the dialog waits for input, keeping its cell either way so the panel never resizes on its own timer; typing puts it straight back on its visible phase, so a keystroke is never answered by a row that looks like it lost its caret. An overflow indicator pulses between its dimmed and normal rendering on the same phase, and only while it is on screen at all — that is, only while the window is hiding rows. Confirming a plain option flashes the cursor bar before the dialog settles: the choice is recorded the moment Enter is pressed, every key from then on is ignored — Escape and Ctrl-C included, because the choice is already made — and the dialog settles well inside the 250 milliseconds the spec allows, on elapsed time rather than on any particular frame. Field collection is not confirmation and does not flash; it moves straight to the field.

A dialog animates on one subscription for all three, which is active exactly while a caret, an indicator, or a flash is on screen. So a select with the filter off, nothing hidden, and nothing confirmed runs no timer and writes nothing at all while it waits: it is on screen and quiet, not idling in a redraw loop. Animation never delays input either — a keystroke is reflected in the very next render whatever phase the caret is in — and the subscription belongs to the render session, so the unmount in the cleanup contract below is what stops it and no timer outlives a settled dialog.

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
