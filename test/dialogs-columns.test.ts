import { describe, expect, test } from "bun:test";
import {
  columnCells,
  columnDivider,
  columnsWidth,
  columnWidth,
  dividerWidth,
  droppedColumns,
  expandGlyph,
  fitColumnWidths,
  hiddenAboveGlyph,
  hiddenBelowGlyph,
  indicatorText,
  noMatch,
  stretchLastColumn,
} from "../plugins/dialogs/columns.ts";
import { displayWidth } from "../plugins/dialogs/frame.ts";
import type { SelectOption } from "../plugins/dialogs/types.ts";
import type { OptionWindow } from "../plugins/dialogs/viewport.ts";

/**
 * The columns `no match` occupies, written out rather than measured from the
 * constant. A floor expressed in terms of the text it is a floor for moves with
 * that text, and the whole point of the floor is that a column that has stopped
 * matching anything is still wide enough to say so.
 */
const NO_MATCH_COLUMNS = 8;

/** Room to spare, so a case about one bound is not answered by another. */
const ROOMY = 100;

/** A sub-dialog to hang off an option, so the option is marked. What the leaf
 * collects is never read by the geometry — only whether there is one. */
const LEAF = { type: "text", name: "branch", message: "Branch" } as const;

/** Options as the geometry sees them: a label, and whether the option leads
 * somewhere. `!` marks one that declares a sub-dialog. */
function options(
  ...labels: readonly string[]
): readonly SelectOption<string>[] {
  return labels.map((spec) => {
    const marked = spec.endsWith("!");
    const label = marked ? spec.slice(0, -1) : spec;
    return marked
      ? { label, value: label, dialog: LEAF }
      : { label, value: label };
  });
}

/** Every position of a list, which is what an unfiltered column hands the
 * cells. */
function allOf(list: readonly unknown[]): readonly number[] {
  return list.map((_, index) => index);
}

/** A window over `visibleCount` options drawing `count` of them from
 * `renderedStart`, as `optionWindow` would hand one over. */
function window(
  renderedStart: number,
  count: number,
  visibleCount: number,
): OptionWindow {
  return {
    renderedStart,
    count,
    rememberedStart: renderedStart,
    hiddenAbove: renderedStart,
    hiddenBelow: Math.max(0, visibleCount - renderedStart - count),
  };
}

/** The dressing of the column being driven, and of one behind it. Only the
 * cursor bar differs, because it is the only thing a column's cells are
 * dressed with at all. */
const DRIVEN = { bar: true } as const;
const FROZEN = { bar: false } as const;

describe("overflow indicator text", () => {
  /** The run is set into an edge a title is already competing for, and the
   * room for it is reserved from the panel's width, so anything beyond the
   * glyph, one space, and the digits costs the title columns it was measured
   * to have. */
  test("is the glyph, a space, and the count, and nothing else", () => {
    expect(indicatorText(hiddenAboveGlyph, 3)).toBe("▲ 3");
    expect(indicatorText(hiddenBelowGlyph, 12)).toBe("▼ 12");
    expect(indicatorText(hiddenAboveGlyph, 3)).toHaveLength(3);
    expect(displayWidth(indicatorText(hiddenBelowGlyph, 12))).toBe(4);
  });

  /** The reserve an edge holds is measured from the largest count either side
   * can reach, so the text has to grow with the number rather than being
   * padded to a fixed run — a padded one would hold room the title could have
   * had, at every count below the widest. */
  test("grows only with the digits of its count", () => {
    expect(indicatorText(hiddenAboveGlyph, 9)).toBe("▲ 9");
    expect(indicatorText(hiddenAboveGlyph, 10)).toBe("▲ 10");
    expect(indicatorText(hiddenAboveGlyph, 100)).toBe("▲ 100");
  });
});

