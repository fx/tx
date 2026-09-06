/**
 * The published config contract: everything a plugin needs to type the value
 * it reads from the `@fx/tx/config` registry key, and nothing else.
 *
 * It is published at that same specifier, so the string a consumer passes to
 * the read and the string it imports this file from are one string rather than
 * two that have to be kept agreeing. A consumer that imported this instead of
 * restating it learns about a contract that moved when it builds rather than
 * when its command reaches for a member that is no longer there.
 *
 * It declares types alone — no imports, no statements, nothing that survives
 * compilation — which is what lets it be published under a `types` condition
 * with no runtime condition beside it. That is also what makes it reachable on
 * its own: the only exported copy of this shape used to sit in
 * `plugins/marketplace/configured.ts`, whose module pulls in the marketplace
 * manager and, behind it, `node:child_process`, `node:fs`, and the
 * marketplace's source and storage modules. Naming what a config value looks
 * like never needed any of that.
 *
 * Publishing the vocabulary does not publish the store behind it: a consumer
 * that can name `define`, `read`, and `write` still cannot persist anything
 * without the capability. Nothing here reads a file, resolves a path, or knows
 * where the document lives.
 */

/**
 * A consumer's own answer to whether a persisted value is the shape it
 * expected.
 *
 * The capability never infers one. Values arrive from a document a user may
 * hand-edit and a previous release may have written, so the guard is the whole
 * of what makes a read safe, and it is the consumer's because only the
 * consumer knows what its key means. Values are JSON encoded, so a guard
 * should accept only what survives a round trip in the form its consumer
 * expects.
 */
export type ConfigValidator<T> = (value: unknown) => value is T;

/**
 * The value registered under `@fx/tx/config`: small JSON values persisted
 * across invocations, scoped to the user rather than to a working directory.
 *
 * A key is declared before it is used rather than on first write, so a value
 * written by an earlier release, or typed in by hand, is checked by the same
 * guard the writer would have been held to. Keys are opaque strings compared
 * by exact equality — nothing here trims, normalizes, parses, namespaces, or
 * reserves one — and a second definition of the same key is rejected with the
 * first guard left in force.
 *
 * A read of a key with no property answers `undefined`; a read of one whose
 * persisted value fails its guard rejects, and affects no other key. A write
 * whose value fails its guard rejects and changes nothing on disk.
 */
export type Config = {
  define<T>(key: string, isValid: ConfigValidator<T>): void;
  read<T>(key: string): Promise<T | undefined>;
  write<T>(key: string, value: T): Promise<void>;
};
