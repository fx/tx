# PR Review

## Critical: Trusted Marketplace Execution

Marketplace plugins are explicitly trusted code and execute with tx's permissions. Dependency-install lifecycle scripts are therefore not a sandbox boundary. Do not require arbitrary timeouts for Git or Bun operations unless the specification defines one.

## Task Cross-Reference

Cross-reference every PR against task lists in `docs/changes/` and `docs/tasks.md`. If the PR completes work tracked in those files, the task checkboxes MUST be updated in this same PR. Request changes if missing.

## Plugin Checklist

Use the [plugin guide](docs/manual/plugins.md) as the practical reference. For plugin changes, verify:

- Core and plugin ownership boundaries remain intact, including type-only use of `tx/plugin`.
- A failed plugin contributes nothing and does not block healthy plugins.
- Marketplace plugin names are unique and safe; configured entries are non-empty repository-relative regular files contained after resolution.
- React and Ink come from injected dependencies rather than separate runtime imports.
- Observable behavior has Bun tests, required coverage is preserved, and `bun run check` passes.
