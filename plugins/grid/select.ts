import type {
  SelectOption as DialogOption,
  SelectRequest as DialogRequest,
} from "@fx/tx/dialogs";
import {
  columnCount,
  headerCells,
  type PlacedCell,
  sanitize,
  tableCells,
} from "./cells.ts";
import type {
  GridAction,
  GridSelection,
  GridSelectRequest,
  GridSelectRow,
} from "./contract.ts";

/**
 * A grid request as a select request, and the answer back as a row and an
 * action.
 *
 * Everything a driven grid does beside this is already owned elsewhere:
 * movement, filtering, the viewport, the cursor bar, the drilling into a
 * column, and cancellation belong to Dialogs, and the cells, the column count,
 * and the sanitation belong to the printing half of this plugin. This module
 * re-implements none of it. What is genuinely new is the mapping back, and it
 * is new because a sub-dialog resolves with the completing option's value
 * alone: a row's actions column completes on an action, so a naive composition
 * would answer with the action and lose the row it was chosen for.
 *
 * The fix is to make the value carried through the dialog identify both. It is
 * an index pair rather than the consumer's own values, so nothing about a
 * consumer's value has to be comparable, hashable, or unique for the answer to
 * come back whole.
 */

/**
 * What the grid carries through the dialog in place of the consumer's own
 * value: which row the choice was made on, and — where the choice was made in
 * that row's actions column — which action it was.
 *
 * Both fields are the grid's own indices rather than anything a consumer
 * supplied, which is what makes `action === undefined` a safe reading of "no
 * action was chosen" here: this module is the only writer, and it never writes
 * the key without a number in it. That reasoning does not carry over to the
 * selection this produces, whose `action` holds a consumer's own value —
 * `undefined` included, where a consumer chose it — so there the absence is
 * said by the key not being there at all.
 */
export type RowChoice = {
  readonly row: number;
  readonly action?: number;
};

/**
 * One row as an option of the rows column.
 *
 * A declared `variable` and a declared `align` are dropped here rather than
 * smuggled through: a select takes an option's cells as display text, and its
 * cursor bar is the inversion alone, so there is nothing on that side for
 * either to be expressed against.
 *
 * A row's actions become the sub-dialog that row opens, so acting on a row is
 * the drilling the column browser already owns rather than a second mechanism
 * beside it. A row declaring none — by an empty list exactly as by omitting
 * one — opens nothing and is taken by Enter like any plain option.
 */
function rowOption<T, A>(
  row: GridSelectRow<T, A>,
  cells: readonly PlacedCell[],
  index: number,
  message: string,
): DialogOption<RowChoice> {
  const texts = cells.map((cell) => cell.text);
  const actions = row.actions ?? [];
  if (actions.length === 0) return { cells: texts, value: { row: index } };
  return {
    cells: texts,
    value: { row: index },
    dialog: {
      // The actions column is titled by the row it belongs to, which is what
      // puts that row in the panel's trail beside the grid's own message. The
      // first cell is what identifies a row on screen; a request whose rows
      // carry no cells at all has nothing to title it with, and is rejected
      // before it renders as a column of options declaring no display text.
      message: texts[0] ?? message,
      options: actions.map((action, position) => ({
        label: sanitize(action.label),
        value: { row: index, action: position },
      })),
    },
  };
}

/**
 * A grid request as the select request that drives it.
 *
 * Every string a consumer supplied is sanitized on the way through, because
 * the grid is where text the consumer did not author enters `tx` and a
 * dialog's own callers own what they pass it.
 */
export function selectRequest<T, A>(
  request: GridSelectRequest<T, A>,
): DialogRequest<RowChoice> {
  const message = sanitize(request.message);
  const supplied = request.rows.map((row) => row.cells);
  // The printing half's own column rule and cell normalization, reused rather
  // than restated: every row sanitized, placeholdered where a cell was left
  // empty, and filled out to the one column count — which is also what
  // satisfies the select's requirement that every option of a column declare
  // the same number of cells, rather than passing a ragged set of rows through
  // to be rejected.
  const count = columnCount(supplied, request.headers);
  const cells = tableCells(supplied, count);
  const headers = headerCells(request.headers, count);
  return {
    message,
    ...(headers === undefined
      ? {}
      : { headers: headers.map((header) => header.text) }),
    options: request.rows.map((row, index) =>
      rowOption(row, cells[index] as readonly PlacedCell[], index, message),
    ),
  };
}

/**
 * The dialog's answer as a selection: the row the choice was made on and, when
 * it was made among that row's actions, the action it was.
 *
 * Both come back from the request the caller supplied rather than from
 * anything reconstructed, so a consumer never has to infer one from the other
 * and nothing about its values has to be re-identified.
 *
 * A row taken without an action gets a selection with no `action` key rather
 * than one holding `undefined`, because that key is where a consumer's own
 * action value lands and `undefined` is a value a consumer may choose. Absence
 * is therefore said by the key, and a consumer reads it with `"action" in`.
 */
export function selection<T, A>(
  request: GridSelectRequest<T, A>,
  choice: RowChoice,
): GridSelection<T, A> {
  const row = request.rows[choice.row] as GridSelectRow<T, A>;
  if (choice.action === undefined) return { value: row.value };
  const actions = row.actions ?? [];
  const action = actions[choice.action] as GridAction<A>;
  return { value: row.value, action: action.value };
}
