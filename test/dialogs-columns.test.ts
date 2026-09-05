import { describe, expect, test } from "bun:test";
import {
  type CellLayout,
  type ColumnCell,
  cellsColumnWidth,
  columnCells,
  columnDivider,
  columnsWidth,
  columnWidth,
  dividerWidth,
  droppedColumns,
  expandGlyph,
  fieldGap,
  fieldsWidth,
  fieldWidths,
  fitColumnWidths,
  fitFieldWidths,
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

/**
 * Everything one cell puts on screen, its marker included.
 *
 * A cell is a run of pieces rather than one string, because the marker
 * annotates the row rather than belonging to it and names its own variable.
 * What the reader sees is still one row, so it is the pieces together that
 * have to be exactly the column's width.
 */
function drawn(cell: ColumnCell | undefined): string {
  if (cell === undefined) return "";
  return `${cell.text}${cell.marker?.text ?? ""}`;
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
    expect(cells[0]).toEqual({ text: "no match  ", variable: "content" });
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

    expect(drawn(cells[0])).toBe(`short${" ".repeat(14)} ${expandGlyph}`);
    expect(drawn(cells[1])).toBe(`a much longer label ${expandGlyph}`);
    for (const cell of cells) {
      expect(drawn(cell).endsWith(expandGlyph)).toBe(true);
      expect(displayWidth(drawn(cell))).toBe(width);
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
    expect(drawn(cells[0])).toBe(`leads${" ".repeat(3)} ${expandGlyph}`);
    expect(drawn(cells[1])).toBe("plain     ");
    for (const cell of cells) {
      expect(displayWidth(drawn(cell))).toBe(10);
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
    expect(drawn(cells[0])).toBe(`界界界${" ".repeat(4)}`);
    expect(drawn(cells[1])).toBe(
      `${grinning}${grinning}${" ".repeat(4)} ${expandGlyph}`,
    );
    for (const cell of cells) {
      expect(displayWidth(drawn(cell))).toBe(10);
    }
    // Seven code units, ten columns — which is the whole point.
    expect(drawn(cells[0])).toHaveLength(7);
  });

  /**
   * Every cell is padded to the column's width, whatever is in it, because the
   * inverted bar is the padding: a bar that stopped at the end of the label
   * would be a ragged highlight rather than a row.
   *
   * Marked options are swept alongside unmarked ones, and every width from one
   * upward is swept rather than a few round numbers, because the marker's own
   * columns are the half of the split that can disagree with the label's: a
   * cell over its budget draws correctly anyway once the frame has cut the row
   * it sits in, so only measuring the cell itself catches it.
   */
  test("pads every cell to exactly the column's width", () => {
    const list = options("tiny", "a label wider than its column", "leads!");
    for (const width of [1, 2, 3, 4, 5, 6, 12, 40]) {
      const cells = columnCells(
        list,
        allOf(list),
        window(0, 3, 3),
        0,
        width,
        3,
        DRIVEN,
      );
      for (const cell of cells) {
        expect(displayWidth(drawn(cell))).toBe(width);
      }
    }
  });

  /**
   * A column too narrow for both the marker and a column of label drops the
   * marker rather than squeezing it. The alternative is a cell reading `▸`
   * about a row indistinguishable from every other row, which says where it
   * leads but not what it is — and buying that with a cell over its budget.
   */
  test("drops the marker on a column too narrow to carry it", () => {
    const list = options("leads!");
    // The narrowest column that can carry a marker: the glyph, the space that
    // separates it from the label, and one column of label. Derived from the
    // exported glyph and `displayWidth` rather than written as a literal, so
    // this does not silently drift if the glyph or its spacing changes.
    const markable = displayWidth(expandGlyph) + 1 + 1;
    for (const width of [1, 2, markable, 4, 12]) {
      const cells = columnCells(
        list,
        allOf(list),
        window(0, 1, 1),
        0,
        width,
        1,
        DRIVEN,
      );
      const text = drawn(cells[0]);

      expect(text.includes(expandGlyph)).toBe(width >= markable);
      expect(displayWidth(text)).toBe(width);
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

    expect(cells.map((cell) => cell?.variable)).toEqual([
      "content",
      "cursor",
      "content",
    ]);
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
    expect(cells.map((cell) => cell?.variable)).toEqual([
      "content",
      "cursor",
      "content",
    ]);
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

    expect(cells.map((cell) => cell?.variable)).toEqual(["content", "content"]);
    expect(cells.map((cell) => cell?.text)).toEqual(["one   ", "two   "]);
  });

  /**
   * The bar is the only thing dressing a cell. A column behind the driven one
   * is not muted: it is showing the choice that led here, and shading it would
   * say a second time, in a second way, what the trail in the title already
   * says. Every unbarred cell is plain content, in the driven column and in
   * the ones behind it alike.
   */
  test("names no de-emphasized variable, driven or behind", () => {
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
      // Every cell is either the bar or plain content. A column names no
      // de-emphasized variable at all, so there is nothing for a theme to
      // shade a frozen column with.
      expect(
        cells.every(
          (cell) => cell?.variable === "content" || cell?.variable === "cursor",
        ),
      ).toBe(true);
    }
  });
});

