/** The most option rows a select ever renders at once. Ten is the largest
 * window that still leaves a reasonable terminal usable, and small enough that
 * the hidden counts the indicators carry mean something. */
export const maximumOptionRows = 10;

/**
 * Every row a select can draw that is not an option row: the request message,
 * the filter prompt, the two overflow indicators, and the message and value of
 * a field it may go on to collect.
 *
 * It is one constant, and a fixed count of every such row rather than a count
 * of the rows a particular frame happens to draw, for three reasons. The window
 * keeps its height as a filter narrows the list past an indicator, instead of
 * growing a row under the cursor bar. Choosing a user-provided option adds the
 * field's rows to a window already on screen, and a window sized without them
 * would push that frame to the terminal's full height, which is the one thing
 * the height exists to prevent. And the later restyling changes the number of
 * non-option rows a dialog draws — frame edges and a hint line — by editing
 * this one number rather than arithmetic spread through the view.
 */
export const selectChromeHeight = 6;

/** The option rows a select renders, given what is visible and how tall the
 * terminal is. The `- 1` is load-bearing: Ink treats output as tall as the
 * terminal as full-screen and clears the terminal when such output is replaced
 * or unmounted, so the dialog stays strictly shorter than the terminal to keep
 * Ink in its ordinary incremental mode. One row is the floor — a terminal too
 * short even for that is beyond what the dialog can promise. */
export function optionRowCount(
  visibleCount: number,
  terminalRows: number,
): number {
  const affordable = terminalRows - selectChromeHeight - 1;
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
  if (activeIndex < start) start = activeIndex;
  else if (activeIndex > start + count - 1) start = activeIndex - count + 1;
  return {
    start,
    count,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, visibleCount - start - count),
  };
}
