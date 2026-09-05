/** The most option rows a select ever renders at once. Ten is the largest
 * window that still leaves a reasonable terminal usable, and small enough that
 * the hidden counts the indicators carry mean something. */
export const maximumOptionRows = 10;

/**
 * Every row a select draws that is not an option row while it is choosing:
 *
 * 1. the panel's top edge, carrying the title and the `▲ N` count;
 * 2. the panel's bottom edge, carrying the filter and the `▼ N` count;
 * 3. the key hint line under the panel.
 *
 * The filter and the two overflow counts cost no rows, because they are set
 * into the edges the panel was already spending those two rows on. That is
 * what keeps the list still: a row that appears when the filter turns on, or
 * when scrolling first hides something above, would move every option row
 * under a reader who is in the middle of typing or scrolling.
 */
export const selectChromeHeight = 3;

/**
 * The same count once a user-provided option's field is being collected, which
 * puts a second panel on screen: the select's two edges above, and then
 *
 * 3. the field panel's top edge, carrying that field's message as its title;
 * 4. the field's value row;
 * 5. the field panel's bottom edge;
 * 6. the key hint line, which belongs to the field once the select's own keys
 *    have stopped working, so the select spends no row on a hint of its own.
 *
 * It is a second constant rather than one worst-case number because the field's
 * rows are on screen only while a field is collected, and reserving them the
 * rest of the time starves every short terminal of the option rows it can
 * afford. The window is derived on every frame, so the frame that first draws
 * the field is sized against this count and shrinks to fit it.
 */
export const collectingChromeHeight = 6;

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
  if (visibleCount < 1) return 0;
  const affordable = terminalRows - chromeHeight(collecting) - 1;
  if (affordable < 1) return 0;
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
): OptionWindow {
  const count = optionRowCount(visibleCount, terminalRows, collecting);
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
