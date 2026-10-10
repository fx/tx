/**
 * Versions and version ranges as a marketplace manifest declares them.
 *
 * A version is a semantic version exactly as Semantic Versioning 2.0.0 defines
 * one. A range is read by the grammar npm documents for its `semver` package,
 * in its default mode, and a version satisfies it exactly when that package
 * says it does. The range half is a port of that package's own algorithm
 * rather than a fresh grammar: its acceptance is defined by a sequence of
 * regular-expression rewrites, and only the same rewrites accept and reject
 * the same strings. Loose mode and `includePrerelease` are left out, because
 * the default mode is the only one a manifest is read in.
 *
 * Bun's built-in `Bun.semver.satisfies` is deliberately not used: it rejects
 * nothing, so a typo in a manifest would read as "every version", and it
 * evaluates some valid ranges differently from the reference implementation.
 *
 * Attribution: the range half of this module is derived from npm's `semver`
 * package (https://github.com/npm/node-semver) — its regular-expression
 * sources and their bounded forms, its range rewrites (hyphen ranges,
 * comparator, tilde, and caret trimming, caret, tilde, X-range, star, and
 * `>=0.0.0` replacement), its comparator parsing and limits, its
 * simplification of comparator sets and disjunctions, and its pre-release
 * rule for satisfaction. That package is distributed under the following
 * license:
 *
 * The ISC License
 *
 * Copyright (c) Isaac Z. Schlueter and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
 * IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

export interface SemanticVersion {
  /** Numeric components keep their digits, so precedence is exact however
   * long they are. */
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease: readonly string[];
  readonly build: readonly string[];
}

const strictVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const numericIdentifierPattern = /^[0-9]+$/;

function semanticVersion(
  match: RegExpMatchArray,
  offset: number,
): SemanticVersion {
  const prerelease = match[offset + 3];
  const build = match[offset + 4];
  return Object.freeze({
    major: match[offset] as string,
    minor: match[offset + 1] as string,
    patch: match[offset + 2] as string,
    prerelease: Object.freeze(prerelease ? prerelease.split(".") : []),
    build: Object.freeze(build ? build.split(".") : []),
  });
}

/** Reads a semantic version written exactly as the specification spells one:
 * no `v` prefix and no surrounding whitespace. */
export function parseSemanticVersion(
  text: string,
): SemanticVersion | undefined {
  const match = text.match(strictVersionPattern);
  return match ? semanticVersion(match, 1) : undefined;
}

/** Digit strings without leading zeros order by length, then by digit. */
function compareDigits(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = numericIdentifierPattern.test(left);
  const rightNumeric = numericIdentifierPattern.test(right);
  if (leftNumeric && rightNumeric) return compareDigits(left, right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Orders two versions by precedence. Build metadata never contributes. */
export function compareSemanticVersions(
  left: SemanticVersion,
  right: SemanticVersion,
): number {
  const main =
    compareDigits(left.major, right.major) ||
    compareDigits(left.minor, right.minor) ||
    compareDigits(left.patch, right.patch);
  if (main !== 0) return main;
  // A version without a pre-release outranks every pre-release of it.
  if (left.prerelease.length === 0)
    return right.prerelease.length === 0 ? 0 : 1;
  if (right.prerelease.length === 0) return -1;
  for (let index = 0; ; index++) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined && rightIdentifier === undefined) {
      return 0;
    }
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === undefined) return -1;
    const order = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (order !== 0) return order;
  }
}

// The reference implementation's limits. A range whose versions exceed them
// is invalid there, so it is invalid here too.
const maxLength = 256;
const maxSafeBuildLength = maxLength - 6;
const maxSafeInteger = Number.MAX_SAFE_INTEGER;

const letterDashNumber = "[a-zA-Z0-9-]";

/** The reference implementation bounds every unbounded repetition once its
 * input's whitespace is collapsed, and matches with the bounded forms. */
function bounded(source: string): string {
  let result = source;
  for (const [token, max] of [
    ["\\s", 1],
    ["\\d", maxLength],
    [letterDashNumber, maxSafeBuildLength],
  ] as const) {
    result = result
      .split(`${token}*`)
      .join(`${token}{0,${max}}`)
      .split(`${token}+`)
      .join(`${token}{1,${max}}`);
  }
  return result;
}