/** Options as a column of cells sees them: one row of cells each, with `!` on
 * the last cell of a row that leads somewhere. The value is never read by the
 * geometry, so it is only ever something to tell the rows apart by. */
function cellRows(
  ...rows: readonly (readonly string[])[]
): readonly SelectOption<string>[] {
  return rows.map((row) => {
    const last = row.at(-1) as string;
    const marked = last.endsWith("!");
    const cells = marked ? [...row.slice(0, -1), last.slice(0, -1)] : row;
    const value = cells.join("|");
    return marked ? { cells, value, dialog: LEAF } : { cells, value };
  });
}

/** How a column of cells is laid out, with the two things a column of labels
 * has no answer for defaulted: it declares no headers and reserves no marker.
 */
function layout(
  fields: readonly number[],
  headers: readonly string[] = [],
  expandable = false,
): CellLayout {
  return { fields, headers, expandable };
}

describe("the widths a column's fields are measured at", () => {
  /** The vector sibling of the widest label: one width per field, each over
   * every row of the column rather than over the rows one frame draws, so
   * scrolling cannot resize a field under the cursor bar. */
  test("is the widest cell of each field, over every row it is given", () => {
    expect(
      fieldWidths([
        ["alpha", "one"],
        ["b", "twenty-two"],
        ["charlie-delta", "three"],
      ]),
    ).toEqual([13, 10]);
  });

  /** A header is drawn over its field, so a field narrower than its own name
   * would say less than the column it names. */
  test("counts a header among the cells its field has to hold", () => {
    const rows = [
      ["1.6.1", "ok"],
      ["1.6.0", "ok"],
    ];
    expect(fieldWidths(rows)).toEqual([5, 2]);
    expect(fieldWidths([["Version", "Status"], ...rows])).toEqual([7, 6]);
  });

  /** Measured in terminal columns, like everything else a panel is sized in:
   * an ideograph is one code unit and two columns, so a field measured by
   * `length` would leave every row after it starting in the wrong place. */
  test("measures in terminal columns rather than in code units", () => {
    const grinning = String.fromCodePoint(0x1f600);
    expect(fieldWidths([["界界界", grinning]])).toEqual([6, 2]);
  });

  test("is no fields at all for a column with no rows", () => {
    expect(fieldWidths([])).toEqual([]);
  });
});

describe("the columns a row of fields takes", () => {
  /** The gap is part of the same contract that fixes the divider and the
   * marker, so it is written out here rather than measured from the constant:
   * a gap asserted in terms of itself would move with a change to it. */
  test("is its fields and two spaces between each pair of them", () => {
    expect(fieldGap).toBe("  ");
    expect(displayWidth(fieldGap)).toBe(2);
    expect(fieldsWidth([13, 5])).toBe(20);
    expect(fieldsWidth([1, 1, 1])).toBe(7);
  });

  test("is the field alone for one field, and nothing for none", () => {
    expect(fieldsWidth([9])).toBe(9);
    expect(fieldsWidth([])).toBe(0);
  });
});

describe("one column of cells' width", () => {
  /** Stated in terms of the scalar column's width rather than beside it: the
   * marker's reserve and the empty column's floor are the same rules whatever
   * an option's display text is. */
  test("is its fields, its gaps, and the marker it reserves", () => {
    expect(cellsColumnWidth([13, 5], false, false)).toBe(20);
    expect(cellsColumnWidth([13, 5], true, false)).toBe(22);
    expect(
      cellsColumnWidth([13, 5], true, false) -
        cellsColumnWidth([13, 5], false, false),
    ).toBe(2);
  });

  test("never falls below the room `no match` needs", () => {
    expect(cellsColumnWidth([1, 1], false, true)).toBe(NO_MATCH_COLUMNS);
    expect(cellsColumnWidth([], false, true)).toBe(NO_MATCH_COLUMNS);
    expect(cellsColumnWidth([], false, false)).toBe(1);
  });
});