describe("one column's width", () => {
  test("is its widest visible label when nothing in it leads anywhere", () => {
    expect(columnWidth(7, false, false)).toBe(7);
    expect(columnWidth(24, false, false)).toBe(24);
  });

  /**
   * The marker is reserved for the whole column rather than for the rows that
   * carry it: reserving it per row would let a column whose longest label is
   * unmarked lose the two columns the markers on its shorter rows need, and
   * those markers would then be cut off the ends of the rows that have them.
   */
  test("reserves the marker's room once, for the whole column", () => {
    // Two columns: the glyph, and the space that keeps it off the longest
    // label. Written out, because a marker that lost its separator would still
    // pass a case that asked the constant what it was.
    expect(columnWidth(7, true, false)).toBe(9);
    expect(columnWidth(7, true, false) - columnWidth(7, false, false)).toBe(2);
    // Independent of how many rows the column has, because the width is a
    // function of the widest label alone.
    expect(columnWidth(1, true, false)).toBe(3);
  });

  /** A column whose filter has matched nothing spends its one row saying so,
   * and that row has to fit: a column measured only by its labels would be
   * narrower than the words it is about to draw. */
  test("is wide enough for `no match` when nothing is visible", () => {
    expect(displayWidth(noMatch)).toBe(NO_MATCH_COLUMNS);
    expect(columnWidth(0, false, true)).toBe(NO_MATCH_COLUMNS);
    expect(columnWidth(3, false, true)).toBe(NO_MATCH_COLUMNS);
    // The marker allowance does not lift a narrow empty column over the floor
    // on its own, and neither does the floor take room from a wide one.
    expect(columnWidth(3, true, true)).toBe(NO_MATCH_COLUMNS);
    expect(columnWidth(20, false, true)).toBe(20);
    expect(columnWidth(20, true, true)).toBe(22);
  });

  /** A column with nothing to put in it still draws a row, so it still takes a
   * column: a zero-width one would collapse into its divider and leave the
   * panel drawing two dividers with nothing between them. */
  test("never falls below one column", () => {
    expect(columnWidth(0, false, false)).toBe(1);
    expect(columnWidth(-3, false, false)).toBe(1);
  });
});

describe("a run of columns' width", () => {
  /** The divider constant is the room the drawn divider takes, spaces either
   * side included. Measuring the run against a constant the drawing does not
   * agree with is how a panel comes out a column short of what it drew. */
  test("counts the divider as the drawn divider's own width", () => {
    expect(dividerWidth).toBe(3);
    expect(displayWidth(` ${columnDivider} `)).toBe(dividerWidth);
  });

  test("is nothing when there are no columns", () => {
    expect(columnsWidth([])).toBe(0);
  });

  /** One column is the flat dialog, which has never had a divider in it. */
  test("spends no divider on a single column", () => {
    expect(columnsWidth([9])).toBe(9);
  });

  /** Dividers go between columns, so `n` of them take `n - 1`. An off-by-one
   * here sizes the panel wider or narrower than the row it draws. */
  test("spends a divider between each pair and none at the ends", () => {
    expect(columnsWidth([4, 6])).toBe(4 + 6 + 3);
    expect(columnsWidth([4, 6, 5])).toBe(4 + 6 + 5 + 3 + 3);
    expect(columnsWidth([1, 1, 1, 1])).toBe(4 + 9);
  });
});

describe("collapsing columns off the left", () => {
  test("drops nothing while the run already fits", () => {
    expect(droppedColumns([], ROOMY)).toBe(0);
    expect(droppedColumns([9], ROOMY)).toBe(0);
    expect(droppedColumns([4, 6], ROOMY)).toBe(0);
    // Exactly filling the width is fitting: the run is dropped only once it is
    // over, or a panel the terminal can hold loses its oldest column.
    expect(droppedColumns([4, 6], 13)).toBe(0);
  });

  /**
   * The oldest column goes first and only as far as it has to. The columns
   * behind are choices the reader has already made, and dropping two when one
   * would have done throws away a level they can still read.
   */
  test("drops from the left, one at a time, until the rest fit", () => {
    // Three tens run to 36 with their two dividers.
    const three = [10, 10, 10];
    expect(columnsWidth(three)).toBe(36);
    expect(droppedColumns(three, 36)).toBe(0);
    expect(droppedColumns(three, 35)).toBe(1);
    expect(droppedColumns(three, 23)).toBe(1);
    expect(droppedColumns(three, 22)).toBe(2);
    expect(droppedColumns(three, 10)).toBe(2);
  });

  /**
   * The rightmost column is the one being driven, and a browser that dropped
   * it would leave the reader steering a list that is not on screen. It stays
   * however narrow the terminal — `fitColumnWidths` truncates it instead,
   * which is what every other row does when it runs out of columns.
   */
  test("never drops the last column, however little room is left", () => {
    expect(droppedColumns([30], 5)).toBe(0);
    expect(droppedColumns([30], 0)).toBe(0);
    expect(droppedColumns([10, 30], 5)).toBe(1);
    expect(droppedColumns([10, 10, 30], 1)).toBe(2);
    // Which is to say: what is kept is never empty when there was anything to
    // keep.
    for (const widths of [[30], [10, 30], [10, 10, 30]]) {
      expect(droppedColumns(widths, 1)).toBeLessThan(widths.length);
    }
  });
});

