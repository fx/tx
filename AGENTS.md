## Task Tracking

**You MUST load the `/project-management` skill before creating, modifying, or completing any task.** It owns all task-tracking rules and knows where tasks belong. Do not manage tasks without it.

## Code Review Rules

Read `REVIEW.md` at the repository root and apply it in full as the review rules for this repo. It is the canonical review-conventions file.

## Plugins

Follow the [plugin guide](docs/manual/plugins.md). Place bundled plugins under `plugins/<name>/` and compose ordered defaults only in root `cli.ts`; keep `src/` feature-neutral and keep plugin module graphs out of private `src/` implementation. Import `@fx/tx/plugin` and every published capability contract (`@fx/tx/config`, `@fx/tx/dialogs`, `@fx/tx/theme`, `@fx/tx/theme-override`, `@fx/tx/grid`) type-only — a published specifier is also the only way one bundled plugin may name another's vocabulary — add Bun tests for observable behavior, preserve required coverage, and run `bun run check`.
