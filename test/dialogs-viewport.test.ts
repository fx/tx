import { describe, expect, test } from "bun:test";
import {
  maximumOptionRows,
  optionRowCount,
  optionWindow,
  selectChromeHeight,
} from "../plugins/dialogs/viewport.ts";

/** A terminal with room to spare, so a test about one bound is not answered by
 * another. */
const ROOMY = 40;

describe("select viewport height", () => {
  test("shows at most ten option rows however long the list", () => {
    expect(maximumOptionRows).toBe(10);
    expect(optionRowCount(30, ROOMY)).toBe(maximumOptionRows);
    expect(optionRowCount(300, 500)).toBe(maximumOptionRows);
  });

  test("shows no more rows than there are options to put in them", () => {
    expect(optionRowCount(3, ROOMY)).toBe(3);
    expect(optionRowCount(maximumOptionRows, ROOMY)).toBe(maximumOptionRows);
  });

  test("keeps the whole dialog strictly shorter than the terminal", () => {
    expect(selectChromeHeight).toBe(6);
    for (let rows = selectChromeHeight + 2; rows <= 20; rows++) {
      expect(optionRowCount(300, rows) + selectChromeHeight).toBeLessThan(rows);
    }
    expect(optionRowCount(30, 8)).toBe(1);
    expect(optionRowCount(30, 12)).toBe(5);
  });

  test("keeps one row however short the terminal claims to be", () => {
    for (const rows of [selectChromeHeight + 1, 1, 0]) {
      expect(optionRowCount(30, rows)).toBe(1);
    }
    expect(optionRowCount(0, ROOMY)).toBe(1);
  });
});

describe("select option window", () => {
  test("opens at the top and counts what it hides below", () => {
    expect(optionWindow(30, 0, 0, ROOMY)).toEqual({
      start: 0,
      count: 10,
      hiddenAbove: 0,
      hiddenBelow: 20,
    });
  });

  test("stays still while the active option is inside it", () => {
    for (const active of [0, 5, 9]) {
      expect(optionWindow(30, active, 0, ROOMY).start).toBe(0);
    }
    expect(optionWindow(30, 12, 5, ROOMY).start).toBe(5);
  });

  test("moves only as far as bringing the active option back needs", () => {
    expect(optionWindow(30, 10, 0, ROOMY)).toEqual({
      start: 1,
      count: 10,
      hiddenAbove: 1,
      hiddenBelow: 19,
    });
    expect(optionWindow(30, 29, 0, ROOMY)).toEqual({
      start: 20,
      count: 10,
      hiddenAbove: 20,
      hiddenBelow: 0,
    });
    expect(optionWindow(30, 4, 10, ROOMY)).toEqual({
      start: 4,
      count: 10,
      hiddenAbove: 4,
      hiddenBelow: 16,
    });
  });

  test("pulls a window sitting past the end of a shortened list back", () => {
    expect(optionWindow(12, 11, 20, ROOMY)).toEqual({
      start: 2,
      count: 10,
      hiddenAbove: 2,
      hiddenBelow: 0,
    });
    expect(optionWindow(3, 0, 20, ROOMY)).toEqual({
      start: 0,
      count: 3,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
  });

  test("hides nothing when nothing is visible", () => {
    expect(optionWindow(0, 0, 0, ROOMY)).toEqual({
      start: 0,
      count: 1,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
  });

  test("re-derives itself against the terminal's current height", () => {
    expect(optionWindow(30, 12, 3, 12)).toEqual({
      start: 8,
      count: 5,
      hiddenAbove: 8,
      hiddenBelow: 17,
    });
    expect(optionWindow(30, 12, 10, ROOMY)).toEqual({
      start: 10,
      count: 10,
      hiddenAbove: 10,
      hiddenBelow: 10,
    });
  });
});
