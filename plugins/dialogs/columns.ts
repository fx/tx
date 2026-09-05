import { displayWidth, padToWidth, truncateEnd } from "./frame.ts";
import type { SelectOption } from "./types.ts";
import type { OptionWindow } from "./viewport.ts";

/**
 * The column browser a select is laid out as.
 *
 * A sub-dialog is not a panel of its own: it is the next column of the panel
 * its parent is already in. Opening one adds a column to the right, and the
 * frame around them all stays the frame the first level drew, so a stack three
 * levels deep is still one bordered panel with three lists side by side. That
 * is the whole reason nothing here draws a border, an offset, or a shadow —
 * there is only ever one frame, and it belongs to the root.
 *
 * Everything in this file is geometry over already-decided state, so the
 * widths, the collapsing, and the cells are pure and directly testable.
 */

/** The marker on the right of an option that opens a sub-dialog, so a list
 * says which of its rows lead somewhere before the reader tries one. */
export const expandGlyph = "▸";

/** The columns the marker takes on every row of a column that has one: the
 * glyph and the space that separates it from the longest label. Reserved for
 * the whole column rather than for the rows that carry it, so the markers line
 * up on one edge instead of tracking each label's own length. */
const expandMarkerWidth = 2;

/** What separates one column from the next. */
export const columnDivider = "│";

/** The columns a divider takes, spaces either side included. */
export const dividerWidth = 3;

/** The overflow indicators, each carrying how many visible options the window
 * hides on its side. They are set into the frame's own edges rather than drawn
 * as rows of the panel: an indicator that comes and goes as the reader scrolls
 * would take every option row with it each time, and the reader who is
 * scrolling is exactly the one who cannot afford the list to move under them.
 */
export const hiddenAboveGlyph = "▲";
export const hiddenBelowGlyph = "▼";

/** What a column shows when its filter text leaves nothing visible. */
export const noMatch = "no match";

/** One column's contribution to one row of the band. */
export type ColumnCell = {
  /** Already padded to the column's width, so the inverted bar spans the
   * column and the column after it starts where it should. */
  readonly text: string;
  readonly dim: boolean;
  /** The cursor bar, spanning the whole column: the terminal's own inversion,
   * and the only thing marking the row. */
  readonly inverse: boolean;
};

/** The text of an overflow indicator carrying a count. Compact, because it is
 * set into an edge that a title is already competing for: on a frame the glyph
 * and the number say everything the words used to. */
export function indicatorText(glyph: string, count: number): string {
  return `${glyph} ${count}`;
}

/**
 * The columns one list takes: its widest visible label, the marker an
 * expandable column reserves on every row, and what an empty list would need.
 *
 * Measured over the whole visible list rather than over the rows one frame
 * happens to draw, so scrolling a column does not resize it under the cursor
 * bar. The overflow counts are not measured here at all, because they are set
 * into the frame rather than drawn in the column.
 */
export function columnWidth(
  widestLabel: number,
  expandable: boolean,
  empty: boolean,
): number {
  const width = widestLabel + (expandable ? expandMarkerWidth : 0);
  return Math.max(1, empty ? Math.max(width, displayWidth(noMatch)) : width);
}

/** The columns a run of columns takes with its dividers. */
export function columnsWidth(widths: readonly number[]): number {
  if (widths.length === 0) return 0;
  let total = dividerWidth * (widths.length - 1);
  for (const width of widths) total += width;
  return total;
}

/**
 * How many columns are dropped off the left so the rest fit the width
 * available.
 *
 * Running out of room collapses the oldest columns first: the one being driven
 * is the rightmost and must always be on screen, and the levels behind it are
 * the ones the reader has already decided. The last column is never dropped,
 * however narrow the terminal — it is truncated instead, which is what every
 * other row of a dialog does when it runs out of columns.
 */
export function droppedColumns(
  widths: readonly number[],
  available: number,
): number {
  let dropped = 0;
  while (
    widths.length - dropped > 1 &&
    columnsWidth(widths.slice(dropped)) > available
  ) {
    dropped += 1;
  }
  return dropped;
}

/**
 * The kept columns' widths, with the last one cut back when the run still does
 * not fit. Collapsing stops at one column, so the last is the one that has to
 * give: it is truncated rather than dropped, because the column being driven
 * must be on screen whatever the terminal is doing.
 */
export function fitColumnWidths(
  widths: readonly number[],
  available: number,
): readonly number[] {
  if (widths.length === 0 || columnsWidth(widths) <= available) return widths;
  const last = widths.length - 1;
  const before =
    last > 0 ? columnsWidth(widths.slice(0, last)) + dividerWidth : 0;
  return [...widths.slice(0, last), Math.max(1, available - before)];
}

/**
 * The kept columns' widths with the room left over given to the last of them.
 *
 * A panel is as wide as the widest thing in it, and that is not always a
 * label — a long title, or a filter row carrying more text than any option,
 * makes the frame wider than the columns need. The slack goes to the last
 * column so its cursor bar spans the panel rather than stopping short of it,
 * which is what a select with one column has always looked like.
 */
export function stretchLastColumn(
  widths: readonly number[],
  inner: number,
): readonly number[] {
  const slack = inner - columnsWidth(widths);
  if (widths.length === 0 || slack <= 0) return widths;
  const last = widths.length - 1;
  return [...widths.slice(0, last), (widths[last] as number) + slack];
}

/** One cell, cut and padded to its column, with the marker set on its right
 * edge when the option it draws opens a sub-dialog. */
function cell(
  text: string,
  width: number,
  marked: boolean,
  dim: boolean,
  inverse: boolean,
): ColumnCell {
  if (!marked) return { text: padToWidth(text, width), dim, inverse };
  const room = Math.max(1, width - expandMarkerWidth);
  return {
    text: `${padToWidth(text, room)} ${truncateEnd(expandGlyph, Math.max(0, width - room - 1))}`,
    dim,
    inverse,
  };
}

/**
 * The cells one column contributes to the band, one per row and `undefined`
 * wherever this column has nothing for that row. The columns share one band so
 * a list of three and a list of thirty start on the same row.
 *
 * Every column goes through here, the one being driven and every one behind
 * it, so a column a sub-dialog was opened from keeps drawing the list it was
 * showing with the bar still on the choice that opened it.
 */
export function columnCells<T>(
  options: readonly SelectOption<T>[],
  visible: readonly number[],
  viewport: OptionWindow,
  active: number,
  width: number,
  bandRows: number,
  dressing: { readonly bar: boolean },
): readonly (ColumnCell | undefined)[] {
  const cells: (ColumnCell | undefined)[] = [];
  for (let row = 0; row < bandRows; row += 1) cells.push(undefined);
  if (visible.length === 0) {
    cells[0] = cell(noMatch, width, false, false, false);
    return cells;
  }
  for (let row = 0; row < viewport.count; row += 1) {
    const position = viewport.renderedStart + row;
    const index = visible[position] as number;
    const option = options[index] as SelectOption<T>;
    const barred = position === active && dressing.bar;
    // The bar is the same bar in every column: the choice each was left on is
    // the choice that led here, and shading the ones behind would say the same
    // thing a second time in a second way.
    cells[row] = cell(
      option.label,
      width,
      option.dialog !== undefined,
      false,
      barred,
    );
  }
  return cells;
}
