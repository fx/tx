/** The most option rows a select ever renders at once. Ten is the largest
 * window that still leaves a reasonable terminal usable, and small enough that
 * the hidden counts the indicators carry mean something. */
export const maximumOptionRows = 10;

/**
 * Every row a select can draw that is not an option row:
 *
 * 1. the panel's top edge, carrying the request message as its title;
 * 2. the filter prompt row;
 * 3. the `▲ N more` overflow indicator;
 * 4. the `▼ N more` overflow indicator;
 * 5. the panel's bottom edge;
 * 6. the top edge of the panel of a field it may go on to collect, carrying
 *    that field's message as its title;
 * 7. that field's value row;
 * 8. that field's bottom edge;
 * 9. the key hint line under the lowest panel.
 *
 * A select that is not collecting a field spends rows 6 to 9 on its own hint
 * line alone, so collection is the worst case and the only one this counts.
 *
 * It is one constant, and a fixed count of every such row rather than a count
 * of the rows a particular frame happens to draw, for two reasons. The window
 * keeps its height as a filter narrows the list past an indicator, instead of
 * growing a row under the cursor bar. And choosing a user-provided option adds
 * the field's panel to a window already on screen, so a window sized without it
 * would push that frame to the terminal's full height, which is the one thing
 * the height exists to prevent.
 */
export const selectChromeHeight = 9;

/** The option rows a select renders, given what is visible and how tall the
 * terminal is. The `- 1` is load-bearing: Ink treats output as tall as the
 * terminal as full-screen and clears the terminal when such output is replaced
 * or unmounted, so the dialog stays strictly shorter than the terminal to keep
 * Ink in its ordinary incremental mode. One row is the floor wherever the
 * terminal can afford one and there is an option to show — and where the
 * terminal cannot afford a row, or there is nothing visible to fill it, the
 * count is none at all, because a row the terminal cannot afford is exactly
 * the row that would push the frame to full height and clear the screen on
 * the way out. Staying under that ceiling is the stronger promise: a window
 * the reader cannot see beats a terminal wiped out from under them. */
export function optionRowCount(
  visibleCount: number,
  terminalRows: number,
): number {
  const affordable = terminalRows - selectChromeHeight - 1;
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
): OptionWindow {
  const count = optionRowCount(visibleCount, terminalRows);
  const furthestStart = Math.max(0, visibleCount - count);
  let start = Math.min(Math.max(0, previousStart), furthestStart);
  // A window of no rows has nowhere to bring the active option back to, and
  // chasing it there would put the window one row past the end of an empty
  // list and count a hidden option that does not exist.
  if (count > 0) {
    if (activeIndex < start) start = activeIndex;
    else if (activeIndex > start + count - 1) start = activeIndex - count + 1;
  }
  return {
    start,
    count,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, visibleCount - start - count),
  };
}
