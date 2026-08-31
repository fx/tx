# Documentation

## Specs

| Spec | Description | Status |
|------|-------------|--------|
| [Architecture](specs/architecture/) | Generic core runtime, neutral composition, packaging, and development conventions for tx. | active |
| [Plugin System](specs/plugin-system/) | Generic plugin hosting, opaque capability registration, and externalized marketplace-plugin ownership contracts. | active |
| [Dialogs](specs/dialogs/) | Shared terminal dialogs supplied by a bundled plugin, covering single-choice selection and text input composed through user-provided options. | active |
| [Updates](specs/updates/) | User-invoked updating of marketplaces and the executable through generic update participants, with automatic checking prohibited. | active |
| [Config](specs/config/) | Shared per-user JSON config persistence supplied by a bundled plugin, covering validated key definition, reads, writes, and atomic storage. | active |

## Changes

| # | Change | Spec | Status | Depends On |
|---|--------|------|--------|------------|
| 0001 | [Bootstrap Core CLI](changes/0001-bootstrap-core-cli.md) | [Architecture](specs/architecture/) | complete | — |
| 0002 | [Add Plugin Marketplaces](changes/0002-add-plugin-marketplaces.md) | [Plugin System](specs/plugin-system/) | complete | 0001 |
| 0003 | [Externalize Marketplace Plugin](changes/0003-externalize-marketplace-plugin.md) | [Plugin System](specs/plugin-system/) | complete | 0002 |
| 0004 | [Automate Versioning and Publishing](changes/0004-automate-versioning-and-publishing.md) | [Architecture](specs/architecture/) | complete | 0003 |
| 0005 | [Install Per-Plugin Dependencies](changes/0005-install-per-plugin-dependencies.md) | [Plugin System](specs/plugin-system/) | complete | 0004 |
| 0006 | [Isolate Plugin Failure Exit Codes](changes/0006-isolate-plugin-failure-exit-codes.md) | [Plugin System](specs/plugin-system/) | complete | 0005 |
| 0007 | [Delegate Dispatch to Plugins](changes/0007-delegate-dispatch-to-plugins.md) | [Plugin System](specs/plugin-system/) | complete | 0006 |
| 0008 | [Link Local Marketplace Sources](changes/0008-link-local-marketplace-sources.md) | [Plugin System](specs/plugin-system/) | complete | 0007 |
| 0009 | [Skip Quality Commands for Documentation](changes/0009-skip-quality-commands-for-documentation.md) | [Architecture](specs/architecture/) | complete | — |
| 0010 | [Retry Marketplace Clones Over SSH](changes/0010-retry-marketplace-clones-over-ssh.md) | [Plugin System](specs/plugin-system/) | complete | 0008 |
| 0011 | [Resolve Plugin Dependencies By Node Rules](changes/0011-resolve-plugin-dependencies-by-node-rules.md) | [Plugin System](specs/plugin-system/) | complete | 0005 |
| 0012 | [Add a Generic Update Lifecycle](changes/0012-add-generic-update-lifecycle.md) | [Updates](specs/updates/) | complete | 0007 |
| 0013 | [Update Installed Marketplaces](changes/0013-update-installed-marketplaces.md) | [Updates](specs/updates/) | complete | 0012 |
| 0014 | [Pin Marketplace Versions](changes/0014-pin-marketplace-versions.md) | [Updates](specs/updates/) | draft | 0013 |
| 0015 | [Update the tx Executable](changes/0015-update-the-tx-executable.md) | [Updates](specs/updates/) | complete | 0012 |
| 0016 | [Add Plugin Capabilities and Dialogs](changes/0016-add-plugin-capabilities-and-dialogs.md) | [Dialogs](specs/dialogs/) | complete | — |
| 0017 | [Add Dialog Text Input and Composition](changes/0017-add-dialog-text-input-and-composition.md) | [Dialogs](specs/dialogs/) | complete | 0016 |
| 0018 | [Add Config Store and Marketplace Installs](changes/0018-add-config-store-and-marketplace-installs.md) | [Config](specs/config/) | draft | — |
