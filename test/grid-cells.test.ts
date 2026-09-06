import { describe, expect, test } from "bun:test";
import type { Row } from "@fx/tx/grid";
import {
  columnCount,
  displayWidth,
  flowItems,
  headerCells,
  placeCell,
  placeholder,
  sanitize,
  tableCells,
} from "../plugins/grid/cells.ts";

/** The text of every cell of every row, which is what most of these
 * assertions are about. */
function texts(
  rows: readonly (readonly { readonly text: string }[])[],
): readonly (readonly string[])[] {
  return rows.map((row) => row.map((cell) => cell.text));
}

describe("measuring text", () => {
  test("counts the terminal columns text occupies, not its code units", () => {
    expect(displayWidth("alpha")).toBe(5);
    // Two ideographs are two code units and four columns.
    expect(displayWidth("漢字")).toBe(4);
    expect("漢字".length).toBe(2);
    // An astral glyph is two code units and two columns.
    expect(displayWidth("😀")).toBe(2);
    expect("😀".length).toBe(2);
    expect(displayWidth("")).toBe(0);
  });
});

describe("sanitizing a supplied string", () => {
  test("removes every control character and keeps everything else", () => {
    expect(sanitize("one\ntwo")).toBe("onetwo");
    expect(sanitize("one\r\ntwo")).toBe("onetwo");
    expect(sanitize("one\ttwo")).toBe("onetwo");
    expect(sanitize("\u001b[2Jcleared")).toBe("[2Jcleared");
    expect(sanitize("\u0007bell")).toBe("bell");
    expect(sanitize("\u007fdelete")).toBe("delete");
    // The C1 range is a control range too, and an eight-bit escape in it moves
    // the cursor exactly as its two-character form does.
    expect(sanitize("\u009bc-one")).toBe("c-one");
  });

  test("rewrites nothing else about the string", () => {
    expect(sanitize("  Mixed Case  ")).toBe("  Mixed Case  ");
    expect(sanitize("漢字 😀 café")).toBe("漢字 😀 café");
    expect(sanitize("")).toBe("");
  });
});

describe("placing one cell", () => {
  test("reads a bare string as the cell it would make", () => {
    expect(placeCell("alpha")).toEqual({
      text: "alpha",
      variable: "content",
      align: "start",
    });
    expect(placeCell({ text: "alpha" })).toEqual(placeCell("alpha"));
  });

  test("names content and start where the cell declares neither", () => {
    expect(
      placeCell({ text: "alpha", variable: "danger", align: "end" }),
    ).toEqual({ text: "alpha", variable: "danger", align: "end" });
    expect(placeCell({ text: "alpha", variable: "content" })).toEqual(
      placeCell("alpha"),
    );
  });

  test("sanitizes the text before anything measures it", () => {
    expect(placeCell("one\ntwo").text).toBe("onetwo");
    expect(placeCell({ text: "\u001b[2J", variable: "danger" })).toEqual({
      text: "[2J",
      variable: "danger",
      align: "start",
    });
  });

  test("renders a cell left empty as the placeholder", () => {
    expect(placeCell("").text).toBe(placeholder);
    expect(placeCell("\n\t").text).toBe(placeholder);
    expect(placeholder).toBe("—");
  });
});

describe("counting a grid's columns", () => {
  test("takes the most cells any one row supplies", () => {
    expect(columnCount([["a"], ["b", "c", "d"], ["e", "f"]], undefined)).toBe(
      3,
    );
    expect(columnCount([], undefined)).toBe(0);
  });

  test("takes the header count where there are more headers than that", () => {
    expect(columnCount([["a"]], ["one", "two", "three"])).toBe(3);
    expect(columnCount([["a", "b", "c"]], ["one"])).toBe(3);
    expect(columnCount([], ["one", "two"])).toBe(2);
  });
});

describe("placing a table's rows", () => {
  test("fills a short row out rather than shortening it", () => {
    const rows: readonly Row[] = [["a", "b", "c"], ["d"], []];

    const placed = tableCells(rows, 3);

    expect(texts(placed)).toEqual([
      ["a", "b", "c"],
      ["d", placeholder, placeholder],
      [placeholder, placeholder, placeholder],
    ]);
    expect(placed[1]?.[1]).toEqual({
      text: placeholder,
      variable: "content",
      align: "start",
    });
  });

  test("keeps every cell's own declarations", () => {
    const placed = tableCells(
      [[{ text: "12", align: "end", variable: "danger" }, "b"]],
      2,
    );

    expect(placed[0]?.[0]).toEqual({
      text: "12",
      variable: "danger",
      align: "end",
    });
  });
});

describe("placing a table's headers", () => {
  test("emphasizes them and pads them at their end", () => {
    expect(headerCells(["NAME", "COUNT"], 2)).toEqual([
      { text: "NAME", variable: "strong", align: "start" },
      { text: "COUNT", variable: "strong", align: "start" },
    ]);
  });

  test("sanitizes them and never substitutes the placeholder", () => {
    expect(headerCells(["one\ntwo", ""], 2)).toEqual([
      { text: "onetwo", variable: "strong", align: "start" },
      { text: "", variable: "strong", align: "start" },
    ]);
  });

  test("leaves a column no header was supplied for blank", () => {
    expect(headerCells(["NAME"], 3)?.map((cell) => cell.text)).toEqual([
      "NAME",
      "",
      "",
    ]);
  });

  test("has no header row where none was supplied or the list was empty", () => {
    expect(headerCells(undefined, 2)).toBeUndefined();
    expect(headerCells([], 2)).toBeUndefined();
  });
});

describe("flattening rows into flow items", () => {
  test("takes every cell in row then cell order", () => {
    expect(
      flowItems([["alpha", "beta"], ["gamma"]]).map((item) => item.text),
    ).toEqual(["alpha", "beta", "gamma"]);
  });

  test("pads no row out and joins no row together", () => {
    const items = flowItems([["a", "b", "c"], ["d"], []]);

    expect(items.map((item) => item.text)).toEqual(["a", "b", "c", "d"]);
  });

  test("places each item exactly as a cell is placed", () => {
    expect(flowItems([[{ text: "", variable: "muted" }]])).toEqual([
      { text: placeholder, variable: "muted", align: "start" },
    ]);
  });
});
