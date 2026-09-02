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

  /**
   * Nine rows of chrome: the panel's two edges, the filter prompt, the two
   * overflow indicators, the three edges and value row of the panel a collected
   * field draws under it, and the key hint line. A select that collects nothing
   * spends the field's four rows on its own hint line alone, so collection is
   * the worst case and the only one the constant has to cover.
   */
  test("keeps the whole dialog strictly shorter than the terminal", () => {
    expect(selectChromeHeight).toBe(9);
    for (const rows of [selectChromeHeight + 1, 1, 0]) {
      expect(optionRowCount(300, rows)).toBe(0);
    }
    for (let rows = selectChromeHeight + 1; rows <= 60; rows++) {
      const count = optionRowCount(300, rows);
      if (count === 0) continue;
      expect(count + selectChromeHeight).toBeLessThan(rows);
    }
    expect(optionRowCount(30, 11)).toBe(1);
    expect(optionRowCount(30, 15)).toBe(5);
  });

  /**
   * A terminal of exactly the chrome plus one row is where the two viewport
   * rules meet: one option row there makes the worst-case frame exactly as tall
   * as the terminal, which is the height at which Ink treats output as
   * full-screen and clears the terminal when the dialog settles. The
   * no-clearing guarantee wins, so the window renders nothing rather than
   * wiping out what the user was reading.
   */
  test("drops its last row rather than fill a terminal it would clear", () => {
    const boundary = selectChromeHeight + 1;
    expect(optionRowCount(300, boundary)).toBe(0);
    expect(optionRowCount(300, boundary + 1)).toBe(1);
    expect(optionRowCount(300, boundary + 1) + selectChromeHeight).toBeLessThan(
      boundary + 1,
    );
  });

  test("keeps one row wherever the terminal can afford one", () => {
    for (const rows of [selectChromeHeight + 2, selectChromeHeight + 3]) {
      expect(optionRowCount(30, rows)).toBeGreaterThanOrEqual(1);
    }
  });

  /**
   * `Math.max(1, …)` used to override a genuine zero back to one, so a select
   * with nothing visible reported a renderable row it did not have. There is
   * nothing to floor: no options means no option rows, at any terminal size,
   * including a roomy one where the old bug was most visible.
   */
  test("shows no option rows when nothing is visible", () => {
    for (const rows of [
      0,
      1,
      selectChromeHeight + 1,
      selectChromeHeight + 2,
      ROOMY,
      500,
    ]) {
      expect(optionRowCount(0, rows)).toBe(0);
    }
  });

  test("never claims more option rows than there are options", () => {
    for (let visibleCount = 0; visibleCount <= 15; visibleCount++) {
      for (let rows = 0; rows <= 60; rows += 3) {
        expect(optionRowCount(visibleCount, rows)).toBeLessThanOrEqual(
          visibleCount,
        );
      }
    }
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

  test("renders no rows and counts the whole list as hidden below", () => {
    const boundary = selectChromeHeight + 1;
    expect(optionWindow(30, 0, 0, boundary)).toEqual({
      start: 0,
      count: 0,
      hiddenAbove: 0,
      hiddenBelow: 30,
    });
    // The active option is well past a window with no rows to bring it into,
    // and the window stays where it was rather than chasing it.
    expect(optionWindow(30, 29, 4, boundary)).toEqual({
      start: 4,
      count: 0,
      hiddenAbove: 4,
      hiddenBelow: 26,
    });
    expect(optionWindow(0, 0, 0, boundary)).toEqual({
      start: 0,
      count: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
  });

  test("hides nothing when nothing is visible", () => {
    expect(optionWindow(0, 0, 0, ROOMY)).toEqual({
      start: 0,
      count: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
  });

  test("re-derives itself against the terminal's current height", () => {
    expect(optionWindow(30, 12, 3, 15)).toEqual({
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
