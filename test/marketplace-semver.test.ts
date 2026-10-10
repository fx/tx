import { describe, expect, test } from "bun:test";
import {
  admitsVersion,
  compareSemanticVersions,
  parseSemanticVersion,
  parseVersionRange,
  type SemanticVersion,
  satisfiesVersionRange,
} from "../plugins/marketplace/semver.ts";

function version(text: string): SemanticVersion {
  const parsed = parseSemanticVersion(text);
  if (parsed === undefined) throw new Error(`Not a version: ${text}`);
  return parsed;
}

/** Every range below is matched against each of these. */
const probes: readonly string[] = [
  "0.0.1",
  "0.0.2",
  "0.1.0",
  "0.1.5",
  "0.2.0",
  "1.0.0",
  "1.2.2",
  "1.2.3-beta.2",
  "1.2.3",
  "1.2.4",
  "1.3.0",
  "1.8.0",
  "1.8.0+build.7",
  "1.9.0",
  "2.0.0-rc.0",
  "2.0.0-rc.1",
  "2.0.0",
  "2.3.4",
  "3.0.0",
];

/**
 * Each range with exactly the probes it admits. The expected outcomes are
 * those of npm's reference `semver` package in its default mode, recorded from
 * that package rather than derived by hand, so the table is the reference
 * implementation's behavior and not this module's reading of it.
 */
