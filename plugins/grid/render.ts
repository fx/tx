import type { CoreDependencies } from "@fx/tx/plugin";
import {
  canvasWidth,
  defaultLayoutColumns,
  gridLines,
  type Line,
  type LineSegment,
} from "./geometry.ts";
import type { Theme, ThemeVariable } from "./theme.ts";
import type { GridRequest, OutputStream } from "./types.ts";

/**
 * A laid-out grid turned into elements and written to the stream the consumer
 * supplied.
 *
 * Two widths are in play and they are not the same. The *layout* width is what
 * a width-dependent layout decides against — only a flow has one — and it
 * comes from the stream on the request, or eighty columns when that stream
 * reports none, which is what makes a flow through a pipe determinate. The
 * *canvas* width is what the renderer is given, and it is the measured grid's
 * own width rather than the terminal's, so no line is padded out to a terminal
 * and the bytes emitted do not depend on how wide one happens to be.
 *
 * The render is one synchronous pass to a string: it opens no terminal
 * session, installs no input handler, enters no alternate screen, patches no
 * console, and emits no cursor-positioning, screen-clearing, or repaint
 * sequence. What it produces is written once and the call is over.
 */

/** The columns a layout has to fit into: the stream's own, or the stated
 * fallback where it reports none. This is the only width the grid reads, and
 * it never probes the terminal by any other means. */
export function layoutColumns(stream: OutputStream): number {
  return stream.columns ?? defaultLayoutColumns;
}

/** One variable as the renderer's own props. The whole appearance is applied
 * rather than the attributes a grid happens to use today, so a theme that
 * bolds or hues a variable reaches the screen without this module changing.
 * The hue is already gone where hues are disabled — the theme resolved that
 * before it answered. */
function styling(theme: Theme, variable: ThemeVariable) {
  const { dim, bold, inverse, hue } = theme.appearance(variable);
  return {
    dimColor: dim ?? false,
    bold: bold ?? false,
    inverse: inverse ?? false,
    ...(hue === undefined ? {} : { color: hue }),
  };
}

/** What a blank line is drawn as. A line with nothing in it would take no
 * height, and the blank line above a summary is spacing the layout decided on
 * rather than an accident of what happened to be in the grid. This space is
 * the grid's own rather than anything a consumer supplied, so letting the
 * renderer take it back off the end is exactly what is wanted here. */
const blankLine = " ";

/**
 * A line split into the part the renderer draws and the spaces held back from
 * it, which are appended to the line it produced.
 *
 * The renderer ends every line it draws with `trimEnd`, and it is not
 * consistent about it: an unstyled run of spaces at the end of a line is
 * removed while a styled one survives. A cell whose text genuinely ends in
 * spaces would therefore have them rewritten away — which [Grid: Cell Values]
 * forbids, a supplied string never being rewritten beyond having its control
 * characters removed — and would be rewritten only where it carried no hue,
 * which would make the printed bytes depend on the colour decision that
 * [Grid: Printing] says they may not.
 *
 * So the renderer is handed no line ending in a space and has nothing to take
 * back. Nothing is rewritten: the characters held back before the render are
 * exactly the characters restored after it. The layout has already declined to
 * pad past the last cell with anything in it, so what is held back here is
 * only ever the consumer's own text.
 */
type SplitLine = { readonly head: Line; readonly trailing: string };

function splitTrailing(line: Line): SplitLine {
  const head = [...line];
  let trailing = "";
  while (head.length > 0) {
    const last = head[head.length - 1] as LineSegment;
    const core = last.text.replace(/ +$/u, "");
    trailing = last.text.slice(core.length) + trailing;
    // A segment that was nothing but spaces leaves no text behind, so the one
    // before it is what the drawn line now ends on.
    if (core === "") {
      head.pop();
      continue;
    }
    head[head.length - 1] = { ...last, text: core };
    break;
  }
  return { head, trailing };
}

/** The grid as one column of lines, every run shaded by the role it named. */
export function gridElement(
  react: CoreDependencies["react"],
  ink: CoreDependencies["ink"],
  theme: Theme,
  lines: readonly Line[],
) {
  return react.createElement(
    ink.Box,
    { flexDirection: "column" },
    lines.map((line, index) =>
      react.createElement(
        ink.Text,
        { key: String(index) },
        line.length === 0
          ? blankLine
          : line.map((segment, position) =>
              react.createElement(
                ink.Text,
                { key: String(position), ...styling(theme, segment.variable) },
                segment.text,
              ),
            ),
      ),
    ),
  );
}

/**
 * Prints one grid: laid out, drawn, and written to the request's own stream.
 *
 * A grid with nothing to say — no rows, no empty message, and no summary —
 * writes nothing at all rather than a blank line.
 */
export function printGrid(
  react: CoreDependencies["react"],
  ink: CoreDependencies["ink"],
  theme: Theme,
  request: GridRequest,
): void {
  const lines = gridLines({
    layout: request.layout ?? "table",
    headers: request.headers,
    rows: request.rows,
    empty: request.empty,
    summary: request.summary,
    columns: layoutColumns(request.stream),
  });
  if (lines.length === 0) return;
  const split = lines.map(splitTrailing);
  const element = gridElement(
    react,
    ink,
    theme,
    split.map(({ head }) => head),
  );
  // One column is the floor: a grid of nothing but blank lines still has to be
  // drawn on a canvas with a column in it. The canvas is measured from the
  // whole lines rather than the drawn part of them, so it is the grid's own
  // width whatever a line happens to end on.
  const columns = Math.max(1, canvasWidth(lines));
  const drawn = ink.renderToString(element, { columns }).split("\n");
  const printed = drawn
    .map((line, index) => `${line}${split[index]?.trailing ?? ""}`)
    .join("\n");
  request.stream.write(`${printed}\n`);
}
