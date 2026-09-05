import { describe, expect, test } from "bun:test";
import {
  flowItems,
  headerCells,
  type PlacedCell,
  placeholder,
  tableCells,
} from "../plugins/grid/cells.ts";
import {
  canvasWidth,
  cellLine,
  columnGap,
  columnWidths,
  decorate,
  defaultLayoutColumns,
  flowColumnCount,
  flowLines,
  gridLines,
  type Line,
  lineWidth,
  padTo,
  tableLines,
} from "../plugins/grid/geometry.ts";
import type { Row } from "../plugins/grid/types.ts";

/** One laid-out line as the text it prints. */
function text(line: Line): string {
  return line.map((segment) => segment.text).join("");
}

/** Every line as the text it prints, which is what a printed grid is. */
function printed(lines: readonly Line[]): readonly string[] {
  return lines.map(text);
}

/** The roles a line names, in order. */
function variables(line: Line): readonly string[] {
  return line.map((segment) => segment.variable);
}

/** The column each cell of a table row starts at, so "every second cell begins
 * at the same terminal column" is an assertion about numbers. */
function starts(line: Line): readonly number[] {
  const columns: number[] = [];
  let used = 0;
  line.forEach((segment, index) => {
    // The gap segments sit between cells, so every other segment is a cell.
    if (index % 2 === 0) columns.push(used);
    used += Bun.stringWidth(segment.text);
  });
  return columns;
}

/** A table's lines from rows written the way a consumer writes them. */
function table(
  rows: readonly Row[],
  headers?: readonly string[],
): readonly Line[] {
  const count = Math.max(
    headers?.length ?? 0,
    ...rows.map((row) => row.length),
  );
  return tableLines(headerCells(headers, count), tableCells(rows, count));
}

const cell = (text: string, align: "start" | "end" = "start"): PlacedCell => ({
  text,
  variable: "content",
  align,
});

describe("measuring lines", () => {
  test("counts a line in the terminal columns it occupies", () => {
    expect(lineWidth([])).toBe(0);
    expect(
      lineWidth([
        { text: "漢字", variable: "content" },
        { text: "  ", variable: "content" },
        { text: "ab", variable: "content" },
      ]),
    ).toBe(8);
  });

  test("sizes the canvas from the widest line, never from a terminal", () => {
    const lines: readonly Line[] = [
      [{ text: "one", variable: "content" }],
      [{ text: "a longer line", variable: "content" }],
      [],
    ];

    expect(canvasWidth(lines)).toBe(13);
    expect(canvasWidth([])).toBe(0);
  });
});

describe("where a line stops", () => {
  test("adds no padding after the last cell with anything to draw", () => {
    const line = cellLine([cell("alpha"), cell("b")], [8, 8]);

    expect(text(line)).toBe("alpha     b");
    expect(line).toHaveLength(3);
  });

  test("drops the columns after it, and the gaps that led to them", () => {
    const line = cellLine([cell("alpha"), cell(""), cell("")], [8, 8, 8]);

    expect(line).toEqual([{ text: "alpha", variable: "content" }]);
  });

  test("leaves a line with nothing to draw on it empty", () => {
    expect(cellLine([cell(""), cell("")], [4, 4])).toEqual([]);
    expect(cellLine([], [])).toEqual([]);
  });

  test("keeps a consumer's own trailing spaces rather than rewriting them", () => {
    // The layout takes back only the padding it added. A supplied string is
    // never rewritten beyond having its control characters removed, so a cell
    // that genuinely ends in spaces still does after it is laid out.
    const line = cellLine([cell("alpha"), cell("b  ")], [8, 8]);

    expect(text(line)).toBe("alpha     b  ");
  });

  test("still pads a last cell declaring end, because that padding leads", () => {
    const line = cellLine([cell("alpha"), cell("12", "end")], [8, 5]);

    expect(text(line)).toBe("alpha        12");
  });
});

describe("column widths", () => {
  test("takes the widest cell in the column", () => {
    expect(
      columnWidths(
        [
          [cell("alpha"), cell("1")],
          [cell("b"), cell("22")],
          [cell("charlie-delta"), cell("3")],
        ],
        undefined,
      ),
    ).toEqual([13, 2]);
  });

  test("counts the header in", () => {
    expect(
      columnWidths(
        [[cell("a"), cell("b")]],
        [
          { text: "NAME", variable: "strong", align: "start" },
          { text: "N", variable: "strong", align: "start" },
        ],
      ),
    ).toEqual([4, 1]);
  });

  test("measures a wide cell in the columns it occupies on screen", () => {
    // Two ideographs are two code units and four columns; an astral glyph is
    // two of each. A column sized by code units would be too narrow for both.
    expect(columnWidths([[cell("漢字")], [cell("ab")]], undefined)).toEqual([
      4,
    ]);
    expect(columnWidths([[cell("😀😀")]], undefined)).toEqual([4]);
  });

  test("has no widths for a grid with no cells", () => {
    expect(columnWidths([], undefined)).toEqual([]);
  });
});

