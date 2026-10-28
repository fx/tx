# 0043: Fix Config Writes and Text Leaves

## Summary

Serialize writes through one config provider and keep text leaf caret animation active.

**Spec:** [Config](../specs/config/), [Dialogs](../specs/dialogs/)
**Status:** complete
**Depends On:** 0018, 0023

## Motivation

Concurrent writes through one config provider can overwrite unrelated keys because each reads an older document. A text leaf opened from a static select does not blink its caret because no animation is scheduled.

## Requirements

### Testing Requirements

This change MUST satisfy [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions):

- Tests MUST use Bun and cover new observable behavior.
- Production source MUST retain 100% statement, function, and line coverage; exclusions are limited to documented generated or non-executable files.
- Committed tests MUST NOT contain focused or skipped cases without a documented reason.
- Biome, TypeScript, and `bun run check` MUST pass.

Weakening these rules to land the change is a defect in the change.

### Functional Requirements

[Config: Reading and Writing](../specs/config/index.md#reading-and-writing) owns same-instance write ordering and failure recovery; [Dialogs: Presentation](../specs/dialogs/index.md#presentation) owns caret animation. The implementation fixes both behaviors without cross-process locking or changing other animations.

## Design

Each provider chains the entire read-modify-write operation, recovering its queue after a rejection. A select requests animation while a text leaf or collected field is on screen.

## Tasks

- [x] Fix config writes and text leaf animation
  - [x] Serialize same-provider writes and retain validation and failure recovery.
  - [x] Enable the leaf caret's existing animation.
  - [x] Test concurrent keys, ordering, recovery, persisted unrelated keys, and real Ink leaf blinking and cleanup.
  - [x] Update the config spec and both indexes.

## References

- [Config](../specs/config/)
- [Dialogs](../specs/dialogs/)