describe("fitting a column's fields to the width it is drawn at", () => {
  test("hands back the measured widths when they fit exactly", () => {
    const measured = [13, 5];
    expect(fitFieldWidths(measured, 20)).toEqual(measured);
    expect(fitFieldWidths([], 40)).toEqual([]);
  });

  /** The room a stretched column gained goes to the last field, exactly as the
   * room a stretched panel gained goes to the last column: the bar spans the
   * column either way, and growing a field in the middle would move every
   * field after it for no reason the reader can see. */
  test("gives the room left over to the last field", () => {
    expect(fitFieldWidths([13, 5], 26)).toEqual([13, 11]);
    expect(fitFieldWidths([4], 9)).toEqual([9]);
  });

  /** A cut lands at the end of the row rather than in the middle of it, so a
   * narrow terminal loses characters from the last cell rather than shifting
   * the fields before it out from under the reader. */
  test("takes a deficit off the end, leaving the fields before it alone", () => {
    expect(fitFieldWidths([13, 5], 18)).toEqual([13, 3]);
    expect(fitFieldWidths([13, 5], 15)).toEqual([13, 0]);
    expect(fitFieldWidths([13, 5], 10)).toEqual([8, 0]);
  });

  /** A column too narrow even for the gaps between its fields leaves every one
   * of them at nothing rather than at a negative width; the row built from it
   * is cut to the column when it is laid into one. */
  test("leaves no field narrower than nothing", () => {
    expect(fitFieldWidths([13, 5], 0)).toEqual([0, 0]);
    expect(fitFieldWidths([13, 5, 4], 1)).toEqual([0, 0, 0]);
  });
});

