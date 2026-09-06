import type { ThemeVariable } from "@fx/tx/theme";
import type { SelectOption } from "./contract.ts";
import { displayWidth, padToWidth } from "./frame.ts";
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

/** What separates one cell of a row from the next. Two spaces, fixed here so
 * the gap has one source: it is part of the same glyph and wording contract
 * that fixes the divider and the marker, and a gap decided at each of the
 * places that draws or measures one would be a gap that could disagree with
 * itself. */
export const fieldGap = "  ";

/** The columns that gap takes. */
const fieldGapWidth = 2;

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

/** One piece of a drawn row: what it says and what it is. The variable is a
 * role rather than an appearance — what any of them looks like is the theme's
 * business, not this module's. */
export type ColumnPart = {
  readonly text: string;
  readonly variable: ThemeVariable;
};

/** One column's contribution to one row of the band, as the pieces it draws
 * from left to right. Together they are exactly the column's width. */
export type ColumnCell = ColumnPart & {
  /** Already padded to the columns the marker left it, so the cursor bar spans
   * the column and the column after it starts where it should. */
  readonly text: string;
  /** What the row is: the row under the cursor is the `cursor` variable and
   * spans the whole column, the header row is `chrome`, and every other row is
   * plain `content`. */
  readonly variable: ThemeVariable;
  /** The marker set on the column's right edge, on a row that leads somewhere
   * in a column wide enough to carry one. It is its own piece because it
   * annotates the row rather than belonging to it, and so names the `marker`
   * variable rather than the row's own — except under the cursor bar, which
   * spans its column's full width and therefore owns every piece in it. */
  readonly marker?: ColumnPart;
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

/**
 * The width of each field of a column of cell options: every field as wide as
 * the widest cell drawn in it, its header included where one is declared.
 *
 * The vector sibling of the scalar `widestLabel` a column of labels measures
 * to, and measured over exactly the same thing: the whole visible list rather
 * than the rows one frame happens to draw, so scrolling does not resize a
 * field under the cursor bar. A header is measured with the cells because it
 * is drawn over them — a field narrower than its own name would say less than
 * the column it names.
 */
export function fieldWidths(
  rows: Iterable<readonly string[]>,
): readonly number[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (const [at, text] of row.entries()) {
      widths[at] = Math.max(widths[at] ?? 0, displayWidth(text));
    }
  }
  return widths;
}

/** The columns a row of fields takes: the fields themselves and the fixed gap
 * between each pair of them. The sibling of `columnsWidth`, which counts a run
 * of columns and their dividers the same way. */
export function fieldsWidth(fields: readonly number[]): number {
  if (fields.length === 0) return 0;
  let total = fieldGapWidth * (fields.length - 1);
  for (const width of fields) total += width;
  return total;
}

/**
 * The columns one column of cell options takes: its fields, the gaps between
 * them, the marker an expandable column reserves on every row, and what an
 * empty list would need.
 *
 * The sibling of `columnWidth` for a column measured as a vector, and stated
 * in terms of it: the marker's reserve and the empty column's floor are the
 * same rules whatever an option's display text is, and a column that decided
 * them twice could decide them differently.
 */
export function cellsColumnWidth(
  fields: readonly number[],
  expandable: boolean,
  empty: boolean,
): number {
  return columnWidth(fieldsWidth(fields), expandable, empty);
}

/**
 * The field widths a column of this many columns affords.
 *
 * The last field takes whatever the column has spare and gives it back first
 * when the column is cut, which is the rule `stretchLastColumn` and
 * `fitColumnWidths` already follow for the columns themselves. The fields
 * before it keep the widths they were measured at, so a terminal being resized
 * moves the end of a row rather than every field in it, and a cell that does
 * not fit loses its own characters rather than shifting the fields after it.
 *
 * A column too narrow even for the gaps leaves every field at nothing; the row
 * built from it is cut to the column when it is laid out, which is the same
 * cut a single over-long label takes.
 */
