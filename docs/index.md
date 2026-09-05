# Documentation

## Specs

| Spec | Description | Status |
|------|-------------|--------|
| [Architecture](specs/architecture/) | Generic core runtime, neutral composition, packaging, and development conventions for tx. | active |
| [Plugin System](specs/plugin-system/) | Generic plugin hosting, opaque capability registration, and externalized marketplace-plugin ownership contracts. | active |
| [Dialogs](specs/dialogs/) | Shared terminal dialogs supplied by a bundled plugin, covering single-choice selection with type-to-filter and a bounded viewport, aligned multi-cell option rows with headers, text input composed through user-provided options, and a themed Norton Commander presentation. | active |
| [Updates](specs/updates/) | User-invoked updating of marketplaces and the executable through generic update participants, with automatic checking prohibited. | active |
| [Config](specs/config/) | Shared per-user JSON config persistence supplied by a bundled plugin, covering validated key definition, reads, writes, and atomic storage. | active |
| [Theming](specs/theming/) | Named appearance variables supplied by a bundled plugin, covering the default greyscale Norton Commander theme, plugin overrides, and colour enablement. | active |
| [Grid](specs/grid/) | Aligned cell layout supplied by a bundled plugin, covering table and flowed presentations, one-shot printing, interactive row selection, and row actions. | active |

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
| 0014 | [Pin Marketplace Versions](changes/0014-pin-marketplace-versions.md) | [Updates](specs/updates/) | complete | 0013 |
| 0015 | [Update the tx Executable](changes/0015-update-the-tx-executable.md) | [Updates](specs/updates/) | complete | 0012 |
| 0016 | [Add Plugin Capabilities and Dialogs](changes/0016-add-plugin-capabilities-and-dialogs.md) | [Dialogs](specs/dialogs/) | complete | — |
| 0017 | [Add Dialog Text Input and Composition](changes/0017-add-dialog-text-input-and-composition.md) | [Dialogs](specs/dialogs/) | complete | 0016 |
| 0018 | [Add Config Store and Marketplace Installs](changes/0018-add-config-store-and-marketplace-installs.md) | [Config](specs/config/) | complete | 0016 |
| 0019 | [Reduce Marketplace Clone Footprint](changes/0019-reduce-marketplace-clone-footprint.md) | [Plugin System](specs/plugin-system/) | complete | — |
| 0020 | [Add Select Filter and Viewport](changes/0020-add-select-filter-and-viewport.md) | [Dialogs](specs/dialogs/) | complete | 0017 |
| 0021 | [Restyle Dialogs as Norton Commander](changes/0021-restyle-dialogs-as-norton-commander.md) | [Dialogs](specs/dialogs/) | complete | 0020 |
| 0022 | [Exempt and Verify the tx Self-Update](changes/0022-exempt-and-verify-the-tx-self-update.md) | [Updates](specs/updates/) | complete | 0015 |
| 0023 | [Render Sub-Dialogs as Columns](changes/0023-render-sub-dialogs-as-columns.md) | [Dialogs](specs/dialogs/) | complete | 0021 |
| 0024 | [Relocate and Cover the Demo](changes/0024-relocate-and-cover-the-demo.md) | [Architecture](specs/architecture/) | draft | — |
| 0025 | [Guarantee Cell Width by Construction](changes/0025-guarantee-cell-width-by-construction.md) | [Dialogs](specs/dialogs/) | draft | — |
| 0026 | [Add Theme Variables](changes/0026-add-theme-variables.md) | [Theming](specs/theming/) | draft | — |
| 0027 | [Add Multi-Cell Select Rows](changes/0027-add-multi-cell-select-rows.md) | [Dialogs](specs/dialogs/) | draft | 0025 |
| 0028 | [Add the Grid Plugin](changes/0028-add-the-grid-plugin.md) | [Grid](specs/grid/) | draft | 0026 |
| 0029 | [Add Interactive Grid Row Actions](changes/0029-add-interactive-grid-row-actions.md) | [Grid](specs/grid/) | draft | 0027, 0028 |
