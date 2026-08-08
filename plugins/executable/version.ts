/**
 * Semantic version ordering for the published release against the running
 * executable. The project's versions are released by Release Please and are
 * semantic, so ordering them is well defined; comparing them as strings would
 * misorder `1.10.0` against `1.9.0`, and comparing them for inequality alone
 * would offer a "update" that drags a locally built executable backwards.
 */

export interface SemanticVersion {
  readonly release: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

/** A `v` prefix is accepted because the project's release tags carry one. */
const versionPattern =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const numericIdentifier = /^\d+$/;

export function parseVersion(text: string): SemanticVersion | undefined {
  const match = versionPattern.exec(text.trim());
  if (!match) return undefined;
  const [, major = "0", minor = "0", patch = "0", prerelease] = match;
  return {
    release: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease === undefined ? [] : prerelease.split("."),
  };
}

/** Numeric identifiers compare numerically and rank below alphanumeric ones,
 * which compare in ASCII order, exactly as the specification orders them. */
function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = numericIdentifier.test(left);
  if (leftNumeric !== numericIdentifier.test(right))
    return leftNumeric ? -1 : 1;
  if (leftNumeric) return Number(left) - Number(right);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** A version carrying no pre-release outranks one that does; two that both
 * carry one compare identifier by identifier, and the shorter run loses. */
function comparePrerelease(
  left: readonly string[],
  right: readonly string[],
): number {
  if (left.length === 0 || right.length === 0) {
    return (right.length === 0 ? 0 : 1) - (left.length === 0 ? 0 : 1);
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const order = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (order !== 0) return order;
  }
  return 0;
}

export function compareVersions(
  left: SemanticVersion,
  right: SemanticVersion,
): number {
  const [leftMajor, leftMinor, leftPatch] = left.release;
  const [rightMajor, rightMinor, rightPatch] = right.release;
  return (
    leftMajor - rightMajor ||
    leftMinor - rightMinor ||
    leftPatch - rightPatch ||
    comparePrerelease(left.prerelease, right.prerelease)
  );
}