export function fitFieldWidths(
  fields: readonly number[],
  room: number,
): readonly number[] {
  const slack = room - fieldsWidth(fields);
  if (fields.length === 0 || slack === 0) return fields;
  const fitted = [...fields];
  const last = fitted.length - 1;
  if (slack > 0) {
    fitted[last] = (fitted[last] as number) + slack;
    return fitted;
  }
  let deficit = -slack;
  for (let at = last; at >= 0 && deficit > 0; at -= 1) {
    const taken = Math.min(fitted[at] as number, deficit);
    fitted[at] = (fitted[at] as number) - taken;
    deficit -= taken;
  }
  return fitted;
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

/** The narrowest column that can carry a marker: the marker's own reserved
 * columns and one column of label to mark. Below it the marker is dropped
 * rather than squeezed — a row reading `▸` alone says where it leads but not
 * what it is, which is less use than the first character of its label. */
const markableWidth = expandMarkerWidth + 1;

/** The columns the marker holds on a row of this column: its own reserve where
 * the row leads somewhere and the column is wide enough to carry it, and none
 * otherwise. Asked once, by the row being built and by the fields being fitted
 * into it, so the two cannot disagree about how much room is left. */
function markerRoom(width: number, marked: boolean): number {
  return marked && width >= markableWidth ? expandMarkerWidth : 0;
}

/**
 * One cell, cut and padded to its column, with the marker set on its right
 * edge when the option it draws opens a sub-dialog.
 *
 * Whether the column can afford a marker is decided before the width is split,
 * which is what makes the result exactly `width` columns wide for every width
 * of one or more. Splitting first and clamping each half afterwards is where
 * the text's room and the marker's room stop agreeing, and a cell over its
 * budget is then only as safe as whatever cuts the row it lands in.
 */
function cell(
  text: string,
  width: number,
  marked: boolean,
  variable: ThemeVariable,
): ColumnCell {
  const held = markerRoom(width, marked);
  if (held === 0) return { text: padToWidth(text, width), variable };
  // The marker's columns are exactly the separating space and the glyph, so
  // what is left is the text's and the two parts sum to `width`.
  return {
    text: padToWidth(text, width - held),
    variable,
    marker: {
      text: ` ${expandGlyph}`,
      // The bar spans its column's full width, so a marker under it is part of
      // the bar rather than a hole in one. Everywhere else the glyph is the
      // annotation it is, and names the variable for one.
      variable: variable === "cursor" ? "cursor" : "marker",
    },
  };
}

/**
 * One row of cells laid into the fields of its column: each cell padded or cut
 * to its own field, the fields separated by the fixed gap, and the run placed
 * in the column exactly as a label is.
 *
 * Going through `cell` rather than beside it is what keeps the marker, the
 * width guarantee, and the truncation one decision: a row of fields is a
 * longer string in the same column, not a second kind of thing to fit.
 */
function cellsRow(
  texts: readonly string[],
  fields: readonly number[],
  width: number,
  marked: boolean,
  variable: ThemeVariable,
): ColumnCell {
  const row = fields
    // A column's rows are uniform by the time they are drawn — the request
    // validation rejects a column of uneven rows before anything is
    // measured — so a field with no cell is the empty column's case rather
    // than a ragged row's.
    .map((field, at) => padToWidth(texts[at] ?? "", field))
    .join(fieldGap);
  return cell(row, width, marked, variable);
}

/** What a column of cell options draws with, over and above what a column of
 * labels needs: the widths its fields were measured at, the names drawn over
 * them, and whether the column reserved the marker. The reserve belongs to the
 * column rather than to the rows carrying a marker, so every row of the column
 * fits its cells into the same fields and they start at the same columns. */
export type CellLayout = {
  readonly fields: readonly number[];
  readonly headers: readonly string[];
  readonly expandable: boolean;
};

/**
 * The cells one column contributes to the band, one per row and `undefined`
 * wherever this column has nothing for that row. The columns share one band so
 * a list of three and a list of thirty start on the same row.
 *
 * Every column goes through here, the one being driven and every one behind
 * it, so a column a sub-dialog was opened from keeps drawing the list it was
 * showing with the bar still on the choice that opened it.
 *
 * A column of cell options passes its layout; a column of labels passes none
 * and is measured and drawn against one scalar width, exactly as it was before
 * cells existed.
 */
export function columnCells<T>(
  options: readonly SelectOption<T>[],
  visible: readonly number[],
  viewport: OptionWindow,
  active: number,
  width: number,
  bandRows: number,
  dressing: { readonly bar: boolean },
  layout?: CellLayout,
): readonly (ColumnCell | undefined)[] {
  const cells: (ColumnCell | undefined)[] = [];
  for (let row = 0; row < bandRows; row += 1) cells.push(undefined);
  // A band of no rows is a terminal that could not afford one, and nothing
  // this column has to say is worth a row nobody budgeted for — not its
  // header, and not the row it would otherwise spend saying that its filter
  // matched nothing. Returning early keeps what this function hands back
  // exactly as long as the band it was asked for.
  if (bandRows === 0) return cells;
  // Fitted once for the whole column rather than per row: the marker's reserve
  // is the column's, so an unmarked row among marked ones lays its cells into
  // the same fields and simply spends the marker's columns on padding.
  const fitted =
    layout === undefined
      ? undefined
      : {
          fields: fitFieldWidths(
            layout.fields,
            width - markerRoom(width, layout.expandable),
          ),
          headers: layout.headers,
        };
  /** Whether this column draws anything at all. A window the terminal could
   * not afford draws no rows, and a header over rows that are not there would
   * be one row of chrome the viewport's arithmetic never budgeted for. */
  const drawsRows = visible.length === 0 || viewport.count > 0;
  // The header is a row of the band rather than an option: the filter never
  // sees it, the active position can never address it, and it does not scroll
  // with the rows beneath it. It is chrome, because it names the list rather
  // than belonging to it.
  const header =
    fitted === undefined || fitted.headers.length === 0 || !drawsRows
      ? undefined
      : cellsRow(fitted.headers, fitted.fields, width, false, "chrome");
  if (header !== undefined) cells[0] = header;
  const first = header === undefined ? 0 : 1;
  if (visible.length === 0) {
    cells[first] = cell(noMatch, width, false, "content");
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
    const variable = barred ? "cursor" : "content";
    const marked = option.dialog !== undefined;
    // A column holds one shape, which the request validation settled before
    // anything was measured: the empty fallbacks are the shape that cannot be
    // here rather than a label read as a one-cell row, which is the misreading
    // the two shapes are separate to avoid.
    cells[first + row] =
      fitted === undefined
        ? cell(option.label ?? "", width, marked, variable)
        : cellsRow(option.cells ?? [], fitted.fields, width, marked, variable);
  }
  return cells;
}
