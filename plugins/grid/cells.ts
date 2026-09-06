import type { ThemeVariable } from "@fx/tx/theme";
import type { Cell, Row } from "./contract.ts";

/**
 * What a consumer's text becomes before anything measures or draws it.
 *
 * A cell's text arrives from the consumer, and a consumer's text arrives from
 * a file, a process, or a network response — somewhere it does not control. So
 * it is treated as data: control characters are removed, an empty cell is
 * given a placeholder, and a short row is filled out to the grid's column
 * count. Nothing here is trimmed, wrapped, re-cased, or re-ordered.
 */

/**
 * The terminal columns a string occupies, which is what every width in the
 * grid is counted in. A string's `length` counts UTF-16 code units, and
 * neither wide characters nor astral ones occupy one column each: two
 * ideographs are two code units and four columns, so a column sized by
 * `length` would leave the row beside it misaligned. The runtime measures this
 * itself, which is why no width library is imported for it.
 */
export function displayWidth(text: string): number {
  return Bun.stringWidth(text);
}

/**
 * What an empty cell renders as, so a missing value takes a column of its own
 * rather than leaving a hole the eye reads as an alignment bug.
 *
 * Fixed rather than caller-supplied: grids across plugins looking alike is the
 * stronger default until someone has a reason. It is substituted for a cell
 * alone — never for a header, an empty message, or a summary, which are the
 * consumer's to leave blank.
 */
export const placeholder = "—";

/**
 * Every control character removed: the C0 range, delete, and the C1 range,
 * which is what `\p{Cc}` is.
 *
 * Removal rather than escaping or rejection. The text is not the consumer's
 * own, so rejecting would turn one bad row into a failed command and escaping
 * would render noise; what the printing contract promises about the bytes that
 * reach the terminal has to hold for the payload as received. A newline or a
 * carriage return would break the row apart, an escape sequence would reach
 * the terminal as a command, and a tab would misalign every column after it.
 */
const controlCharacters = /\p{Cc}/gu;

/** One consumer-supplied string, made safe to measure and draw. Applied to
 * every string the grid renders without exception — a cell's text, a header,
 * the empty message, and the summary — because a guarantee that held for only
 * some of them would not be a guarantee. */
export function sanitize(text: string): string {
  return text.replace(controlCharacters, "");
}

/** A cell with every decision already made: its text safe and never empty, its
 * role named, and the edge it is padded at chosen. */
export type PlacedCell = {
  readonly text: string;
  readonly variable: ThemeVariable;
  readonly align: "start" | "end";
};

/** One supplied cell as a placed one. A bare string is exactly the cell it
 * would make with no variable and no alignment; an absent `variable` names
 * `content` and an absent `align` names `start`, so neither is left for the
 * renderer to decide. */
export function placeCell(cell: Cell | string): PlacedCell {
  const supplied: Cell = typeof cell === "string" ? { text: cell } : cell;
  const text = sanitize(supplied.text);
  return {
    text: text === "" ? placeholder : text,
    variable: supplied.variable ?? "content",
    align: supplied.align ?? "start",
  };
}

/** What fills a column a row did not supply a cell for. */
function missingCell(): PlacedCell {
  return { text: placeholder, variable: "content", align: "start" };
}

/** One header as a placed cell: emphasized relative to the rows, padded at its
 * end like any cell declaring no alignment, and left blank where it is blank —
 * the placeholder is for cells alone. */
function placeHeader(text: string): PlacedCell {
  return { text: sanitize(text), variable: "strong", align: "start" };
}

/**
 * A grid's column count: the most cells any one row supplies, or the number of
 * headers where there are more of those than that.
 *
 * A row supplying fewer is filled out rather than shortened, so a set of rows
 * differing in cell count is a grid with holes in it rather than a ragged one.
 */
export function columnCount(
  rows: readonly Row[],
  headers: readonly string[] | undefined,
): number {
  let count = headers?.length ?? 0;
  for (const row of rows) count = Math.max(count, row.length);
  return count;
}

/** The rows of a table: every row placed and filled out to the column count,
 * so every row has a cell for every column. */
export function tableCells(
  rows: readonly Row[],
  count: number,
): readonly (readonly PlacedCell[])[] {
  return rows.map((row) => {
    const cells: PlacedCell[] = [];
    for (let column = 0; column < count; column += 1) {
      const cell = row[column];
      cells.push(cell === undefined ? missingCell() : placeCell(cell));
    }
    return cells;
  });
}

/** The header row of a table, or nothing where none was supplied or the list
 * supplied was empty — which says there are no headers rather than that there
 * is a row of blank ones. */
export function headerCells(
  headers: readonly string[] | undefined,
  count: number,
): readonly PlacedCell[] | undefined {
  if (headers === undefined || headers.length === 0) return undefined;
  const cells: PlacedCell[] = [];
  for (let column = 0; column < count; column += 1) {
    cells.push(placeHeader(headers[column] ?? ""));
  }
  return cells;
}

/**
 * The items of a flow: the cells of every row, flattened in row order and,
 * within a row, in cell order.
 *
 * Rows are how a request carries cells and only a table gives their shape any
 * further meaning, so a row of one cell contributes one item and a row of
 * several contributes several. Nothing is joined, rejected, or padded out to a
 * common length here — a flow has no columns for that to mean anything in.
 */
export function flowItems(rows: readonly Row[]): readonly PlacedCell[] {
  const items: PlacedCell[] = [];
  for (const row of rows) {
    for (const cell of row) items.push(placeCell(cell));
  }
  return items;
}