describe("fitting the kept columns to the width", () => {
  test("leaves a run that already fits exactly as it is", () => {
    expect(fitColumnWidths([], ROOMY)).toEqual([]);
    expect(fitColumnWidths([4, 6], ROOMY)).toEqual([4, 6]);
    // Exactly filling the width needs no cutting back either.
    expect(fitColumnWidths([4, 6], 13)).toEqual([4, 6]);
  });

  /** Collapsing stops at one column, so the last one is what gives: it is cut
   * back to the room left rather than dropped. */
  test("cuts the last column back to what is left", () => {
    expect(fitColumnWidths([30], 10)).toEqual([10]);
  });

  /**
   * The room left over is the width minus everything before the last column
   * *and* the divider that separates it from them. Forgetting that divider
   * makes the run three columns wider than the panel it was fitted to, which
   * is a row that overflows the frame it is drawn in.
   */
  test("leaves the dividers room when more than one column is kept", () => {
    expect(fitColumnWidths([10, 30], 20)).toEqual([10, 7]);
    expect(fitColumnWidths([5, 5, 30], 20)).toEqual([5, 5, 4]);
    // Which is the same statement as: what comes back fills the width exactly.
    for (const widths of [
      [10, 30],
      [5, 5, 30],
    ]) {
      expect(columnsWidth(fitColumnWidths(widths, 20))).toBe(20);
    }
  });

  /** A column narrower than one column is not a column. The run then overflows
   * the panel, and the terminal wraps it — which beats a driven list that is
   * not on screen at all. */
  test("floors the last column at one column", () => {
    expect(fitColumnWidths([30], 0)).toEqual([1]);
    expect(fitColumnWidths([30], -5)).toEqual([1]);
    expect(fitColumnWidths([10, 10, 30], 5)).toEqual([10, 10, 1]);
  });

  /** Only the last column is touched: the ones behind it keep the widths they
   * were measured at, so nothing shifts under the reader as the terminal
   * narrows past the point the driven column starts giving room back. */
  test("leaves every column but the last at the width it was measured at", () => {
    expect(fitColumnWidths([10, 12, 30], 30).slice(0, 2)).toEqual([10, 12]);
  });
});

describe("stretching the last column", () => {
  /**
   * A long title or a filter carrying more text than any option makes the
   * frame wider than the columns need. The slack goes to the last column so
   * its cursor bar spans the panel, which is what a select of one column has
   * always looked like.
   */
  test("gives the room the frame has spare to the last column", () => {
    expect(stretchLastColumn([9], 20)).toEqual([20]);
    expect(stretchLastColumn([4, 6], 20)).toEqual([4, 13]);
    // Which is to say: the run then fills the frame's inner width exactly.
    expect(columnsWidth(stretchLastColumn([4, 6], 20))).toBe(20);
    expect(columnsWidth(stretchLastColumn([4, 6, 5], 40))).toBe(40);
  });

  test("leaves the columns alone when the frame has nothing spare", () => {
    expect(stretchLastColumn([4, 6], 13)).toEqual([4, 6]);
    // Narrower than the run is `fitColumnWidths`'s business, not this one:
    // stretching never takes room away.
    expect(stretchLastColumn([4, 6], 10)).toEqual([4, 6]);
    expect(stretchLastColumn([9], 9)).toEqual([9]);
  });

  test("has nothing to stretch when there are no columns", () => {
    expect(stretchLastColumn([], ROOMY)).toEqual([]);
  });
});

