# 0045: Organize Change History

## Summary

Group completed changes in the documentation navigation and triage historical open questions against current evidence while preserving their paths and links.

**Spec:** [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** None

## Motivation

The change index presents every completed proposal alongside current work, making navigation harder as history grows. Completed proposals also retain open questions whose answers may have landed later or whose next decision lacks an owner.

## Requirements

- Preserve all historical documents, paths, and inbound links. Keep the machine-readable index entries and dependency relationships intact.
- Group changes 0001–0041 in the human-readable index while keeping them navigable.
- Triage each unchecked historical question: link evidence for a resolved answer, or retain it with an owner and a concrete follow-up trigger. Do not claim a future behavior is implemented.
- Keep living specs authoritative and preserve proposal-time motivation.

## Non-Goals

- Implementing the future behaviors raised by questions, removing history, or moving historical files.

## Tasks

- [x] Group historical navigation without changing paths or machine-readable entries.
- [x] Triage historical open questions using later changes and living specifications.
- [x] Validate local links and index consistency and review the documentation diff.

## References

- [Documentation index](../index.md)
- [Architecture](../specs/architecture/)
