import { describe, expect, test } from "bun:test";
import {
  automaticFilterThreshold,
  filterIsEnabled,
  visibleOptionIndices,
} from "../plugins/dialogs/filter.ts";

const labels = ["Alpha", "Beta", "Gamma", "Alphabet"] as const;

function options(...names: readonly string[]) {
  return names.map((label) => ({ label }));
}

describe("select filter enablement", () => {
  test("lets an explicit setting decide whatever the option count", () => {
    expect(filterIsEnabled(true, 1)).toBe(true);
    expect(filterIsEnabled(true, 100)).toBe(true);
    expect(filterIsEnabled(false, 1)).toBe(false);
    expect(filterIsEnabled(false, 100)).toBe(false);
  });

  test("turns itself on above the threshold and off at or below it", () => {
    expect(automaticFilterThreshold).toBe(8);
    for (const setting of ["auto", undefined] as const) {
      expect(filterIsEnabled(setting, 0)).toBe(false);
      expect(filterIsEnabled(setting, automaticFilterThreshold)).toBe(false);
      expect(filterIsEnabled(setting, automaticFilterThreshold + 1)).toBe(true);
    }
  });
});

describe("select option visibility", () => {
  test("leaves every option visible for blank and whitespace-only text", () => {
    for (const text of ["", "   ", "\t\n"]) {
      expect(visibleOptionIndices(options(...labels), text)).toEqual([
        0, 1, 2, 3,
      ]);
    }
  });

  test("matches a substring of the label without regard to case", () => {
    expect(visibleOptionIndices(options(...labels), "alp")).toEqual([0, 3]);
    expect(visibleOptionIndices(options(...labels), "ALP")).toEqual([0, 3]);
    expect(visibleOptionIndices(options(...labels), "mm")).toEqual([2]);
  });

  test("requires every whitespace-separated term, in any order", () => {
    const branches = options("release branch", "branch archive", "main");
    expect(visibleOptionIndices(branches, "branch rel")).toEqual([0]);
    expect(visibleOptionIndices(branches, "  branch   rel  ")).toEqual([0]);
    expect(visibleOptionIndices(branches, "branch")).toEqual([0, 1]);
    expect(visibleOptionIndices(branches, "branch zzz")).toEqual([]);
  });

  test("never matches against an option's value", () => {
    const carrying = [{ label: "Alpha", value: "zzz" }];
    expect(visibleOptionIndices(carrying, "zzz")).toEqual([]);
  });

  test("keeps an option that declares fields visible whatever the text", () => {
    const withEscape = [
      { label: "Alpha" },
      { label: "Other…", fields: [{ name: "branch" }] },
    ];
    expect(visibleOptionIndices(withEscape, "zzz")).toEqual([1]);
    expect(visibleOptionIndices(withEscape, "alpha")).toEqual([0, 1]);
  });

  test("preserves supplied order and keeps repeated labels apart", () => {
    const repeated = options("Same", "Other", "Same");
    expect(visibleOptionIndices(repeated, "same")).toEqual([0, 2]);
    expect(visibleOptionIndices(options("Beta", "Alpha"), "a")).toEqual([0, 1]);
  });
});
