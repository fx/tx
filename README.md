# tx

Toolbox

## Plugins

Extend `tx` by installing a trusted Git marketplace:

```sh
tx marketplace add owner/repository
tx marketplace list
tx marketplace remove repository
```

Marketplace plugins, dependencies, and install scripts are not sandboxed and run with the same permissions as `tx`. Install only code you trust. See the [plugin guide](docs/manual/plugins.md) for repository setup and plugin authoring.