const numericIdentifier = "0|[1-9]\\d*";
const numericIdentifierLoose = "\\d+";
const nonNumericIdentifier = `\\d*[a-zA-Z-]${letterDashNumber}*`;
const mainVersion = `(${numericIdentifier})\\.(${numericIdentifier})\\.(${numericIdentifier})`;
const mainVersionLoose = `(${numericIdentifierLoose})\\.(${numericIdentifierLoose})\\.(${numericIdentifierLoose})`;
const prereleaseIdentifier = `(?:${nonNumericIdentifier}|${numericIdentifier})`;
const prereleaseIdentifierLoose = `(?:${nonNumericIdentifier}|${numericIdentifierLoose})`;
const prerelease = `(?:-(${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*))`;
const prereleaseLoose = `(?:-?(${prereleaseIdentifierLoose}(?:\\.${prereleaseIdentifierLoose})*))`;
const buildIdentifier = `${letterDashNumber}+`;
const build = `(?:\\+(${buildIdentifier}(?:\\.${buildIdentifier})*))`;
const fullPlain = `v?${mainVersion}${prerelease}?${build}?`;
const loosePlain = `[v=\\s]*${mainVersionLoose}${prereleaseLoose}?${build}?`;
const gtlt = "((?:<|>)?=?)";
const xRangeIdentifier = `${numericIdentifier}|x|X|\\*`;
const xRangePlain = `[v=\\s]*(${xRangeIdentifier})(?:\\.(${xRangeIdentifier})(?:\\.(${xRangeIdentifier})(?:${prerelease})?${build}?)?)?`;
const loneTilde = "(?:~>?)";
const loneCaret = "(?:\\^)";

const fullPattern = new RegExp(bounded(`^${fullPlain}$`));
const xRangePattern = new RegExp(bounded(`^${gtlt}\\s*${xRangePlain}$`));
const tildeTrimPattern = new RegExp(bounded(`(\\s*)${loneTilde}\\s+`), "g");
const tildePattern = new RegExp(bounded(`^${loneTilde}${xRangePlain}$`));
const caretTrimPattern = new RegExp(bounded(`(\\s*)${loneCaret}\\s+`), "g");
const caretPattern = new RegExp(bounded(`^${loneCaret}${xRangePlain}$`));
const comparatorPattern = new RegExp(bounded(`^${gtlt}\\s*(${fullPlain})$|^$`));
const comparatorTrimPattern = new RegExp(
  bounded(`(\\s*)${gtlt}\\s*(${loosePlain}|${xRangePlain})`),
  "g",
);
const hyphenRangePattern = new RegExp(
  bounded(`^\\s*(${xRangePlain})\\s+-\\s+(${xRangePlain})\\s*$`),
);
const starPattern = new RegExp(bounded("(<|>)?=?\\s*\\*"));
const greaterThanOrEqualZeroPattern = new RegExp(
  bounded("^\\s*>=\\s*0\\.0\\.0\\s*$"),
);
const buildStripPattern = new RegExp(build, "g");
const firstBuildPattern = new RegExp(bounded(build));

type Operator = "" | "<" | "<=" | ">" | ">=";

interface Comparator {
  readonly operator: Operator;
  /** Absent for the comparator that admits every version. */
  readonly version?: SemanticVersion;
  readonly value: string;
}

/** A parsed range: a disjunction of comparator sets. */
export interface VersionRange {
  readonly sets: readonly (readonly Comparator[])[];
}

function formatVersion(version: SemanticVersion): string {
  const main = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length === 0
    ? main
    : `${main}-${version.prerelease.join(".")}`;
}

/** A comparator's version, read with the reference implementation's limits. */
function comparatorVersion(text: string): SemanticVersion | undefined {
  if (text.length > maxLength) return undefined;
  const match = text.trim().match(fullPattern);
  if (!match) return undefined;
  const version = semanticVersion(match, 1);
  const exceeds = [version.major, version.minor, version.patch].some(
    (component) => Number(component) > maxSafeInteger,
  );
  return exceeds ? undefined : version;
}

