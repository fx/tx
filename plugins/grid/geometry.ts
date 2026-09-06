import type { ThemeVariable } from "@fx/tx/theme";
import {
  columnCount,
  displayWidth,
  flowItems,
  headerCells,
  type PlacedCell,
  sanitize,
  tableCells,
} from "./cells.ts";
import type { Row } from "./contract.ts";

/**
 * Every layout decision a grid makes, as pure functions over values: column
 * widths, the gap, the padding and the edge it lands on, flow placement, and
 * where the empty and summary lines go.
 *
 * Nothing here knows a renderer, a theme, or a stream. A variable is named
 * rather than resolved, and a width is a number rather than a frame, which is
 * what makes a layout bug a failing assertion on a value instead of a diff of
 * a drawn grid. It reaches for its sibling only for the display-width measure
 * and the cell normalization every layout starts from.
 */

/** What separates one column from the next, in every layout. Fixed rather than
 * derived: a gap that grew with the content would move every column when one
 * cell changed. */
export const columnGap = 2;

/** The width a width-dependent layout falls back to when the stream reports
 * none. `undefined columns` has to resolve to some number, and a stated one is
 * reproducible where a renderer's private default is not — which is what makes
 * a flow through a pipe produce one determinate answer. */
export const defaultLayoutColumns = 80;

/** One run of a line, naming what it is rather than what it looks like. */
export type LineSegment = {
  readonly text: string;
  readonly variable: ThemeVariable;
};

/** One line of a laid-out grid. An empty line is the blank one that separates
 * a summary from what is above it. */
export type Line = readonly LineSegment[];

/** The spaces between two columns. Plain `content`, because it is whitespace
 * and nothing about it should carry a role of its own. */
function gapSegment(): LineSegment {
  return { text: " ".repeat(columnGap), variable: "content" };
}

/** The columns one line occupies. */
export function lineWidth(line: Line): number {
  let total = 0;
  for (const segment of line) total += displayWidth(segment.text);
  return total;
}

/**
 * The canvas the grid is drawn on: the widest line it produced.
 *
 * Taken from the measurement rather than from the terminal, so a renderer
 * handed it never pads a line out to a width the grid did not ask for and the
 * bytes printed do not depend on how wide the terminal happens to be.
 */
export function canvasWidth(lines: readonly Line[]): number {
  let width = 0;
  for (const line of lines) width = Math.max(width, lineWidth(line));
  return width;
}

/**
 * The last cell of a line that has any text to draw, or `-1` where none of
 * them has.
 *
 * Every column after it contributes nothing but padding and a gap, so the line
 * stops here. That is how "no line carries trailing whitespace" is satisfied:
 * by never adding padding with nothing after it, rather than by removing
 * characters afterwards. The distinction matters because a consumer's own text
 * may legitimately end in spaces, and [Grid: Cell Values] forbids the grid
 * rewriting a supplied string beyond removing its control characters — so
 * padding is the only whitespace the layout is entitled to take back, and it
 * takes it back by not writing it.
 */
function lastDrawnCell(cells: readonly PlacedCell[]): number {
  for (let column = cells.length - 1; column >= 0; column -= 1) {
    if ((cells[column] as PlacedCell).text !== "") return column;
  }
  return -1;
}

/**
 * Each column's width: the widest cell in it, the header included, so every
 * cell of a column is aligned to one width and the column after it starts
 * where it should on every row.
 */
export function columnWidths(
  rows: readonly (readonly PlacedCell[])[],
  headers: readonly PlacedCell[] | undefined,
): readonly number[] {
  const widths: number[] = [];
  const measure = (cells: readonly PlacedCell[]): void => {
    cells.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, displayWidth(cell.text));
    });
  };
  if (headers !== undefined) measure(headers);
  for (const row of rows) measure(row);
  return widths;
}

/** One cell padded to its column, at the edge its alignment names: a cell
 * declaring `end` is padded at its start instead, so a column of counts lines
 * up on its digits. Measured in columns rather than code units, so a cell of
 * wide glyphs fills its column rather than overrunning it. */
export function padTo(
  text: string,
  width: number,
  align: "start" | "end",
): string {
  const padding = " ".repeat(Math.max(0, width - displayWidth(text)));
  return align === "end" ? padding + text : text + padding;
}

/**
 * One row of a table: every cell padded to its column and separated by the
 * gap, up to the last cell with anything to draw.
 *
 * That last cell is padded only where its alignment puts the padding before
 * it — a cell declaring `end` still lines up on its digits — so the line ends
 * on the cell's own final character and no line carries trailing whitespace.
 */
export function cellLine(
  cells: readonly PlacedCell[],
  widths: readonly number[],
): Line {
  const last = lastDrawnCell(cells);
  const segments: LineSegment[] = [];
  for (let column = 0; column <= last; column += 1) {
    const cell = cells[column] as PlacedCell;
    if (column > 0) segments.push(gapSegment());
    const width = widths[column] ?? 0;
    segments.push({
      text:
        column === last && cell.align === "start"
          ? cell.text
          : padTo(cell.text, width, cell.align),
      variable: cell.variable,
    });
  }
  return segments;
}

