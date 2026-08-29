# 0017: Add Dialog Text Input and Composition

## Summary

Add a text `input` dialog to the bundled dialogs capability and let a `select` option be marked as user-provided, so choosing it collects the values it declares and submits them with the selection. [Dialogs](../specs/dialogs/) owns the observable behavior of both.

**Specs:** [Dialogs](../specs/dialogs/)
**Status:** draft
**Depends On:** [0016](./0016-add-plugin-capabilities-and-dialogs.md)

## Motivation

The dialogs capability can ask which of a fixed set of things the user means, but not what the user wants when the answer is not in the set. A command that needs a branch name, a repository, or a version has no supported way to ask for it, and a command that offers known choices has no way to offer "something else" alongside them.

Collecting that value is only half the need. The interesting case is the two together: a list of known choices where one entry means "I will type it", which then asks for the value or values it needs and submits them with the choice. Making the caller run a select, inspect the result, and then run a separate input would work, but it puts the seam in the caller — two terminal sessions, two cancellations to reconcile, and a flicker between them — for an interaction the user experiences as one.

This change stops at that need. It does not build a form: one field type ships, fields are collected one at a time, and the model is shaped so a later field kind or multi-choice dialog is an addition rather than a redesign.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable rendering, entry, editing, submission, staging, cancellation, request-validation, stream-routing, and cleanup behavior MUST have automated tests.
- Dialog tests MUST use injected streams or controlled terminal doubles and MUST NOT read from or write to the process-global streams.
- `test/plugin-boundary.test.ts` MUST keep passing for the bundled plugin graph.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Dialogs](../specs/dialogs/) owns `input`, the field model, user-provided options, the select result, cancellation, stream routing, and cleanup. Its scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- **The capability stays internal and structural.** `input`, fields, and the select result are added to the provider's local types and to the compatible local types its bundled consumers declare. No dialog vocabulary enters `src/` or `@fx/tx/plugin`, and no dialogs module is exported.
- **`select` changes shape.** It resolves a result carrying the chosen value and the collected values rather than the bare value. Every existing caller and test consumer is updated in the same PR as the change to its return type; there is no external caller to migrate, and the spec's structural hedge already permits it.
- **Text entry is one implementation used twice.** The standalone `input` dialog and a field of a user-provided option render and behave identically; composition reuses that implementation rather than restating entry, editing, and submission behavior.
- **Composition is one render session.** A `select` that collects fields keeps the same renderer, terminal state, and stream adapters across its stages, so the existing cleanup-before-settlement contract applies once to the whole interaction rather than per stage.
- **Request validation happens before rendering.** The empty-field-list and duplicate-field-name rejections join the existing empty-options and non-interactive rejections, all before any terminal state changes.
- **The manual follows the implementation.** `docs/manual/plugins.md` documents each capability in the PR that ships it, so it never describes a surface that does not exist yet.

## Design

### Approach

`plugins/dialogs/index.ts` gains an `input` method alongside `select`. Both use the existing `InputAdapter`, `OutputAdapter`, and `FailureTracker` machinery unchanged: the render, race, and cleanup skeleton that `select` already has is what makes a second dialog cheap, so the entry component is the new part and the session handling is shared.

The entry component holds the current value, starting from the request's initial value, appends printable input, drops the last character on Backspace, resolves on Enter, and cancels on Escape or Ctrl-C. Standalone `input` renders that component alone. A `select` whose chosen option declares fields renders it once per field, in declared order, accumulating each submitted value under the field's name and rendering the next field only after the previous one is submitted. When the last field is submitted, the accumulated record and the chosen option's value settle the dialog together.

Because the stages share one render session, cancellation, rendering failure, and interaction failure reach the same `finally` block regardless of which stage was active, and the retry-and-report cleanup path is untouched.

### Decisions

- **Decision:** Compose inside the dialog rather than leaving the caller to run a select and then an input.
  - **Why:** The caller-side pattern makes every consumer reimplement the seam — reconciling two cancellations, deciding what a cancelled second dialog means for a completed first one, and tearing down and re-establishing raw mode between them. The interaction is one decision to the user, so the provider owns it and the caller receives one result.
  - **Alternatives considered:** A documented caller-side pattern was rejected because it duplicates state handling per consumer and produces a visible teardown between stages. A `prompt(options, thenFields)` helper wrapping both dialogs was rejected as the same seam with a shorter name.

- **Decision:** Escape or Ctrl-C at any stage cancels the whole dialog and resolves `undefined`; there is no return to the option list.
  - **Why:** Cancellation already has exactly one meaning in this capability, and the caller owns what it implies. Making Escape mean "go back" during field collection gives one key two meanings depending on state the caller cannot see, and Ctrl-C must never mean "go back". Back-navigation also implies a stage stack, retained partial values, and a rule for re-entering a field that was already answered — real surface with no consumer.
  - **Alternatives considered:** Returning to the select on cancel was rejected for the above. A distinct back key was rejected as unneeded now; because Escape keeps its single meaning, adding one later breaks nothing.

- **Decision:** `select` resolves `{ value, values }` for every completed selection, with an empty record for a plain option.
  - **Why:** The caller must be able to tell a plain choice from a user-provided one, and option values are opaque to the provider, so it cannot merge collected values into one. A uniform envelope means one return type to reason about instead of a union the caller cannot safely discriminate, since an opaque `T` may itself look like any envelope shape.
  - **Alternatives considered:** Returning `T` for plain options and an envelope for user-provided ones was rejected as undiscriminable against opaque values. Keeping `select` unchanged and adding a second composing method was rejected as two entry points for one interaction. Having the provider write collected values into the caller's value was rejected because it requires interpreting an opaque value.