const satisfaction: readonly (readonly [string, readonly string[]])[] = [
  ["1.8.0 1.9.0", []],
  [
    "*",
    [
      "0.0.1",
      "0.0.2",
      "0.1.0",
      "0.1.5",
      "0.2.0",
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0",
      "2.3.4",
      "3.0.0",
    ],
  ],
  [
    "",
    [
      "0.0.1",
      "0.0.2",
      "0.1.0",
      "0.1.5",
      "0.2.0",
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0",
      "2.3.4",
      "3.0.0",
    ],
  ],
  ["1.8.0", ["1.8.0", "1.8.0+build.7"]],
  ["=1.8.0", ["1.8.0", "1.8.0+build.7"]],
  ["v1.8.0", ["1.8.0", "1.8.0+build.7"]],
  [
    "<1.8.0",
    [
      "0.0.1",
      "0.0.2",
      "0.1.0",
      "0.1.5",
      "0.2.0",
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
    ],
  ],
  [
    "<=1.8.0",
    [
      "0.0.1",
      "0.0.2",
      "0.1.0",
      "0.1.5",
      "0.2.0",
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
    ],
  ],
  [">1.8.0", ["1.9.0", "2.0.0", "2.3.4", "3.0.0"]],
  [">=1.8.0", ["1.8.0", "1.8.0+build.7", "1.9.0", "2.0.0", "2.3.4", "3.0.0"]],
  [">= 1.8.0", ["1.8.0", "1.8.0+build.7", "1.9.0", "2.0.0", "2.3.4", "3.0.0"]],
  [
    "1.x",
    [
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
    ],
  ],
  ["1.2.x", ["1.2.2", "1.2.3", "1.2.4"]],
  [
    "1",
    [
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
    ],
  ],
  ["1.2", ["1.2.2", "1.2.3", "1.2.4"]],
  [
    "x",
    [
      "0.0.1",
      "0.0.2",
      "0.1.0",
      "0.1.5",
      "0.2.0",
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0",
      "2.3.4",
      "3.0.0",
    ],
  ],
  [
    "X",
    [
      "0.0.1",
      "0.0.2",
      "0.1.0",
      "0.1.5",
      "0.2.0",
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0",
      "2.3.4",
      "3.0.0",
    ],
  ],
  [">1", ["2.0.0", "2.3.4", "3.0.0"]],
  [
    ">1.2",
    ["1.3.0", "1.8.0", "1.8.0+build.7", "1.9.0", "2.0.0", "2.3.4", "3.0.0"],
  ],
  [
    "<=1.2",
    [
      "0.0.1",
      "0.0.2",
      "0.1.0",
      "0.1.5",
      "0.2.0",
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
    ],
  ],
  ["<1.x", ["0.0.1", "0.0.2", "0.1.0", "0.1.5", "0.2.0"]],
  [
    ">=1.x",
    [
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0",
      "2.3.4",
      "3.0.0",
    ],
  ],
  [
    "<=2.0.x",
    [
      "0.0.1",
      "0.0.2",
      "0.1.0",
      "0.1.5",
      "0.2.0",
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0",
    ],
  ],
  ["~1.2.3", ["1.2.3", "1.2.4"]],
  ["~1.2", ["1.2.2", "1.2.3", "1.2.4"]],
  [
    "~1",
    [
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
    ],
  ],
  ["~>1.2.3", ["1.2.3", "1.2.4"]],
  ["~0.1.0", ["0.1.0", "0.1.5"]],
  ["~1.2.3-beta.1", ["1.2.3-beta.2", "1.2.3", "1.2.4"]],
  ["^1.2.3", ["1.2.3", "1.2.4", "1.3.0", "1.8.0", "1.8.0+build.7", "1.9.0"]],
  [
    "^1.2",
    ["1.2.2", "1.2.3", "1.2.4", "1.3.0", "1.8.0", "1.8.0+build.7", "1.9.0"],
  ],
  [
    "^1",
    [
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
    ],
  ],
  ["^0.1.0", ["0.1.0", "0.1.5"]],
  ["^0.1", ["0.1.0", "0.1.5"]],
  ["^0.0.1", ["0.0.1"]],
  ["^0.0", ["0.0.1", "0.0.2"]],
  ["^0.x", ["0.0.1", "0.0.2", "0.1.0", "0.1.5", "0.2.0"]],
  ["^0", ["0.0.1", "0.0.2", "0.1.0", "0.1.5", "0.2.0"]],
  [
    "^1.2.3-beta.1",
    [
      "1.2.3-beta.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
    ],
  ],
  ["^2.0.0-rc.0", ["2.0.0-rc.0", "2.0.0-rc.1", "2.0.0", "2.3.4"]],
  [
    "^1.0.0 || ^2.0.0",
    [
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0",
      "2.3.4",
    ],
  ],
  [
    ">=1.0.0",
    [
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0",
      "2.3.4",
      "3.0.0",
    ],
  ],
  [
    "1.2.3 - 2.3.4",
    [
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0",
      "2.3.4",
    ],
  ],
  [
    "1.2 - 2.3",
    [
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0",
      "2.3.4",
    ],
  ],
  [
    "1.2.3 - 2",
    [
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0",
      "2.3.4",
    ],
  ],
  [
    "1.2.3-beta.1 - 2.0.0-rc.0",
    [
      "1.2.3-beta.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0-rc.0",
    ],
  ],
  [
    "x - 2",
    [
      "0.0.1",
      "0.0.2",
      "0.1.0",
      "0.1.5",
      "0.2.0",
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0",
      "2.3.4",
    ],
  ],
  ["1.8.0+build.1", ["1.8.0", "1.8.0+build.7"]],
  ["^1.8.0+build", ["1.8.0", "1.8.0+build.7", "1.9.0"]],
  [
    ">=1.0.0 <2.0.0",
    [
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
    ],
  ],
  [
    "<1.0.0 || >=2.0.0",
    ["0.0.1", "0.0.2", "0.1.0", "0.1.5", "0.2.0", "2.0.0", "2.3.4", "3.0.0"],
  ],
  [
    "* || >=2.0.0-rc.0",
    [
      "0.0.1",
      "0.0.2",
      "0.1.0",
      "0.1.5",
      "0.2.0",
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0",
      "2.3.4",
      "3.0.0",
    ],
  ],
  [
    ">=2.0.0-rc.0 || *",
    [
      "0.0.1",
      "0.0.2",
      "0.1.0",
      "0.1.5",
      "0.2.0",
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0",
      "2.3.4",
      "3.0.0",
    ],
  ],
  ["<0.0.0-0", []],
  [">*", []],
  ["1.2.3 || <0.0.0-0", ["1.2.3"]],
  [
    "  ^1.2.3  ",
    ["1.2.3", "1.2.4", "1.3.0", "1.8.0", "1.8.0+build.7", "1.9.0"],
  ],
  ["^ 1.2.3", ["1.2.3", "1.2.4", "1.3.0", "1.8.0", "1.8.0+build.7", "1.9.0"]],
  ["~ 1.2", ["1.2.2", "1.2.3", "1.2.4"]],
  [
    ">=0.0.0",
    [
      "0.0.1",
      "0.0.2",
      "0.1.0",
      "0.1.5",
      "0.2.0",
      "1.0.0",
      "1.2.2",
      "1.2.3",
      "1.2.4",
      "1.3.0",
      "1.8.0",
      "1.8.0+build.7",
      "1.9.0",
      "2.0.0",
      "2.3.4",
      "3.0.0",
    ],
  ],
];

