# 0046: Adopt Upstream UI Controls

## Summary

Use the shared UI library's command and theme controls on the landing site.

**Spec:** [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** 0042

## Motivation

The site duplicates generic command-copy and theme-toggle controls that belong in the shared UI library. Tailwind must scan the application and the library's compiled entry explicitly.

## Requirements

Replace the local controls with the published `@fx/ui` APIs and scan the site source, root HTML, and library entry for Tailwind classes. Preserve the site's content, layout, branding, and tailnet development server binding. Retain 100% first-party site source coverage and verify the unified check and browser behavior. The final dependency must use an exact published preview, not a local file dependency.

## Tasks

- [x] Integrate the upstream controls and explicit Tailwind sources; verify against a local package build.
- [x] Pin the published preview and complete unified and browser verification.

## References

- [Architecture](../specs/architecture/)