describe("padding one cell", () => {
  test("pads a cell declaring start, or nothing, at its end", () => {
    expect(padTo("ab", 5, "start")).toBe("ab   ");
  });

  test("pads a cell declaring end at its start, so counts line up", () => {
    expect(padTo("12", 5, "end")).toBe("   12");
  });

  test("pads in columns rather than code units", () => {
    expect(padTo("漢字", 6, "start")).toBe("漢字  ");
  });

  test("pads a cell already wider than its column not at all", () => {
    expect(padTo("alpha", 2, "start")).toBe("alpha");
  });
});

describe("a table's lines", () => {
  test("starts every column at the same terminal column on every row", () => {
    const lines = table([
      ["alpha", "1"],
      ["b", "22"],
      ["charlie-delta", "3"],
    ]);

    expect(printed(lines)).toEqual([
      "alpha          1",
      "b              22",
      "charlie-delta  3",
    ]);
    for (const line of lines) expect(starts(line)).toEqual([0, 15]);
  });

  test("separates columns by the fixed gap", () => {
    const [line] = table([["a", "b"]]);

    expect(columnGap).toBe(2);
    expect(line?.[1]).toEqual({ text: "  ", variable: "content" });
  });

  test("draws a header row above the rows and emphasizes it", () => {
    const lines = table([["alpha", "1"]], ["NAME", "N"]);

    expect(printed(lines)).toEqual(["NAME   N", "alpha  1"]);
    expect(variables(lines[0] as Line)).toEqual([
      "strong",
      "content",
      "strong",
    ]);
    expect(variables(lines[1] as Line)).toEqual([
      "content",
      "content",
      "content",
    ]);
  });

  test("pads a cell declaring end at its start", () => {
    const lines = table([
      ["alpha", { text: "1", align: "end" }],
      ["b", { text: "220", align: "end" }],
    ]);

    expect(printed(lines)).toEqual(["alpha    1", "b      220"]);
  });

  test("ends no line in a space, whatever the last column holds", () => {
    const lines = table(
      [
        ["alpha", "a-long-last-cell"],
        ["b", "short"],
        ["c", ""],
      ],
      ["NAME", "LAST"],
    );

    for (const line of lines) expect(text(line)).not.toMatch(/ $/);
    expect(printed(lines)).toEqual([
      "NAME   LAST",
      "alpha  a-long-last-cell",
      "b      short",
      `c      ${placeholder}`,
    ]);
  });

  test("ends no line in a space when the last header is blank", () => {
    const lines = table([["alpha", "1"]], ["NAME"]);

    expect(printed(lines)).toEqual(["NAME", "alpha  1"]);
  });

  test("fills a short row's missing cells rather than shortening the row", () => {
    expect(printed(table([["alpha", "beta"], ["b"]]))).toEqual([
      "alpha  beta",
      `b      ${placeholder}`,
    ]);
  });

  test("counts the columns a longer header row names", () => {
    expect(printed(table([["alpha"]], ["NAME", "COUNT"]))).toEqual([
      "NAME   COUNT",
      `alpha  ${placeholder}`,
    ]);
  });
});

describe("how many columns a flow affords", () => {
  test("takes as many as the width affords", () => {
    // Two columns of seven and one gap take sixteen; a third takes nine more.
    expect(flowColumnCount(6, 7, 16)).toBe(2);
    expect(flowColumnCount(6, 7, 24)).toBe(2);
    expect(flowColumnCount(6, 7, 25)).toBe(3);
  });

  test("takes one column when the width affords no more", () => {
    expect(flowColumnCount(6, 7, 3)).toBe(1);
    expect(flowColumnCount(6, 7, 0)).toBe(1);
  });

  test("never opens more columns than there are items", () => {
    expect(flowColumnCount(2, 1, defaultLayoutColumns)).toBe(2);
  });
});

