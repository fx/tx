# PR Review

## Critical: Trusted Marketplace Execution

Marketplace plugins are explicitly trusted code and execute with tx's permissions. Dependency-install lifecycle scripts are therefore not a sandbox boundary. Do not require arbitrary timeouts for Git or Bun operations unless the specification defines one.

## Task Cross-Reference

Cross-reference every PR against task lists in `docs/changes/` and `docs/tasks.md`. If the PR completes work tracked in those files, the task checkboxes MUST be updated in this same PR. Request changes if missing.

## Landing Site Dev Server

`site/` runs in a container and is reached from the maintainer's machine over a Tailscale tailnet, so its Vite dev server binds `0.0.0.0` deliberately. Do not request an interface-specific bind: `localhost` accepts only in-container connections, and a tailnet address is assigned per workspace, so committing one breaks every other checkout. This is a dev-only server and is never part of the published artifact — the Pages workflow deploys static output from `site/dist`.

DNS-rebinding protection stays on instead: `server.allowedHosts` is the `.ts.net` suffix rather than `true`, so tailnet hosts are accepted and everything else is rejected.

## Plugin Checklist

Use the [plugin guide](docs/manual/plugins.md) as the practical reference. For plugin changes, verify:

- Core and plugin ownership boundaries remain intact, including type-only use of `@fx/tx/plugin` and of every published capability contract (`@fx/tx/theme`, `@fx/tx/theme-override`, `@fx/tx/grid`). A bundled plugin may name another bundled plugin's vocabulary only through such a published specifier, never through a relative path into its directory; no module under `src/` may import one at all.
- A failed plugin contributes nothing and does not block healthy plugins.
- Marketplace plugin names are unique and safe; configured entries are non-empty repository-relative regular files contained after resolution.
- React and Ink come from injected dependencies rather than separate runtime imports.
- `plugins/dialogs` intentionally uses `require("node:stream")` under pinned Bun 1.4 because every tested non-require loader creates a synthetic uncovered function; do not request conversion until Bun coverage is fixed or Ink is replaced.
- The text input dialog recognizes an unresolved control sequence by shape, because Ink strips the leading escape before `useInput` runs and exposes no flag saying it did. Provenance is unavailable: the same handler must append multi-character pastes, so length cannot discriminate either, and reading the raw stream would put a `data` listener on the stream Ink reads with `read()`. The shape test deliberately covers only the `CSI` form. Do not request exact escape detection, and do not request that `SS3` (`ESC O …`) join it: dropping every two-character chunk starting with `O` costs more than the unrecognized `SS3` keys it would catch.
- `plugins/dialogs/columns.ts` lays a row of cells into exactly its column's width inside `cell()`, which pads or cuts — the same construction the single-label path has always used. A column too narrow even for the fixed two-space gaps between its fields (nine or more fields in the narrowest supported terminal) therefore ends in an ellipsis. That is construction, not the frame's row truncation rescuing an over-wide row: the frame never receives one, and `docs/specs/dialogs/index.md` requires only that the frame not be what makes a cell fit. Do not request that the layout drop or elide a whole field instead — `docs/changes/0027-add-multi-cell-select-rows.md` records eliding a field as a non-goal.
- "Namespace-free" describes a bundled capability provider plugin itself — it claims no CLI command namespace — and says nothing about how its registry key is spelled; a capability's key becoming `@fx/tx/<name>` records that its contract has been published, and a bare key merely means that capability's contract is not published yet. Do not request that the two be made consistent with each other.
- Observable behavior has Bun tests, required coverage is preserved, and `bun run check` passes.