function parseComparator(text: string): Comparator | undefined {
  const comp = text.trim().split(/\s+/).join(" ");
  const match = comp.match(comparatorPattern);
  if (!match) return undefined;
  const written = match[1] ?? "";
  const operator = (written === "=" ? "" : written) as Operator;
  if (!match[2]) return Object.freeze({ operator, value: "" });
  const version = comparatorVersion(match[2]);
  if (version === undefined) return undefined;
  return Object.freeze({
    operator,
    version,
    value: `${operator}${formatVersion(version)}`,
  });
}

const isX = (id: string | undefined): boolean =>
  !id || id.toLowerCase() === "x" || id === "*";

function replaceTilde(comp: string): string {
  return comp.replace(
    tildePattern,
    (_match, M: string, m?: string, p?: string, pr?: string) => {
      if (isX(M)) return "";
      if (isX(m)) return `>=${M}.0.0 <${+M + 1}.0.0-0`;
      if (isX(p)) return `>=${M}.${m}.0 <${M}.${Number(m) + 1}.0-0`;
      if (pr) return `>=${M}.${m}.${p}-${pr} <${M}.${Number(m) + 1}.0-0`;
      return `>=${M}.${m}.${p} <${M}.${Number(m) + 1}.0-0`;
    },
  );
}

function replaceCaret(comp: string): string {
  return comp.replace(
    caretPattern,
    (_match, M: string, m?: string, p?: string, pr?: string) => {
      if (isX(M)) return "";
      if (isX(m)) return `>=${M}.0.0 <${+M + 1}.0.0-0`;
      if (isX(p)) {
        return M === "0"
          ? `>=${M}.${m}.0 <${M}.${Number(m) + 1}.0-0`
          : `>=${M}.${m}.0 <${+M + 1}.0.0-0`;
      }
      const lower = pr ? `>=${M}.${m}.${p}-${pr}` : `>=${M}.${m}.${p}`;
      if (M !== "0") return `${lower} <${+M + 1}.0.0-0`;
      if (m !== "0") return `${lower} <${M}.${Number(m) + 1}.0-0`;
      return `${lower} <${M}.${m}.${Number(p) + 1}-0`;
    },
  );
}

function replaceXRange(text: string): string {
  const comp = text.trim();
  return comp.replace(
    xRangePattern,
    (
      matched,
      written: string,
      M: string,
      m: string | undefined,
      p: string | undefined,
    ) => {
      if ((isX(M) && !isX(m)) || (isX(m) && p && !isX(p))) return comp;

      const xM = isX(M);
      const xm = xM || isX(m);
      const xp = xm || isX(p);
      let operator = written === "=" && xp ? "" : written;

      if (xM) return operator === ">" || operator === "<" ? "<0.0.0-0" : "*";
      if (operator && xp) {
        let major = Number(M);
        let minor = xm ? 0 : Number(m);
        if (operator === ">") {
          // >1 => >=2.0.0, >1.2 => >=1.3.0
          operator = ">=";
          if (xm) major += 1;
          else minor += 1;
        } else if (operator === "<=") {
          // <=1.2.x admits every 1.2.x, so it is <1.3.0.
          operator = "<";
          if (xm) major += 1;
          else minor += 1;
        }
        return `${operator}${major}.${minor}.0${operator === "<" ? "-0" : ""}`;
      }
      if (xm) return `>=${M}.0.0 <${+M + 1}.0.0-0`;
      if (xp) return `>=${M}.${m}.0 <${M}.${Number(m) + 1}.0-0`;
      return matched;
    },
  );
}

function rewriteComparators(comp: string): string {
  const withoutBuild = comp.replace(firstBuildPattern, "");
  const carets = withoutBuild.trim().split(/\s+/).map(replaceCaret).join(" ");
  const tildes = carets.trim().split(/\s+/).map(replaceTilde).join(" ");
  const xRanges = tildes.split(/\s+/).map(replaceXRange).join(" ");
  return xRanges.trim().replace(starPattern, "");
}

function hyphenReplace(
  _match: string,
  from: string,
  fM: string,
  fm: string | undefined,
  fp: string | undefined,
  _fpr: string | undefined,
  _fb: string | undefined,
  to: string,
  tM: string,
  tm: string | undefined,
  tp: string | undefined,
  tpr: string | undefined,
): string {
  let lower: string;
  if (isX(fM)) lower = "";
  else if (isX(fm)) lower = `>=${fM}.0.0`;
  else if (isX(fp)) lower = `>=${fM}.${fm}.0`;
  else lower = `>=${from}`;

  let upper: string;
  if (isX(tM)) upper = "";
  else if (isX(tm)) upper = `<${+tM + 1}.0.0-0`;
  else if (isX(tp)) upper = `<${tM}.${Number(tm) + 1}.0-0`;
  else if (tpr) upper = `<=${tM}.${tm}.${tp}-${tpr}`;
  else upper = `<=${to}`;

  return `${lower} ${upper}`.trim();
}

