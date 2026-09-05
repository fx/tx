import { describe, expect, test } from "bun:test";
import {
  filterIsShown,
  visibleOptionIndices,
} from "../plugins/dialogs/filter.ts";

const labels = ["Alpha", "Beta", "Gamma", "Alphabet"] as const;

function options(...names: readonly string[]) {
  return names.map((label) => ({ label }));
}

describe("select filter visibility", () => {
  test("shows itself once anything has been typed into it", () => {
    // Filtering is never off, so there is nothing here about whether typing
    // narrows the list — only about whether the filter is on screen before
    // anything has been typed.
    expect(filterIsShown("typed", "")).toBe(false);
    expect(filterIsShown("typed", "a")).toBe(true);
    expect(filterIsShown("typed", " ")).toBe(true);
  });

  test("shows itself from the start when the caller asks", () => {
    expect(filterIsShown("always", "")).toBe(true);
    expect(filterIsShown("always", "a")).toBe(true);
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

describe("matching an option's cells", () => {
  /** The cells of one column, as the matcher sees them: display text and
   * nothing else. */
  function rows(...cells: readonly (readonly string[])[]) {
    return cells.map((row) => ({ cells: row }));
  }

  const releases = rows(
    ["alpha", "beta"],
    ["release/1.4", "shipped"],
    ["release/2.0", "draft"],
  );

  test("matches a term within one cell, whichever cell that is", () => {
    expect(visibleOptionIndices(releases, "alpha")).toEqual([0]);
    expect(visibleOptionIndices(releases, "beta")).toEqual([0]);
    expect(visibleOptionIndices(releases, "shipped")).toEqual([1]);
    expect(visibleOptionIndices(releases, "RELEASE")).toEqual([1, 2]);
  });

  /**
   * The spec's own scenario, and the reason cells are matched individually
   * rather than joined: a term spanning the gap between two cells is a match
   * the reader can neither see nor predict, and matching the padded row is
   * exactly the caller-side failure this shape exists to remove.
   */
  test("never matches a term that spans the gap between two cells", () => {
    expect(visibleOptionIndices(releases, "alphab")).toEqual([]);
    expect(visibleOptionIndices(releases, "alpha  beta")).toEqual([0]);
  });

  /** Every term still has to match, and each may match in a different cell:
   * the terms are unordered against the row, not against one cell of it. */
  test("takes each term in any cell, and needs all of them", () => {
    expect(visibleOptionIndices(releases, "alpha bet")).toEqual([0]);
    expect(visibleOptionIndices(releases, "1.4 shipped")).toEqual([1]);
    expect(visibleOptionIndices(releases, "1.4 draft")).toEqual([]);
  });

  test("leaves every row visible for blank text", () => {
    expect(visibleOptionIndices(releases, "  ")).toEqual([0, 1, 2]);
  });

  /** A cell option's escape hatch is the same escape hatch: an option that
   * collects input is the caller's "none of these" answer whatever its display
   * text is, and a filter that could hide it would defeat it. */
  test("keeps a cell option that declares fields visible", () => {
    const withEscape = [
      { cells: ["alpha", "beta"] },
      { cells: ["Other…", ""], fields: [{ name: "branch" }] },
    ];
    expect(visibleOptionIndices(withEscape, "zzz")).toEqual([1]);
  });
});
