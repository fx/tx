# PR Review

## Critical: Trusted Marketplace Execution

Marketplace plugins are explicitly trusted code and execute with tx's permissions. Dependency-install lifecycle scripts are therefore not a sandbox boundary. Do not require arbitrary timeouts for Git or Bun operations unless the specification defines one.

## Task Cross-Reference

Cross-reference every PR against task lists in `docs/changes/` and `docs/tasks.md`. If the PR completes work tracked in those files, the task checkboxes MUST be updated in this same PR. Request changes if missing.
