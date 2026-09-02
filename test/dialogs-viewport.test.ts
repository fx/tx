import { describe, expect, test } from "bun:test";
import {
  collectingChromeHeight,
  maximumOptionRows,
  optionRowCount,
  optionWindow,
  selectChromeHeight,
} from "../plugins/dialogs/viewport.ts";

/** A terminal with room to spare, so a test about one bound is not answered by
 * another. */
const ROOMY = 40;

/** The two states a select sizes its window in, so a rule that must hold in
 * both is written once. */
const STATES = [
  ["choosing", false, selectChromeHeight],
  ["collecting a field", true, collectingChromeHeight],
] as const;

describe("select viewport height", () => {
  test("shows at most ten option rows however long the list", () => {
    expect(maximumOptionRows).toBe(10);
    expect(optionRowCount(30, ROOMY, false)).toBe(maximumOptionRows);
    expect(optionRowCount(300, 500, false)).toBe(maximumOptionRows);
  });

  test("shows no more rows than there are options to put in them", () => {
    expect(optionRowCount(3, ROOMY, false)).toBe(3);
    expect(optionRowCount(maximumOptionRows, ROOMY, false)).toBe(
      maximumOptionRows,
    );
  });

  /**
   * Six rows of chrome while choosing — the panel's two edges, the filter
   * prompt, the two overflow indicators, and the key hint line — and nine once
   * a field is collected, which adds that field's own three panel rows and
   * moves the hint line onto it.
   *
   * These are written as literals rather than derived from the constants: a
   * bound expressed in terms of the number under test moves with it, which is
   * exactly how a constant three rows too large once passed every test here
   * while starving a ten-row terminal of every option row it could afford.
   */
  test("reserves six rows while choosing and nine while collecting", () => {
    expect(selectChromeHeight).toBe(6);
    expect(collectingChromeHeight).toBe(9);
    expect(optionRowCount(30, 8, false)).toBe(1);
    expect(optionRowCount(30, 12, false)).toBe(5);
    expect(optionRowCount(30, 11, true)).toBe(1);
    expect(optionRowCount(30, 15, true)).toBe(5);
  });

  /** The spec's own short-terminal scenario, in the terminal it names: thirty
   * options in eight rows render fewer than ten and at least one, so the active
   * option can be among them. */
  test("renders an option row in the eight-row terminal the spec names", () => {
    const count = optionRowCount(30, 8, false);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThan(maximumOptionRows);
    expect(optionWindow(30, 0, 0, 8, false).count).toBe(count);
  });

  /** A terminal a plain list comfortably fits in must draw all of it. Ten rows
   * and three options was the case a chrome of nine emptied. */
  test("draws a short list whole in a ten-row terminal", () => {
    expect(optionRowCount(3, 10, false)).toBe(3);
    expect(optionWindow(3, 0, 0, 10, false)).toEqual({
      renderedStart: 0,
      count: 3,
      rememberedStart: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
  });

  test.each(STATES)(
    "keeps the whole dialog strictly shorter than the terminal while %s",
    (_state, collecting, chrome) => {
      for (const rows of [chrome + 1, 1, 0]) {
        expect(optionRowCount(300, rows, collecting)).toBe(0);
      }
      for (let rows = chrome + 1; rows <= 60; rows++) {
        const count = optionRowCount(300, rows, collecting);
        if (count === 0) continue;
        expect(count + chrome).toBeLessThan(rows);
      }
    },
  );

  /**
   * A terminal of exactly the chrome plus one row is where the two viewport
   * rules meet: one option row there makes the worst-case frame exactly as tall
   * as the terminal, which is the height at which Ink treats output as
   * full-screen and clears the terminal when the dialog settles. The
   * no-clearing guarantee wins, so the window renders nothing rather than
   * wiping out what the user was reading.
   */
  test.each(STATES)(
    "drops its last row rather than fill a terminal it would clear while %s",
    (_state, collecting, chrome) => {
      const boundary = chrome + 1;
      expect(optionRowCount(300, boundary, collecting)).toBe(0);
      expect(optionRowCount(300, boundary + 1, collecting)).toBe(1);
      expect(
        optionRowCount(300, boundary + 1, collecting) + chrome,
      ).toBeLessThan(boundary + 1);
    },
  );

  test.each(STATES)(
    "keeps one row wherever the terminal can afford one while %s",
    (_state, collecting, chrome) => {
      for (const rows of [chrome + 2, chrome + 3]) {
        expect(optionRowCount(30, rows, collecting)).toBeGreaterThanOrEqual(1);
      }
    },
  );

  /**
   * `Math.max(1, …)` used to override a genuine zero back to one, so a select
   * with nothing visible reported a renderable row it did not have. There is
   * nothing to floor: no options means no option rows, at any terminal size,
   * including a roomy one where the old bug was most visible.
   */
  test("shows no option rows when nothing is visible", () => {
    // The two rows either side of the choosing chrome are literals rather
    // than the constant plus an offset: a bound written in terms of the number
    // under test moves with it, which is how a chrome three rows too large
    // once passed a green suite.
    for (const rows of [0, 1, 7, 8, ROOMY, 500]) {
      expect(optionRowCount(0, rows, false)).toBe(0);
    }
  });

  test("never claims more option rows than there are options", () => {
    for (const [, collecting] of STATES) {
      for (let visibleCount = 0; visibleCount <= 15; visibleCount++) {
        for (let rows = 0; rows <= 60; rows += 3) {
          expect(
            optionRowCount(visibleCount, rows, collecting),
          ).toBeLessThanOrEqual(visibleCount);
        }
      }
    }
  });

  /** Collection puts a second panel on screen, so the window has to give rows
   * back on the frame that first draws it — the frame sized for the choosing
   * chrome is the one that would reach the terminal's own height. */
  test("gives rows back to the field's panel when collection begins", () => {
    for (let rows = 8; rows <= 40; rows++) {
      expect(optionRowCount(30, rows, true)).toBeLessThanOrEqual(
        optionRowCount(30, rows, false),
      );
    }
    expect(optionRowCount(30, 11, false)).toBe(4);
    expect(optionRowCount(30, 11, true)).toBe(1);
  });
});

describe("select option window", () => {
  test("opens at the top and counts what it hides below", () => {
    expect(optionWindow(30, 0, 0, ROOMY, false)).toEqual({
      renderedStart: 0,
      count: 10,
      rememberedStart: 0,
      hiddenAbove: 0,
      hiddenBelow: 20,
    });
  });

  test("stays still while the active option is inside it", () => {
    for (const active of [0, 5, 9]) {
      expect(optionWindow(30, active, 0, ROOMY, false).renderedStart).toBe(0);
    }
    expect(optionWindow(30, 12, 5, ROOMY, false).renderedStart).toBe(5);
  });

  test("moves only as far as bringing the active option back needs", () => {
    expect(optionWindow(30, 10, 0, ROOMY, false)).toEqual({
      renderedStart: 1,
      count: 10,
      rememberedStart: 1,
      hiddenAbove: 1,
      hiddenBelow: 19,
    });
    expect(optionWindow(30, 29, 0, ROOMY, false)).toEqual({
      renderedStart: 20,
      count: 10,
      rememberedStart: 20,
      hiddenAbove: 20,
      hiddenBelow: 0,
    });
    expect(optionWindow(30, 4, 10, ROOMY, false)).toEqual({
      renderedStart: 4,
      count: 10,
      rememberedStart: 4,
      hiddenAbove: 4,
      hiddenBelow: 16,
    });
  });

  test("pulls a window sitting past the end of a shortened list back", () => {
    expect(optionWindow(12, 11, 20, ROOMY, false)).toEqual({
      renderedStart: 2,
      count: 10,
      rememberedStart: 2,
      hiddenAbove: 2,
      hiddenBelow: 0,
    });
    expect(optionWindow(3, 0, 20, ROOMY, false)).toEqual({
      renderedStart: 0,
      count: 3,
      rememberedStart: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
  });

  /** A collapsed window draws no start of its own. Nothing sits above rows that
   * are not there, so the whole list counts as hidden below and the frame draws
   * one indicator rather than two — which is the row that would otherwise take
   * the frame to the terminal's own height in exactly the terminals that have
   * no rows to spare. */
  test("renders no rows and counts the whole list as hidden below", () => {
    // A literal, for the same reason, and the more carefully because no
    // absolute row count above it pins this one down: seven rows is one short
    // of the eight a choosing select needs for its first option row.
    const boundary = 7;
    expect(optionWindow(30, 0, 0, boundary, false)).toEqual({
      renderedStart: 0,
      count: 0,
      rememberedStart: 0,
      hiddenAbove: 0,
      hiddenBelow: 30,
    });
    expect(optionWindow(30, 29, 4, boundary, false)).toEqual({
      renderedStart: 0,
      count: 0,
      rememberedStart: 4,
      hiddenAbove: 0,
      hiddenBelow: 30,
    });
    expect(optionWindow(0, 0, 0, boundary, false)).toEqual({
      renderedStart: 0,
      count: 0,
      rememberedStart: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
  });

  /**
   * Collapsing the window is the terminal's doing, not the user's, so the place
   * they scrolled to outlives it: the drawn start goes to the top while the
   * remembered start stays where it was, and the next terminal tall enough to
   * draw a row opens the window there. Storing the drawn start instead sent the
   * window back to whatever edge the active option dragged it to from the top
   * of the list.
   */
  test("remembers the start it had while it has no rows to draw it at", () => {
    // Seven rows while choosing and ten while collecting are the heights at
    // which the window gives up its last row. Written as literals, so a chrome
    // constant that grows fails here rather than moving the case with it.
    const collapsed = optionWindow(30, 25, 20, 7, false);
    expect(collapsed.count).toBe(0);
    expect(collapsed.renderedStart).toBe(0);
    expect(collapsed.rememberedStart).toBe(20);
    expect(collapsed.hiddenAbove).toBe(0);
    expect(collapsed.hiddenBelow).toBe(30);
    // The terminal grows back, and the window carries that remembered start in
    // rather than the zero it drew from.
    expect(
      optionWindow(30, 25, collapsed.rememberedStart, ROOMY, false),
    ).toEqual({
      renderedStart: 20,
      count: 10,
      rememberedStart: 20,
      hiddenAbove: 20,
      hiddenBelow: 0,
    });
    // Collection collapses the window the same way a short terminal does.
    const collecting = optionWindow(30, 25, 20, 10, true);
    expect(collecting.count).toBe(0);
    expect(collecting.renderedStart).toBe(0);
    expect(collecting.rememberedStart).toBe(20);
  });

  /** What it remembers is still a position in the list it is remembering it
   * over, so a filter that shortens the list under a collapsed window pulls the
   * remembered start back with it rather than storing a start past the end. */
  test("clamps what a collapsed window remembers to the list it has", () => {
    expect(optionWindow(12, 0, 20, 7, false)).toEqual({
      renderedStart: 0,
      count: 0,
      rememberedStart: 12,
      hiddenAbove: 0,
      hiddenBelow: 12,
    });
    expect(optionWindow(0, 0, 20, 7, false)).toEqual({
      renderedStart: 0,
      count: 0,
      rememberedStart: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
    expect(optionWindow(30, 0, -5, 7, false).rememberedStart).toBe(0);
  });

  test("hides nothing when nothing is visible", () => {
    expect(optionWindow(0, 0, 0, ROOMY, false)).toEqual({
      renderedStart: 0,
      count: 0,
      rememberedStart: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
  });

  test("re-derives itself against the terminal's current height", () => {
    expect(optionWindow(30, 12, 3, 12, false)).toEqual({
      renderedStart: 8,
      count: 5,
      rememberedStart: 8,
      hiddenAbove: 8,
      hiddenBelow: 17,
    });
    expect(optionWindow(30, 12, 10, ROOMY, false)).toEqual({
      renderedStart: 10,
      count: 10,
      rememberedStart: 10,
      hiddenAbove: 10,
      hiddenBelow: 10,
    });
  });
});