/** A table: the header row, when there is one, above one line per row. */
export function tableLines(
  headers: readonly PlacedCell[] | undefined,
  rows: readonly (readonly PlacedCell[])[],
): readonly Line[] {
  const widths = columnWidths(rows, headers);
  const lines: Line[] = [];
  if (headers !== undefined) lines.push(cellLine(headers, widths));
  for (const row of rows) lines.push(cellLine(row, widths));
  return lines;
}

/**
 * How many columns a flow of items of this width places into the width
 * available: as many as it affords, one when it affords no more, and never
 * more than there are items to put in them.
 */
export function flowColumnCount(
  items: number,
  itemWidth: number,
  available: number,
): number {
  // The last column carries no gap after it, so the room a column costs is its
  // own width plus one gap, measured against the width with one gap added.
  const affordable = Math.floor(
    (available + columnGap) / (itemWidth + columnGap),
  );
  return Math.max(1, Math.min(items, affordable));
}

/**
 * A flow: equal columns of the width available, read down each column before
 * across, so a list that arrived in order stays in order down the page.
 *
 * Every item is padded to the shared column width except the last on its line,
 * and a cell's declared alignment is ignored — the columns carry no per-column
 * meaning, so there is nothing for a cell to be aligned against. Its declared
 * variable survives, because that is a property of the cell rather than of a
 * column.
 *
 * The columns are recounted from the rows they turned out to need, so a flow
 * of six items into a width affording four columns is three columns of two
 * rather than three columns and an empty fourth.
 */
export function flowLines(
  items: readonly PlacedCell[],
  available: number,
): readonly Line[] {
  if (items.length === 0) return [];
  let itemWidth = 0;
  for (const item of items) {
    itemWidth = Math.max(itemWidth, displayWidth(item.text));
  }
  const affordable = flowColumnCount(items.length, itemWidth, available);
  const rows = Math.ceil(items.length / affordable);
  const columns = Math.ceil(items.length / rows);
  const lines: Line[] = [];
  for (let row = 0; row < rows; row += 1) {
    const placed: PlacedCell[] = [];
    for (let column = 0; column < columns; column += 1) {
      const item = items[column * rows + row];
      if (item !== undefined) placed.push(item);
    }
    // Every item is padded to the one shared width except the last on its
    // line, which is exactly what a table's last column does — so a flow's
    // line ends on a character of its own text too, and `cellLine` is what
    // both of them go through.
    lines.push(
      cellLine(
        placed.map((item) => ({ ...item, align: "start" as const })),
        placed.map(() => itemWidth),
      ),
    );
  }
  return lines;
}

/**
 * The body with its empty message and its summary around it.
 *
 * A grid with no lines of its own prints the empty message where its rows
 * would have been, and a summary is separated from whatever is above it by one
 * blank line — the same blank line whether that is the rows or the empty
 * message, so the spacing beneath a grid does not change with whether it
 * happened to have anything in it. A grid with nothing above the summary has
 * nothing for a blank line to separate it from, so it gets none.
 */
export function decorate(
  body: readonly Line[],
  empty: string | undefined,
  summary: string | undefined,
): readonly Line[] {
  const lines: Line[] = [...body];
  // Neither line is padded, so neither needs anything taken back off it: each
  // is the consumer's own string with its control characters removed and
  // nothing else changed.
  if (lines.length === 0 && empty !== undefined) {
    lines.push([{ text: sanitize(empty), variable: "content" }]);
  }
  if (summary !== undefined) {
    if (lines.length > 0) lines.push([]);
    lines.push([{ text: sanitize(summary), variable: "muted" }]);
  }
  return lines;
}

/** What a printed grid is laid out from: the request's own fields, with the
 * width a width-dependent layout decides against already resolved. */
export type GridLayout = {
  readonly layout: "table" | "flow";
  readonly headers: readonly string[] | undefined;
  readonly rows: readonly Row[];
  readonly empty: string | undefined;
  readonly summary: string | undefined;
  /** The columns the layout has to fit into. Only a flow reads it; a table
   * needs no width at all. */
  readonly columns: number;
};

/** Every line of a laid-out grid, in the order they are printed. */
export function gridLines({
  layout,
  headers,
  rows,
  empty,
  summary,
  columns,
}: GridLayout): readonly Line[] {
  if (layout === "flow") {
    return decorate(flowLines(flowItems(rows), columns), empty, summary);
  }
  // No rows means no header row either: a header over nothing names columns
  // that are not there.
  const count = columnCount(rows, headers);
  const body =
    rows.length === 0
      ? []
      : tableLines(headerCells(headers, count), tableCells(rows, count));
  return decorate(body, empty, summary);
}
