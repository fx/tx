# 0009: Skip Quality Commands for Documentation

## Summary

Make CI's first step decide whether a run's changed files are documentation only. If they are, the job reports success without installing dependencies or running the quality commands. Everything else runs exactly as it does today.

**Spec:** [Architecture](../specs/architecture/)
**Status:** in-progress
**Depends On:** —

## Motivation

A pull request that touches only `docs/` currently installs Bun, installs the lockfile, and runs Biome, TypeScript, the full test suite, and the production build — to prove that a Markdown file did not break a TypeScript build. It cannot have. The work is pure latency on every specification and manual change, and this repository produces a lot of those: seven of the last twenty commits touched only documentation.

The obvious fix — a `paths-ignore` filter — is a trap here, and worth writing down so nobody reaches for it later. The `main` ruleset requires the `CI` status check on every pull request. A workflow that does not run produces no check, and a required check that never reports leaves the pull request permanently blocked rather than exempt. The skip therefore has to happen *inside* a job that still reports, which is what this change does.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Those rules bind the repository's TypeScript. This change adds none — it changes a workflow file, which the Bun test runner does not execute and coverage does not measure. **That is a genuine gap, not an exemption**, so the behavior MUST be verified against real runs instead:

- The pull request implementing this change MUST itself run the full suite, because it changes `.github/workflows/ci.yml`, which is not documentation. A skipped run on this pull request is a defect in the detection logic.
- A documentation-only run MUST be observed reporting the `CI` check as successful with the dependency and quality steps skipped, and the observation MUST be recorded on the pull request.
- A run mixing documentation and source MUST be observed running the full suite.
- Verification MUST NOT be inferred from the workflow file. A step's `if:` expression reading correctly is not evidence that the step was skipped.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Architecture: Continuous Integration](../specs/architecture/index.md#continuous-integration) owns which runs execute the quality commands, the fail-safe behavior when the diff is unknown, and the requirement that the `CI` check still reports. Its scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- The job name MUST stay `CI`. The ruleset requires that exact context, and renaming the job silently unsatisfies it on every pull request.
- Checkout MUST fetch enough history to diff against the base commit. The default shallow checkout cannot see it.
- The detection step MUST run before the dependency setup step, so a documentation-only run installs nothing at all rather than installing and then skipping.
- `workflow_dispatch` has no base commit to compare against, so it MUST run the full suite. Release orchestration depends on a dispatched run being a real one — see [Architecture: Continuous Integration](../specs/architecture/index.md#continuous-integration).

## Design

### Approach

One step is added at the top of the existing job, and the three steps below it gain a condition. Nothing else moves.

The step resolves a base commit from the event: `pull_request` supplies the base SHA, `push` supplies the previous head. If neither is present or the commit is not in the local history — `workflow_dispatch`, a newly pushed branch whose `before` is all zeros, a force-push past the old head — detection stops and the full suite runs. The same happens for an empty diff. Every uncertain case resolves toward doing the work.

With a usable base, `git diff --name-only` produces the changed paths, and the run is documentation-only when every path is under `docs/` or ends in `.md`. The test is written as "does any path fall outside those" rather than "do all paths fall inside", so a new file type is treated as source by default rather than quietly slipping into the documentation set.

### Decisions

- **Decision:** Skip inside a job that still reports, rather than filtering the workflow's triggers.
  - **Why:** The `main` ruleset requires the `CI` context. A `paths-ignore` filter would produce no check for a documentation-only pull request, and a required check that never arrives blocks the merge — the opposite of the intent. Skipping inside the job keeps the contract satisfied while the expensive work is what actually goes away.
  - **Alternatives considered:** A second workflow exposing a stub `CI` job under an inverse path filter was rejected — a pull request touching both documentation and source matches both filters, so two checks named `CI` report and the weaker one adds nothing but confusion. Removing `CI` from the ruleset was rejected outright: it would drop the gate for source changes to buy latency on documentation ones.

- **Decision:** Treat "cannot tell" as "run everything".
  - **Why:** The failure modes are asymmetric. Running the suite unnecessarily costs about half a minute; skipping it on a diff that actually contained source changes lets an unverified commit through a required gate. Nothing about the second is worth the first.
  - **Alternatives considered:** Defaulting to skip when no base is available was rejected for exactly that reason.

- **Decision:** Define documentation as `docs/**` and `*.md`, and nothing else.
  - **Why:** Both are unambiguous, and everything under them is inert at build time. Extending the set to configuration, licences, or metadata files would start including things that can break a build.
  - **Alternatives considered:** Adding `LICENSE` and similar non-executable files was rejected as marginal benefit for a broader trusted set.

### Non-Goals

- Changing the release workflow, which dispatches CI explicitly and depends on that run being a full one.
- Skipping CI for any other class of change.
- Reducing what the quality commands do when they run.
- Editing the `main` ruleset. It keeps requiring `CI`, which is exactly why the skip lives inside the job.

## Tasks

- [ ] Skip the quality commands for documentation-only runs (PR #24)
  - [x] Add the detection step to `.github/workflows/ci.yml` as the first step after checkout, resolving the base from `pull_request` and `push` events and falling back to the full suite when it cannot (PR #24)
  - [x] Give checkout the history depth the diff needs (PR #24)
  - [x] Condition the Bun setup, dependency install, and `bun run check` steps on the detection result, keeping the job named `CI` (PR #24)
  - [x] Amend [Architecture: Continuous Integration](../specs/architecture/index.md#continuous-integration) with the skip, the fail-safe rule, and the requirement that the check still reports (PR #24)
  - [ ] Verify on this pull request that the full suite runs, since it changes a workflow file
  - [ ] Verify on a documentation-only pull request that `CI` reports success with the dependency and quality steps skipped, and record the observation
  - [ ] Verify that a pull request touching documentation and source runs the full suite

The three verification tasks stay open. They require observing real workflow runs, and GitHub Actions is in an active incident that has produced no `pull_request` run since 18:32 UTC — including on this pull request. Marking them complete without a run to point at is exactly the inference the Testing Requirements forbid.

## Open Questions

- [ ] Should the release workflow's dispatched CI run assert that it was not a documentation-only skip? It cannot be one today, because `workflow_dispatch` has no base to compare against and always runs in full — but that is an implicit dependency rather than an asserted one.

## References

- Spec: [Architecture](../specs/architecture/)
- External: [GitHub Actions: pull_request event payload](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request), [GitHub Actions: job step conditions](https://docs.github.com/en/actions/using-jobs/using-conditions-to-control-job-execution)