describe("a flow's lines", () => {
  const six = flowItems([
    ["alpha", "beta"],
    ["gamma", "delta"],
    ["epsilon", "zeta"],
  ]);

  test("reads down each column before across", () => {
    expect(printed(flowLines(six, 20))).toEqual([
      "alpha    delta",
      "beta     epsilon",
      "gamma    zeta",
    ]);
  });

  test("places a multi-cell row as several items in cell order", () => {
    const items = flowItems([["alpha", "beta"], ["gamma"]]);

    expect(items.map((item) => item.text)).toEqual(["alpha", "beta", "gamma"]);
    expect(printed(flowLines(items, 4))).toEqual(["alpha", "beta", "gamma"]);
  });

  test("uses one column when the width affords no more", () => {
    expect(printed(flowLines(six, 1))).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
    ]);
  });

  test("opens no empty column when the rows it needs leave one over", () => {
    // Six items into a width affording four columns is three columns of two,
    // not three columns and an empty fourth.
    expect(printed(flowLines(six, 40))).toEqual([
      "alpha    gamma    epsilon",
      "beta     delta    zeta",
    ]);
  });

  test("ends no line in a space", () => {
    for (const line of flowLines(six, 20)) {
      expect(text(line)).not.toMatch(/ $/);
    }
    // A short last column leaves the bottom rows ending early, and they carry
    // no padding either.
    for (const line of flowLines(flowItems([["a", "bb", "ccc"]]), 12)) {
      expect(text(line)).not.toMatch(/ $/);
    }
  });

  test("ignores a cell's declared alignment and keeps its variable", () => {
    const items = flowItems([
      [
        { text: "1", align: "end", variable: "danger" },
        { text: "22", align: "end" },
      ],
    ]);

    const [line] = flowLines(items, 80);

    expect(text(line as Line)).toBe("1   22");
    expect(variables(line as Line)).toEqual(["danger", "content", "content"]);
  });

  test("has no lines when there is nothing to flow", () => {
    expect(flowLines([], 80)).toEqual([]);
  });
});

describe("the empty message and the summary", () => {
  const body: readonly Line[] = [[{ text: "alpha", variable: "content" }]];

  test("puts a summary a blank line beneath the rows and mutes it", () => {
    const lines = decorate(body, "Nothing to show.", "1 row");

    expect(printed(lines)).toEqual(["alpha", "", "1 row"]);
    expect(variables(lines[2] as Line)).toEqual(["muted"]);
  });

  test("prints the empty message where the rows would have been", () => {
    const lines = decorate([], "Nothing to show.", undefined);

    expect(printed(lines)).toEqual(["Nothing to show."]);
    expect(variables(lines[0] as Line)).toEqual(["content"]);
  });

  test("separates a summary from the empty message exactly as from rows", () => {
    expect(printed(decorate([], "Nothing to show.", "0 rows"))).toEqual([
      "Nothing to show.",
      "",
      "0 rows",
    ]);
  });

  test("prints a summary alone where there is no empty message", () => {
    expect(printed(decorate([], undefined, "0 rows"))).toEqual(["0 rows"]);
  });

  test("prints nothing at all where there is nothing to print", () => {
    expect(decorate([], undefined, undefined)).toEqual([]);
  });

  test("sanitizes both of them", () => {
    expect(printed(decorate([], "no\nthing", "sum\u001b[2Jmary"))).toEqual([
      "nothing",
      "",
      "sum[2Jmary",
    ]);
  });
});

describe("laying out a whole grid", () => {
  test("lays a request declaring no layout out as a table", () => {
    expect(
      printed(
        gridLines({
          layout: "table",
          headers: ["NAME"],
          rows: [["alpha"], ["b"]],
          empty: undefined,
          summary: undefined,
          columns: defaultLayoutColumns,
        }),
      ),
    ).toEqual(["NAME", "alpha", "b"]);
  });

  test("draws no header row over no rows", () => {
    expect(
      printed(
        gridLines({
          layout: "table",
          headers: ["NAME", "COUNT"],
          rows: [],
          empty: "Nothing to show.",
          summary: undefined,
          columns: defaultLayoutColumns,
        }),
      ),
    ).toEqual(["Nothing to show."]);
  });

  test("flows the cells of every row when asked for a flow", () => {
    expect(
      printed(
        gridLines({
          layout: "flow",
          // A flow ignores a supplied header row rather than rejecting it.
          headers: ["IGNORED"],
          rows: [["alpha", "beta"], ["gamma"]],
          empty: undefined,
          summary: "3 items",
          columns: 12,
        }),
      ),
    ).toEqual(["alpha  gamma", "beta", "", "3 items"]);
  });

  test("takes the stated fallback as its width when a stream reports none", () => {
    expect(defaultLayoutColumns).toBe(80);
  });
});