describe("the cells a column of cell options contributes", () => {
  const list = cellRows(
    ["alpha", "one"],
    ["b", "twenty-two"],
    ["charlie-delta", "three"],
  );
  const fields = fieldWidths([
    ["alpha", "one"],
    ["b", "twenty-two"],
    ["charlie-delta", "three"],
  ]);
  const width = cellsColumnWidth(fields, false, false);

  /** The whole point of the shape: every row's second cell begins at the same
   * terminal column, which is what makes a column of cells a table rather than
   * a column of padded labels. */
  test("begins every row's later fields at the same column", () => {
    const cells = columnCells(
      list,
      allOf(list),
      window(0, 3, 3),
      0,
      width,
      3,
      DRIVEN,
      layout(fields),
    );

    expect(drawn(cells[0])).toBe("alpha          one       ");
    expect(drawn(cells[1])).toBe("b              twenty-two");
    expect(drawn(cells[2])).toBe("charlie-delta  three     ");
    // The second field begins at the same column on every row, whatever the
    // first cell of that row was.
    expect(drawn(cells[0]).indexOf("one")).toBe(15);
    expect(drawn(cells[1]).indexOf("twenty-two")).toBe(15);
    expect(drawn(cells[2]).indexOf("three")).toBe(15);
  });

  test("separates one field from the next by exactly the gap", () => {
    const pair = cellRows(["a", "b"]);
    const cells = columnCells(
      pair,
      allOf(pair),
      window(0, 1, 1),
      0,
      4,
      1,
      DRIVEN,
      layout([1, 1]),
    );

    expect(drawn(cells[0])).toBe(`a${fieldGap}b`);
  });

  /**
   * The invariant the whole layout rests on, swept over every width from one
   * upward rather than a few round numbers, and with a marked row among the
   * unmarked ones: the fields, the gaps, and the marker are three budgets that
   * can disagree, and a row over its budget draws correctly anyway once the
   * frame has cut the row it sits in. Only measuring the cells catches it.
   */
  test("occupies exactly the column's width at every width", () => {
    const marked = cellRows(
      ["alpha", "one!"],
      ["b", "twenty-two"],
      ["charlie-delta", "three!"],
    );
    for (const expandable of [false, true]) {
      const rows = expandable ? marked : list;
      for (let column = 1; column <= 30; column += 1) {
        const cells = columnCells(
          rows,
          allOf(rows),
          window(0, 3, 3),
          0,
          column,
          4,
          DRIVEN,
          layout(fields, ["Name", "Count"], expandable),
        );
        for (const cell of cells) {
          if (cell === undefined) continue;
          expect(displayWidth(drawn(cell))).toBe(column);
        }
      }
    }
  });

  /**
   * The invariant holds where the column cannot afford even the gaps between
   * its fields — nine or more fields in the narrowest supported terminal. The
   * fields fall to nothing and the assembled row is cut to the column by the
   * same `padToWidth` a single over-long label goes through, so what the frame
   * receives is already exactly the column's width and its own row truncation
   * stays the guard it is rather than the thing that made the row fit.
   */
  test("stays exactly its column's width when the gaps alone do not fit", () => {
    const many = cellRows(Array.from({ length: 10 }, (_, at) => `c${at}`));
    const measured = fieldWidths([many[0]?.cells as readonly string[]]);
    for (const column of [12, 16, 20, 30]) {
      const cells = columnCells(
        many,
        allOf(many),
        window(0, 1, 1),
        0,
        column,
        1,
        DRIVEN,
        layout(measured),
      );

      expect(displayWidth(drawn(cells[0]))).toBe(column);
    }
    // The fields nearest the front are the ones that survive, so a column with
    // room for one of them shows the first rather than a row of ellipses.
    expect(fitFieldWidths(measured, 20)).toEqual([
      2, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  /** A field that does not fit loses its own characters at its end. The
   * alternative is a row cut as one run, which drops the last field of every
   * row rather than narrowing anything — the caller-side failure the shape
   * exists to remove. */
  test("truncates a cell at its end rather than shifting the fields after it", () => {
    const cells = columnCells(
      list,
      allOf(list),
      window(0, 3, 3),
      0,
      18,
      3,
      DRIVEN,
      layout(fields),
    );

    expect(drawn(cells[2])).toBe("charlie-delta  th…");
    // The first field keeps the width it was measured at, so the second still
    // starts where it did — and a cell that fits the narrowed field is left
    // whole rather than cut along with it.
    expect(drawn(cells[0])).toBe("alpha          one");
    expect(drawn(cells[1])).toBe("b              tw…");
  });

  /** The marker is the column's right edge, past the last field, so a reader
   * scanning for what leads somewhere reads one line of glyphs. */
  test("sets the marker on the column's right edge, past the last field", () => {
    const marked = cellRows(["alpha", "one!"], ["b", "two"]);
    const columns = cellsColumnWidth([5, 3], true, false);
    const cells = columnCells(
      marked,
      allOf(marked),
      window(0, 2, 2),
      0,
      columns,
      2,
      DRIVEN,
      layout([5, 3], [], true),
    );

    expect(columns).toBe(12);
    expect(drawn(cells[0])).toBe(`alpha  one ${expandGlyph}`);
    // The unmarked row spends the marker's columns on padding, so its fields
    // start where the marked row's do.
    expect(drawn(cells[1])).toBe("b      two  ");
  });
});

describe("the marker's own piece of a row", () => {
  /** The marker annotates the row rather than belonging to it, so it names the
   * variable for one and a theme can dress it without dressing the label. */
  test("names the marker variable on a row that is not under the bar", () => {
    const list = options("plain", "leads!");
    const cells = columnCells(list, allOf(list), window(0, 2, 2), 0, 10, 2, {
      bar: false,
    });

    expect(cells[0]?.marker).toBeUndefined();
    expect(cells[1]?.marker).toEqual({
      text: ` ${expandGlyph}`,
      variable: "marker",
    });
  });

  /** Under the bar it is the bar: the cursor spans its column's full width, so
   * a marker naming its own variable there would be a hole in it. */
  test("is part of the bar under the cursor", () => {
    const list = options("leads!");
    const cells = columnCells(
      list,
      allOf(list),
      window(0, 1, 1),
      0,
      10,
      1,
      DRIVEN,
    );

    expect(cells[0]?.variable).toBe("cursor");
    expect(cells[0]?.marker?.variable).toBe("cursor");
  });

  /** A column too narrow for both drops the marker rather than squeezing it,
   * so there is no piece to name a variable for at all. */
  test("is absent from a column too narrow to carry it", () => {
    const list = options("leads!");
    const cells = columnCells(list, allOf(list), window(0, 1, 1), 0, 2, 1, {
      bar: false,
    });

    expect(cells[0]?.marker).toBeUndefined();
    expect(displayWidth(drawn(cells[0]))).toBe(2);
  });
});

describe("a column's header row", () => {
  const list = cellRows(["1.6.1", "ok"], ["1.6.0", "stale"]);
  const headers = ["Version", "Status"];
  const fields = fieldWidths([headers, ["1.6.1", "ok"], ["1.6.0", "stale"]]);
  const width = cellsColumnWidth(fields, false, false);

  /** Drawn once at the top of the band and as chrome, because it names the
   * list rather than belonging to it — and the options begin on the row under
   * it, so the header costs the band a row rather than an option a place. */
  test("is the first row of the band, drawn as chrome", () => {
    const cells = columnCells(
      list,
      allOf(list),
      window(0, 2, 2),
      0,
      width,
      3,
      DRIVEN,
      layout(fields, headers),
    );

    expect(cells[0]).toEqual({
      text: "Version  Status",
      variable: "chrome",
    });
    expect(drawn(cells[1])).toBe("1.6.1    ok    ");
    expect(drawn(cells[2])).toBe("1.6.0    stale ");
  });

  /** The bar can never land on it: the active position is a position in the
   * visible list, and the header is not in that list at all. */
  test("is never the row under the bar, whichever row is active", () => {
    for (const active of [0, 1]) {
      const cells = columnCells(
        list,
        allOf(list),
        window(0, 2, 2),
        active,
        width,
        3,
        DRIVEN,
        layout(fields, headers),
      );

      expect(cells[0]?.variable).toBe("chrome");
      expect(cells.map((cell) => cell?.variable)).toEqual([
        "chrome",
        active === 0 ? "cursor" : "content",
        active === 1 ? "cursor" : "content",
      ]);
    }
  });

  /** It does not scroll with the rows beneath it: a header that scrolled away
   * would take a row with it on the way out and give one back on the way in,
   * which is the churn nothing in a dialog is allowed to cause. */
  test("stays at the top of the band while the options scroll under it", () => {
    const long = cellRows(
      ["1.6.1", "ok"],
      ["1.6.0", "stale"],
      ["1.5.9", "gone"],
    );
    const cells = columnCells(
      long,
      allOf(long),
      window(1, 2, 3),
      1,
      width,
      3,
      DRIVEN,
      layout(fields, headers),
    );

    expect(cells[0]?.text).toBe("Version  Status");
    expect(drawn(cells[1])).toBe("1.6.0    stale ");
    expect(drawn(cells[2])).toBe("1.5.9    gone  ");
  });

  /** The filter never sees it, so a filter that has hidden every option leaves
   * the header naming the fields of a list that is momentarily empty. */
  test("survives a filter that leaves nothing visible", () => {
    const cells = columnCells(
      list,
      [],
      window(0, 0, 0),
      0,
      width,
      2,
      DRIVEN,
      layout(fields, headers),
    );

    expect(cells[0]?.text).toBe("Version  Status");
    expect(cells[1]?.text).toBe(`${noMatch}       `);
  });

  /** A window the terminal could not afford draws no rows, and a header over
   * rows that are not there would be one row of chrome the viewport's
   * arithmetic never budgeted for — which is the row that takes the frame to
   * the terminal's own height. */
  test("is not drawn at all when the column has no rows to draw", () => {
    const cells = columnCells(
      list,
      allOf(list),
      window(0, 0, 2),
      0,
      width,
      0,
      DRIVEN,
      layout(fields, headers),
    );

    expect(cells).toEqual([]);
  });

  /** A band with no rows is a terminal that could not afford one, so a column
   * whose filter matched nothing spends no row saying so either: a column that
   * added a row of its own would be drawing one nothing budgeted for, and the
   * band it returns would be longer than the one it was asked for. */
  test("says nothing at all when the band has no row to say it in", () => {
    expect(
      columnCells(
        list,
        [],
        window(0, 0, 0),
        0,
        width,
        0,
        DRIVEN,
        layout(fields, headers),
      ),
    ).toEqual([]);
    // The same holds for a column of labels, which has no header to give up
    // first and so is the shorter way to the same row.
    const labels = options("one", "two");
    expect(columnCells(labels, [], window(0, 0, 0), 0, 6, 0, DRIVEN)).toEqual(
      [],
    );
  });

  /** An empty header list is a column saying it has none, which is what
   * omitting it says too. */
  test("is absent for a column declaring no headers", () => {
    const cells = columnCells(
      list,
      allOf(list),
      window(0, 2, 2),
      0,
      width,
      2,
      DRIVEN,
      layout(fields),
    );

    expect(drawn(cells[0])).toBe("1.6.1    ok    ");
    expect(drawn(cells[1])).toBe("1.6.0    stale ");
  });
});
