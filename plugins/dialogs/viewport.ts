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

/** The rows a select's chrome takes in the state it is in. */
function chromeHeight(collecting: boolean): number {
  return collecting ? collectingChromeHeight : selectChromeHeight;
}

/** The option rows a select renders, given what is visible, how tall the
 * terminal is, and whether a field is being collected under the list. The `- 1`
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
): number {
  const affordable = terminalRows - chromeHeight(collecting) - 1;
  if (affordable < 1 || visibleCount < 1) return 0;
  return Math.max(1, Math.min(maximumOptionRows, affordable, visibleCount));
}

/** The slice of the visible options a select renders, and what it hides. */
export type OptionWindow = {
  /** Position within the visible list of the first rendered option. */
  readonly start: number;
  /** How many options are rendered, starting there. */
  readonly count: number;
  /** Visible options before the window, so the indicator can count them. */
  readonly hiddenAbove: number;
  /** Visible options after the window. */
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
 */
export function optionWindow(
  visibleCount: number,
  activeIndex: number,
  previousStart: number,
  terminalRows: number,
  collecting: boolean,
): OptionWindow {
  const count = optionRowCount(visibleCount, terminalRows, collecting);
  const furthestStart = Math.max(0, visibleCount - count);
  let start = Math.min(Math.max(0, previousStart), furthestStart);
  if (count > 0) {
    if (activeIndex < start) start = activeIndex;
    else if (activeIndex > start + count - 1) start = activeIndex - count + 1;
  } else {
    // A collapsed window has no rows for anything to sit above, and nowhere to
    // bring the active option back to. A start left over from a taller terminal
    // would count options as hidden above rows that are not there and spend one
    // of the few rows left saying so, which is the row that pushes the frame to
    // the terminal's own height.
    start = 0;
  }
  return {
    start,
    count,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, visibleCount - start - count),
  };
}