const nullSetValue = "<0.0.0-0";

function parseComparatorSet(text: string): Comparator[] | undefined {
  const range = text
    .replace(buildStripPattern, "")
    .replace(hyphenRangePattern, hyphenReplace)
    .replace(comparatorTrimPattern, "$1$2$3")
    .replace(tildeTrimPattern, "$1~")
    .replace(caretTrimPattern, "$1^");

  const comparators: Comparator[] = [];
  for (const comp of range
    .split(" ")
    .map(rewriteComparators)
    .join(" ")
    .split(/\s+/)
    .map((comp) => comp.trim().replace(greaterThanOrEqualZeroPattern, ""))) {
    const comparator = parseComparator(comp);
    if (comparator === undefined) return undefined;
    comparators.push(comparator);
  }

  const nullSet = comparators.find(({ value }) => value === nullSetValue);
  if (nullSet !== undefined) return [nullSet];
  const distinct = new Map(
    comparators.map((comparator) => [comparator.value, comparator]),
  );
  if (distinct.size > 1) distinct.delete("");
  return [...distinct.values()];
}

/**
 * Reads a range by npm's grammar in its default mode, or answers `undefined`
 * for a string that grammar rejects. An empty string is the grammar's `*`.
 */
export function parseVersionRange(text: string): VersionRange | undefined {
  const raw = text.trim().replace(/\s+/g, " ");
  let sets: Comparator[][] = [];
  for (const alternative of raw.split("||")) {
    const set = parseComparatorSet(alternative.trim());
    if (set === undefined) return undefined;
    sets.push(set);
  }

  // The reference implementation simplifies a disjunction before testing it,
  // and the simplification is observable: a lone `*` alternative replaces the
  // whole range, which then admits no pre-release at all.
  if (sets.length > 1) {
    const first = sets[0] as Comparator[];
    sets = sets.filter((set) => set[0]?.value !== nullSetValue);
    if (sets.length === 0) sets = [first];
    else if (sets.length > 1) {
      const any = sets.find((set) => set.length === 1 && set[0]?.value === "");
      if (any !== undefined) sets = [any];
    }
  }
  return Object.freeze({
    sets: Object.freeze(sets.map((set) => Object.freeze(set))),
  });
}

function testComparator(
  comparator: Comparator,
  version: SemanticVersion,
): boolean {
  if (comparator.version === undefined) return true;
  const order = compareSemanticVersions(version, comparator.version);
  switch (comparator.operator) {
    case "":
      return order === 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
  }
}

function testSet(
  set: readonly Comparator[],
  version: SemanticVersion,
): boolean {
  if (!set.every((comparator) => testComparator(comparator, version))) {
    return false;
  }
  if (version.prerelease.length === 0) return true;
  // A pre-release satisfies a set only when the set itself names a
  // pre-release of the same major, minor, and patch version.
  return set.some(
    ({ version: named }) =>
      named !== undefined &&
      named.prerelease.length > 0 &&
      compareDigits(named.major, version.major) === 0 &&
      compareDigits(named.minor, version.minor) === 0 &&
      compareDigits(named.patch, version.patch) === 0,
  );
}

/** Whether a version satisfies a range, as npm's `semver` decides by default. */
export function satisfiesVersionRange(
  version: SemanticVersion,
  range: VersionRange,
): boolean {
  return range.sets.some((set) => testSet(set, version));
}

/**
 * Whether a version satisfies a range a manifest declares. No range admits
 * every version, pre-releases included; a version that is not a semantic
 * version satisfies no range.
 */
export function admitsVersion(
  range: string | undefined,
  version: string,
): boolean {
  if (range === undefined) return true;
  const parsedRange = parseVersionRange(range);
  const parsedVersion = parseSemanticVersion(version);
  return (
    parsedRange !== undefined &&
    parsedVersion !== undefined &&
    satisfiesVersionRange(parsedVersion, parsedRange)
  );
}
