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

- Core and plugin ownership boundaries remain intact, including type-only use of `@fx/tx/plugin`.
- A failed plugin contributes nothing and does not block healthy plugins.
- Marketplace plugin names are unique and safe; configured entries are non-empty repository-relative regular files contained after resolution.
- React and Ink come from injected dependencies rather than separate runtime imports.
- `plugins/dialogs` intentionally uses `require("node:stream")` under pinned Bun 1.4 because every tested non-require loader creates a synthetic uncovered function; do not request conversion until Bun coverage is fixed or Ink is replaced.
- The text input dialog recognizes an unresolved control sequence by shape, because Ink strips the leading escape before `useInput` runs and exposes no flag saying it did. Provenance is unavailable: the same handler must append multi-character pastes, so length cannot discriminate either, and reading the raw stream would put a `data` listener on the stream Ink reads with `read()`. The shape test deliberately covers only the `CSI` form. Do not request exact escape detection, and do not request that `SS3` (`ESC O …`) join it: dropping every two-character chunk starting with `O` costs more than the unrecognized `SS3` keys it would catch.
- Observable behavior has Bun tests, required coverage is preserved, and `bun run check` passes.