- **Decision:** Fields are collected one at a time in declared order rather than presented together.
  - **Why:** Sequential collection needs no focus model, no Tab or Shift-Tab, no per-field cursor, and no partial-form validation, and it reuses the standalone input component exactly. Presenting fields together is the form this change deliberately is not.
  - **Alternatives considered:** A simultaneous multi-field form was rejected as the full form contract, which is out of scope.

- **Decision:** Keep the field model to a typed, named, ordered declaration with `text` as the only type.
  - **Why:** The type discriminator is the whole extension point: a dropdown or checkbox field later is a new type in the same list, not a new method or request shape, and a later multi-choice dialog reuses the same options and fields. Anything more — schemas, validators, required flags, conditional visibility — would be surface with no consumer and no test.
  - **Alternatives considered:** An untyped `{ name, message }` field was rejected because adding a second kind later would then be a breaking change. A validation callback per field was rejected as caller responsibility.

- **Decision:** Enter on an empty value resolves with the empty string.
  - **Why:** The provider does not know whether empty is meaningful; a caller asking for an optional suffix and a caller asking for a required name need different answers. `undefined` already means cancellation, so the two stay distinguishable.
  - **Alternatives considered:** Rejecting or ignoring an empty submission was rejected as required-field policy the caller owns. Resolving `undefined` for empty was rejected because it collapses cancellation and an intentional empty value.

- **Decision:** Include an optional initial value on a text request and field.
  - **Why:** The "provide it yourself" option is most useful pre-filled with the value the command already knows, and adding it later would change both request shapes.
  - **Alternatives considered:** Omitting it was rejected as a near-certain follow-up. A separate placeholder distinct from a starting value was rejected as rendering policy with no consumer.

- **Decision:** Multi-select stays out.
  - **Why:** The capability has no consumer that needs several answers at once, and adding it would introduce toggle input, a selected-set rendering policy, empty-set semantics, and a per-selection field-collection order. The option and field model does not preclude it: a multi-choice dialog reuses the same declarations and returns several results.
  - **Alternatives considered:** Shipping multi-select alongside composition was rejected as scope the request explicitly excluded.

### Non-Goals

- Multi-select or any multi-choice dialog.
- A form presenting several fields at once, focus movement between fields, or Tab and Shift-Tab navigation.
- Field types other than `text`, including dropdown, checkbox, numeric, masked, and multi-line fields.
- Validation, required-field policy, error messaging, re-prompting after a rejected value, or conditional field visibility.
- Caret movement, word or line deletion, clipboard integration, paste-specific handling, entry history, completion, or character masking.
- Returning to an earlier stage, partial results, or a back-navigation key.
- A confirm dialog or any dialog beyond `select` and `input`.
- A public or externally stable dialogs package, type export, or runtime export.
- Non-interactive fallback, concurrent or nested dialogs, and multi-provider selection policy.
- A permanent demo command or a dialogs command namespace.

## Tasks

- [x] Add the text input dialog to the bundled dialogs provider
  - [x] Add `input` to the local `Dialogs` shape in `plugins/dialogs/index.ts`, reusing the existing stream adapters, failure tracking, and render session
  - [x] Implement the entry component: initial or empty starting value, printable append including a multi-character chunk appended whole, Backspace removal with an empty-value no-op, an unchanged value for any other input, Enter submission including the empty string, and Escape or Ctrl-C cancellation
  - [x] Reject a non-interactive request before rendering, render only on injected standard error, and complete cleanup before settlement on submission, cancellation, and failure
  - [x] Add controlled Bun tests for rendering, initial values, entry and editing, empty submission versus cancellation, stream routing, failures, and cleanup
  - [x] Document the standalone `input` dialog in `docs/manual/plugins.md`
  - [x] Verify 100% coverage and `bun run check`

- [ ] Compose select with input through user-provided options
  - [ ] Add the field declaration to `SelectOption` and change `select` to resolve a result carrying the chosen value and the collected values, updating existing callers and test consumers
  - [ ] Reject an empty field list or a repeated field name within one option before rendering, alongside the existing empty-options and non-interactive rejections
  - [ ] Collect a chosen option's fields sequentially in declared order within the same render session, reusing the entry component, threading each field's optional initial value into it, and refusing option navigation once collection has begun
  - [ ] Resolve after the last field with the option's exact value and one collected value per field name, and resolve `undefined` discarding collected values when the user cancels at any stage
  - [ ] Add controlled Bun tests for plain versus user-provided results, field ordering, multi-field collection, invalid field declarations, cancellation at each stage, and single-session cleanup
  - [ ] Document composition and the new select result in `docs/manual/plugins.md`
  - [ ] Keep the bundled plugin boundary and coverage gates passing
  - [ ] Verify 100% coverage and `bun run check`, then set this document's status to complete and sync `docs/index.yml` and `docs/index.md`

## Open Questions

None. Further field types, a form presenting several fields at once, and a multi-choice dialog require a concrete bundled consumer and a later specification change.

## References

- Specs: [Dialogs](../specs/dialogs/), [Plugin System](../specs/plugin-system/), [Architecture](../specs/architecture/)
- Related changes: [0016-add-plugin-capabilities-and-dialogs](./0016-add-plugin-capabilities-and-dialogs.md)
- Manual: [Plugins](../manual/plugins.md)
