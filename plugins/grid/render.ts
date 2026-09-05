import type { CoreDependencies } from "@fx/tx/plugin";
import {
  canvasWidth,
  defaultLayoutColumns,
  gridLines,
  type Line,
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
 * rather than an accident of what happened to be in the grid. The renderer
 * trims the trailing space away again, so the printed line is empty. */
const blankLine = " ";

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
  const element = gridElement(react, ink, theme, lines);
  // One column is the floor: a grid of nothing but blank lines still has to be
  // drawn on a canvas with a column in it.
  const columns = Math.max(1, canvasWidth(lines));
  request.stream.write(`${ink.renderToString(element, { columns })}\n`);
}