describe("the cells one column contributes to the band", () => {
  /**
   * The columns share one band, so a list of three and a list of thirty start
   * on the same row. A column that ran out of options leaves the rest of the
   * band empty rather than ending early, or the column to its right would
   * start further left on the rows below it.
   */
  test("fills the band, with nothing where the column has run out", () => {
    const list = options("one", "two");
    const cells = columnCells(
      list,
      allOf(list),
      window(0, 2, 2),
      0,
      5,
      4,
      DRIVEN,
    );

    expect(cells).toHaveLength(4);
    expect(cells[0]?.text).toBe("one  ");
    expect(cells[1]?.text).toBe("two  ");
    expect(cells[2]).toBeUndefined();
    expect(cells[3]).toBeUndefined();
  });

  /** A band taller than the column's own window is the ordinary case for every
   * column but the tallest, and for a scrolled column at any depth. */
  test("leaves the band's trailing rows empty under a short window", () => {
    const list = options("a", "b", "c", "d", "e");
    const cells = columnCells(
      list,
      allOf(list),
      window(2, 2, 5),
      2,
      3,
      5,
      DRIVEN,
    );

    expect(cells).toHaveLength(5);
    expect(cells.slice(2)).toEqual([undefined, undefined, undefined]);
  });

  /** A column whose filter matched nothing says so on its first row and leaves
   * the rest of the band alone, so the reader can see which column emptied
   * rather than watching a column silently vanish. */
  test("says `no match` on its first row when nothing is visible", () => {
    const cells = columnCells(
      options("one"),
      [],
      window(0, 0, 0),
      0,
      10,
      3,
      DRIVEN,
    );

    expect(cells).toHaveLength(3);
    expect(cells[0]).toEqual({
      text: "no match  ",
      dim: false,
      inverse: false,
    });
    expect(cells[1]).toBeUndefined();
    expect(cells[2]).toBeUndefined();
  });

  /**
   * The marker sits on the column's right edge, one edge for every marked row,
   * rather than trailing each label at whatever length that label happens to
   * be. A reader scanning for what leads somewhere then reads one line of
   * glyphs instead of hunting a ragged right margin.
   */
  test("sets the marker on the column's right edge, on every marked row", () => {
    const list = options("short!", "a much longer label!");
    const width = columnWidth(displayWidth("a much longer label"), true, false);
    const cells = columnCells(
      list,
      allOf(list),
      window(0, 2, 2),
      0,
      width,
      2,
      DRIVEN,
    );

    expect(cells[0]?.text).toBe(`short${" ".repeat(14)} ${expandGlyph}`);
    expect(cells[1]?.text).toBe(`a much longer label ${expandGlyph}`);
    for (const cell of cells) {
      expect(cell?.text.endsWith(expandGlyph)).toBe(true);
      expect(displayWidth(cell?.text ?? "")).toBe(width);
    }
  });

  /** An unmarked row in a column that has marked ones still takes the whole
   * column, so the marker's allowance is the column's rather than the row's and
   * the column to its right starts in the same place on every row. */
  test("pads an unmarked row across the allowance the markers hold", () => {
    const list = options("leads!", "plain");
    const cells = columnCells(
      list,
      allOf(list),
      window(0, 2, 2),
      0,
      10,
      2,
      DRIVEN,
    );

    // Eight columns of label room, then the space and the glyph the whole
    // column holds back for the marker.
    expect(cells[0]?.text).toBe(`leads${" ".repeat(3)} ${expandGlyph}`);
    expect(cells[1]?.text).toBe("plain     ");
    for (const cell of cells) {
      expect(displayWidth(cell?.text ?? "")).toBe(10);
    }
  });

  /**
   * Padding is in terminal columns, not code units: an ideograph is one code
   * unit and two columns, and an emoji is two code units and two columns, so a
   * cell padded by `length` would run its column into the divider beside it —
   * or stop short of it — by however many wide glyphs the label carries.
   */
  test("pads a label of wide glyphs to the column it occupies on screen", () => {
    const grinning = String.fromCodePoint(0x1f600);
    const list = options("界界界", `${grinning}${grinning}!`);
    const cells = columnCells(
      list,
      allOf(list),
      window(0, 2, 2),
      0,
      10,
      2,
      DRIVEN,
    );

    // Three ideographs are six columns, so four spaces fill the column of ten;
    // two emoji are four columns, so four spaces fill the eight the marker
    // leaves, and then the marker's own separator makes five.
    expect(cells[0]?.text).toBe(`界界界${" ".repeat(4)}`);
    expect(cells[1]?.text).toBe(
      `${grinning}${grinning}${" ".repeat(4)} ${expandGlyph}`,
    );
    for (const cell of cells) {
      expect(displayWidth(cell?.text ?? "")).toBe(10);
    }
    // Seven code units, ten columns — which is the whole point.
    expect(cells[0]?.text).toHaveLength(7);
  });

  /** Every cell is padded to the column's width, whatever is in it, because the
   * inverted bar is the padding: a bar that stopped at the end of the label
   * would be a ragged highlight rather than a row. */
  test("pads every cell to exactly the column's width", () => {
    const list = options("tiny", "a label wider than its column");
    for (const width of [1, 4, 12, 40]) {
      const cells = columnCells(
        list,
        allOf(list),
        window(0, 2, 2),
        0,
        width,
        2,
        DRIVEN,
      );
      for (const cell of cells) {
        expect(displayWidth(cell?.text ?? "")).toBe(width);
      }
    }
  });

  /** The bar marks where the reader is, so it lands on the active position and
   * on nothing else. */
  test("bars the active position and no other row", () => {
    const list = options("one", "two", "three");
    const cells = columnCells(
      list,
      allOf(list),
      window(0, 3, 3),
      1,
      6,
      3,
      DRIVEN,
    );

    expect(cells.map((cell) => cell?.inverse)).toEqual([false, true, false]);
  });

  /**
   * The active position is a position in the visible list, not a row of the
   * band, so a scrolled column bars the row the position landed on rather than
   * the row of the same number. Barring by row is the bug where scrolling
   * leaves the highlight stuck at the top of the window.
   */
  test("bars by position in the list, not by row of the window", () => {
    const list = options("a", "b", "c", "d", "e");
    const cells = columnCells(
      list,
      allOf(list),
      window(2, 3, 5),
      3,
      3,
      3,
      DRIVEN,
    );

    expect(cells.map((cell) => cell?.text)).toEqual(["c  ", "d  ", "e  "]);
    expect(cells.map((cell) => cell?.inverse)).toEqual([false, true, false]);
  });

  /** The rows come from the visible list, which is the filter's output, so the
   * cells follow the filter's own order and skip what it dropped. */
  test("draws the options the visible list names, in its order", () => {
    const list = options("alpha", "beta", "gamma");
    const cells = columnCells(list, [2, 0], window(0, 2, 2), 0, 6, 2, DRIVEN);

    expect(cells.map((cell) => cell?.text)).toEqual(["gamma ", "alpha "]);
  });

  /** A column drawn without the bar is a column whose dialog is not accepting
   * keys — while a field is collected under the panel, say. It keeps its rows;
   * it just stops claiming a cursor. */
  test("draws no bar at all when the column is not dressed with one", () => {
    const list = options("one", "two");
    const cells = columnCells(
      list,
      allOf(list),
      window(0, 2, 2),
      1,
      6,
      2,
      FROZEN,
    );

    expect(cells.map((cell) => cell?.inverse)).toEqual([false, false]);
    expect(cells.map((cell) => cell?.text)).toEqual(["one   ", "two   "]);
  });

  /**
   * The bar is the only thing dressing a cell. A column behind the driven one
   * is not dimmed: it is showing the choice that led here, and shading it would
   * say a second time, in a second way, what the trail in the title already
   * says.
   */
  test("dims nothing, in the driven column or the ones behind it", () => {
    const list = options("one", "two!");
    for (const dressing of [DRIVEN, FROZEN]) {
      const cells = columnCells(
        list,
        allOf(list),
        window(0, 2, 2),
        0,
        8,
        2,
        dressing,
      );
      expect(cells.map((cell) => cell?.dim)).toEqual([false, false]);
    }
  });
});
