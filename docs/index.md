# Documentation

## Specs

| Spec | Description | Status |
|------|-------------|--------|
| [Architecture](specs/architecture/) | Generic core runtime, neutral composition, packaging, and development conventions for tx. | active |
| [Plugin System](specs/plugin-system/) | Generic plugin hosting and externalized marketplace-plugin ownership contracts. | active |

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
| 0008 | [Link Local Marketplace Sources](changes/0008-link-local-marketplace-sources.md) | [Plugin System](specs/plugin-system/) | draft | 0007 |
| 0009 | [Skip Quality Commands for Documentation](changes/0009-skip-quality-commands-for-documentation.md) | [Architecture](specs/architecture/) | complete | — |