describe("marketplace version ranges", () => {
  test.each(satisfaction)("%p admits exactly %p", (range, admitted) => {
    const parsed = parseVersionRange(range);
    expect(parsed).toBeDefined();
    expect(
      probes.filter((probe) =>
        satisfiesVersionRange(
          version(probe),
          parsed as NonNullable<typeof parsed>,
        ),
      ),
    ).toEqual([...admitted]);
  });

  // The first four are what Bun's own `Bun.semver.satisfies` was observed to
  // treat as matching 1.8.0; the reference implementation rejects them.
  test.each([
    "garbage",
    "latest",
    "^1.0.0 garbage",
    ">=1.0.0, <2",
    "1.2.3.4",
    "01.2.3",
    "1.2.3-01",
    ">=1.0.0 && <2",
    "1.0.0 ||| 2.0.0",
    "~1.2.3.4",
    "=>1.0.0",
    "<>1.0.0",
    "x.1",
    "1.x.3",
    "^1.2.3-",
    "1.2.3+",
    `>=${Number.MAX_SAFE_INTEGER + 2}.0.0`,
    `^${Number.MAX_SAFE_INTEGER}.0.0`,
    `1.0.0-${"a".repeat(260)}`,
  ])("rejects %p", (range) => {
    expect(parseVersionRange(range)).toBeUndefined();
  });

  test("never admits 1.8.0 for a string the grammar rejects or 1.8.0 1.9.0", () => {
    for (const range of [
      "garbage",
      "latest",
      "^1.0.0 garbage",
      ">=1.0.0, <2",
      "1.8.0 1.9.0",
    ]) {
      expect(admitsVersion(range, "1.8.0")).toBe(false);
    }
  });

  test("admits every version, pre-releases included, when no range is declared", () => {
    expect(admitsVersion(undefined, "2.0.0-rc.1")).toBe(true);
    expect(admitsVersion(undefined, "not a version")).toBe(true);
    // An explicit `*` is the grammar's, which admits no pre-release.
    expect(admitsVersion("*", "2.0.0-rc.1")).toBe(false);
  });

  test("admits nothing for a running version that is not a semantic version", () => {
    expect(admitsVersion("*", "v1.8.0")).toBe(false);
    expect(admitsVersion(">=1.0.0", "1.8")).toBe(false);
  });

  test("applies the pre-release rule in both directions", () => {
    expect(admitsVersion("^2.0.0-rc.0", "2.0.0-rc.1")).toBe(true);
    expect(admitsVersion(">=1.0.0", "2.0.0-rc.1")).toBe(false);
    expect(admitsVersion("^2.0.0", "2.0.0-rc.1")).toBe(false);
    expect(admitsVersion("^1.0.0 || ^2.0.0", "2.0.0-rc.1")).toBe(false);
    expect(admitsVersion("^2.0.0-rc.0", "2.0.0")).toBe(true);
    expect(admitsVersion("^2.0.0-rc.0", "2.1.0-rc.0")).toBe(false);
  });
});

describe("marketplace semantic versions", () => {
  test.each([
    "1.4.0",
    "0.0.0",
    "1.4.0-rc.1",
    "1.4.0-0a.1",
    "1.4.0+build.01",
    "1.4.0-alpha+001",
    "99999999999999999999999.0.0",
  ])("reads %p", (text) => {
    expect(parseSemanticVersion(text)).toBeDefined();
  });

  test.each([
    "v1.4.0",
    "=1.4.0",
    " 1.4.0",
    "1.4",
    "1.4.0.1",
    "01.4.0",
    "1.4.0-01",
    "1.4.0-",
    "1.4.0+",
    "1.4.0-a..b",
    "",
  ])("rejects %p", (text) => {
    expect(parseSemanticVersion(text)).toBeUndefined();
  });

  test("splits pre-release and build identifiers", () => {
    expect(parseSemanticVersion("1.4.0-rc.1+build.7")).toEqual({
      major: "1",
      minor: "4",
      patch: "0",
      prerelease: ["rc", "1"],
      build: ["build", "7"],
    });
  });

  test("orders by Semantic Versioning precedence, ignoring build metadata", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.1.0",
      "2.0.0",
      "10.0.0",
      "99999999999999999999999.0.0",
    ];
    for (const [index, left] of ordered.entries()) {
      for (const [other, right] of ordered.entries()) {
        expect(
          Math.sign(compareSemanticVersions(version(left), version(right))),
        ).toBe(Math.sign(index - other));
      }
    }
    expect(
      compareSemanticVersions(version("1.4.0+a"), version("1.4.0+b")),
    ).toBe(0);
  });
});
