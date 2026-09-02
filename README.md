# tx

Extensible command-line toolbox.

## Install

The first supported release target is Linux x64 with glibc and a baseline x86-64 CPU. The standalone executable does not require Bun or Node.js.

The low-setup installation path uses the public GitHub Release asset:

```sh
mise use -g github:fx/tx
```

Verify the installation:

```sh
tx --version
```

### GitHub Packages

`@fx/tx` is also published to `npm.pkg.github.com`. GitHub requires authentication to download npm packages even when the package is public. Create a classic personal access token with `read:packages`, then configure npm without committing the token:

```sh
npm config set @fx:registry https://npm.pkg.github.com
npm config set --location=user //npm.pkg.github.com/:_authToken "$GITHUB_PACKAGES_TOKEN"
npm install -g @fx/tx
```

The same authenticated registry configuration supports mise's npm backend:

```sh
mise use -g npm:@fx/tx
```

Prefer `mise use -g github:fx/tx` unless GitHub Packages integration is specifically required.

## Update

`tx update` updates everything `tx` has installed, including `tx` itself; `tx update --dry-run` reports the same thing and changes nothing.

```sh
tx update
tx update --dry-run
```

The executable is compared against the latest published release as a semantic version, and only a strictly newer one is offered. If a version manager installed `tx`, its own upgrade command is run for the tool that owns the path — `mise upgrade <tool>` or `npm install --global @fx/tx` — so the manager keeps recording what is actually on disk. That one command runs without the manager's minimum release age, so a release just published is not withheld from the command sent to install it, and it counts as applied only when the manager afterwards reports a newer version it had not already installed. Otherwise the published executable is downloaded, verified against its `SHA256SUMS` digest, run once to confirm its version, and moved into place in a single rename; nothing is replaced unless all of that succeeds. Set `GH_TOKEN` or `GITHUB_TOKEN` to raise the rate limit on the release lookup — no token is required, and no other variable is ever sent as one.

Running from a source checkout, or on a platform with no published executable, reports the newer release and applies nothing. `tx` never checks for updates on any other invocation. See the [plugin guide](docs/manual/plugins.md#update-what-is-installed) for the whole command.

## Plugins

Extend `tx` by installing a trusted Git marketplace:

```sh
tx marketplace add owner/repository
tx marketplace add owner/repository@1.4.0
tx marketplace list
tx marketplace remove repository
```

A source may carry a version, `<source>@<ref>`, naming a tag, a branch, or a commit the remote publishes; the marketplace stays there until you `tx marketplace pin` it elsewhere or `tx marketplace unpin` it. The separator is the last `@` outside the source's host, so `git@github.com:owner/repository.git` is an ordinary unpinned source.

Plugin authors import the public contract as types only:

```ts
import type { Plugin } from "@fx/tx/plugin";
```

Marketplace plugins, dependencies, and install scripts are not sandboxed and run with the same permissions as `tx`. Install only code you trust. See the [plugin guide](docs/manual/plugins.md) for repository setup and plugin authoring.

## Releases

[Release Please](https://github.com/googleapis/release-please-action) maintains the release PR, `package.json` version, tag, GitHub Release, and CHANGELOG from conventional commits. Release PRs are never auto-merged; a maintainer must review required CI and merge each one manually.

After the merge's push-to-main CI succeeds, the same release workflow invocation verifies the release SHA and version invariants, publishes the absent `@fx/tx` version to GitHub Packages, and uploads `tx-linux-x64` plus `SHA256SUMS` to the existing GitHub Release. Retries do not overwrite an existing package version; release assets may be replaced after verification.

Repository prerequisites are documented by the workflow permissions: Actions must be allowed to create pull requests, `GITHUB_TOKEN` must have package write access, the `CI` check remains required, and a maintainer must make the GitHub Package public after its first publication if public access is desired. The package visibility change and first release are manual operations.

## License

[MIT](LICENSE)
