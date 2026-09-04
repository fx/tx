/** The most option rows a select ever renders at once. Ten is the largest
 * window that still leaves a reasonable terminal usable, and small enough that
 * the hidden counts the indicators carry mean something. */
export const maximumOptionRows = 10;

/**
 * Every row a select draws that is not an option row while it is choosing:
 *
 * 1. the panel's top edge, carrying the request message as its title;
 * 2. the filter prompt row;
 * 3. the `▲ N more` overflow indicator;
 * 4. the `▼ N more` overflow indicator;
 * 5. the panel's bottom edge;
 * 6. the key hint line under the panel.
 *
 * It is a fixed count of every row the state can draw rather than a count of
 * the rows one frame happens to draw, so the window keeps its height as a
 * filter narrows the list past an indicator instead of growing a row under the
 * cursor bar.
 */
export const selectChromeHeight = 6;

/**
 * The same count once a user-provided option's field is being collected, which
 * puts a second panel on screen: rows 1 to 5 above, unchanged, and then
 *
 * 6. the field panel's top edge, carrying that field's message as its title;
 * 7. the field's value row;
 * 8. the field panel's bottom edge;
 * 9. the key hint line, which belongs to the field once the select's own keys
 *    have stopped working, so the select spends no row on a hint of its own.
 *
 * It is a second constant rather than one worst-case number because the field's
 * rows are on screen only while a field is collected, and reserving them the
 * rest of the time starves every short terminal of the option rows it can
 * afford. The window is derived on every frame, so the frame that first draws
 * the field is sized against this count and shrinks to fit it.
 */
export const collectingChromeHeight = 9;

/** The columns each stacked level sits right of its parent, so levels above
 * the root read as overlapping offset panels rather than as panels underneath.
 * Kept in one place with the shadow budget below, because the view's clamping
 * and the tests' overlap assertions read the same numbers the layout draws. */
export const stackedOffsetColumns = 2;

/** The rows one stacked level's shadow costs the viewport budget: the shadow
 * is a dimmed block-fill box behind each panel above the root, one column and
 * one row down and right from its parent, so exactly one row of it stays
 * visible beneath the panel it backs. The panel rows themselves overlap their
 * parent's, which is why the shadow row is the only thing a level above the
 * root adds to the height. */
export const stackedShadowRows = 1;

/** The rows the whole dialog may take beyond one level's chrome: one shadow
 * row per stacked level above the root. A flat stack is the root alone and
 * adds nothing; deeper stacks add one row per level, because every panel above
 * the root carries its own dimmed block-fill box. Separate from the chrome
 * heights because these rows belong to the stack rather than to the choosing
 * state — a flat dialog never draws them. */
export function stackedExtraRows(depth: number): number {
  return Math.max(0, depth - 1) * stackedShadowRows;
}

/** The rows a select's chrome takes in the state it is in. */
function chromeHeight(collecting: boolean): number {
  return collecting ? collectingChromeHeight : selectChromeHeight;
}

/** The option rows a select renders, given what is visible, how tall the
 * terminal is, whether a field is being collected under the list, and how many
 * shadow rows the stacked levels above the root add. The `- 1`
 * is load-bearing: Ink treats output as tall as the terminal as full-screen and
 * clears the terminal when such output is replaced or unmounted, so the dialog
 * stays strictly shorter than the terminal to keep Ink in its ordinary
 * incremental mode. One row is the floor wherever the terminal can afford one
 * and there is an option to show — and where the terminal cannot afford a row,
 * or there is nothing visible to fill it, the count is none at all, because a
 * row the terminal cannot afford is exactly the row that would push the frame
 * to full height and clear the screen on the way out. Staying under that
 * ceiling is the stronger promise: a window the reader cannot see beats a
 * terminal wiped out from under them. */
export function optionRowCount(
  visibleCount: number,
  terminalRows: number,
  collecting: boolean,
  extraRows = 0,
): number {
  if (visibleCount < 1) return 0;
  const affordable = terminalRows - chromeHeight(collecting) - extraRows - 1;
  // A stack deeper than the budget still renders the top level with one row:
  // lower levels may be covered, the top never is. A flat dialog with no
  // room still draws nothing rather than clearing the terminal.
  if (affordable < 1) return extraRows > 0 ? 1 : 0;
  return Math.max(1, Math.min(maximumOptionRows, affordable, visibleCount));
}

/**
 * The slice of the visible options a select renders, and what it hides.
 *
 * The window carries two starts because a terminal too short to draw it must
 * not cost it its place in the list. Wherever a row is drawn the two are the
 * same number; they part only when the window has collapsed to no rows at all,
 * which is a state of the terminal rather than a move the user made.
 */
export type OptionWindow = {
  /** Position within the visible list of the first option this frame draws, and
   * so the position the view slices and numbers its rows from. A collapsed
   * window draws from the top, because there is no row for anything to sit
   * above. */
  readonly renderedStart: number;
  /** How many options are rendered, starting at `renderedStart`. */
  readonly count: number;
  /** The start to carry into the next frame, which is where the window returns
   * to when it has rows again. It survives a collapse — the terminal took the
   * rows away, and the user did not give up the place they had scrolled to, so
   * growing the terminal back reopens the window there rather than dragging the
   * whole list under a cursor bar that never moved. */
  readonly rememberedStart: number;
  /** Visible options before the drawn window, so the indicator can count them.
   * A collapsed window reports none, whatever it remembers: counting options as
   * hidden above rows that are not there would spend one of the few rows left
   * on a second indicator, and that is the row that takes the frame to the
   * terminal's own height. */
  readonly hiddenAbove: number;
  /** Visible options after the drawn window, so a collapsed one reports the
   * whole list. */
  readonly hiddenBelow: number;
};

/**
 * Where the window sits now, given where it sat before. Positions are over the
 * visible list, so the window composes with the filter.
 *
 * The window moves as little as it can: it stays where it was unless the active
 * option has left it, and then it moves exactly far enough to bring that option
 * back to the edge it left by. That keeps the list still under the cursor bar,
 * where a centered-cursor window would move every row on every keystroke. A
 * window sitting past the end of a list the filter has just shortened is pulled
 * back so it stays full.
 *
 * A window with no rows to draw is the one case where what is drawn and what is
 * remembered come apart: it draws from the top, so it spends no row on an
 * indicator counting options above rows that are not there, and it remembers
 * the place it held, so the terminal growing back returns it there.
 */
export function optionWindow(
  visibleCount: number,
  activeIndex: number,
  previousStart: number,
  terminalRows: number,
  collecting: boolean,
  extraRows = 0,
): OptionWindow {
  const count = optionRowCount(
    visibleCount,
    terminalRows,
    collecting,
    extraRows,
  );
  const furthestStart = Math.max(0, visibleCount - count);
  // Clamped against the list as it stands, so a start left over from a longer
  // list is pulled back rather than remembered past the end of this one.
  let rememberedStart = Math.min(Math.max(0, previousStart), furthestStart);
  if (count > 0) {
    if (activeIndex < rememberedStart) rememberedStart = activeIndex;
    else if (activeIndex > rememberedStart + count - 1) {
      rememberedStart = activeIndex - count + 1;
    }
  }
  // A collapsed window has no row for anything to sit above, and no edge to
  // bring the active option back to, so it draws from the top whatever it
  // remembers.
  const renderedStart = count > 0 ? rememberedStart : 0;
  return {
    renderedStart,
    count,
    rememberedStart,
    hiddenAbove: renderedStart,
    hiddenBelow: Math.max(0, visibleCount - renderedStart - count),
  };
}
