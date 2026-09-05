import type { CoreDependencies } from "@fx/tx/plugin";
import type { DialogElement } from "./types.ts";

/** The columns a panel spends on chrome rather than content: one border column
 * and one padding column on each side. */
const frameChromeWidth = 4;

/**
 * The terminal columns a string occupies, which is what a panel is sized in.
 * A string's `length` counts UTF-16 code units, and neither wide characters
 * nor astral ones occupy one column each: eighteen ideographs are eighteen
 * code units and thirty-six columns, so a panel sized by `length` would
 * truncate a label the terminal had room for. The runtime measures this
 * itself, which is why no width library is imported for it.
 */
export function displayWidth(text: string): number {
  return Bun.stringWidth(text);
}

/** The narrowest terminal a dialog lays itself out for. A narrower one still
 * gets this layout, and how the terminal wraps the result is unspecified —
 * laying out into three columns would be worse than overflowing a terminal
 * nobody drives a dialog from. */
const minimumTerminalColumns = 20;

/** The columns a dialog lays itself out into: the terminal's, never below the
 * narrowest width supported. */
function layoutColumns(terminalColumns: number): number {
  return Math.max(terminalColumns, minimumTerminalColumns);
}

/**
 * The width a panel takes: wide enough for its title and for its widest content
 * row, and never wider than the terminal. The title is measured with the space
 * that pads it on each side, and both are measured against the same chrome,
 * because the title sits one column further in than the content but also stops
 * one column short of the closing corner.
 */
export function panelWidth(
  title: string,
  contentColumns: number,
  terminalColumns: number,
  /** The widest run set into an edge with its own padding, plus whatever that
   * edge holds on its right. An edge is measured against the panel's whole
   * width rather than its inner width, because it is drawn between the corners
   * rather than inside them — and it has to be measured at all, or a title
   * would be crushed out of an edge by a count set into the same one. */
  edgeColumns = 0,
): number {
  const forContent =
    Math.max(displayWidth(title) + 2, contentColumns) + frameChromeWidth;
  // One fill column after the opening corner, the run itself, and the two
  // corners.
  const forEdges = edgeColumns + 3;
  return Math.min(
    layoutColumns(terminalColumns),
    Math.max(forContent, forEdges),
  );
}

/** The content columns a panel of this width leaves. One column is the floor:
 * a panel with nothing to put in it still has a row to draw. */
export function innerWidth(width: number): number {
  return Math.max(1, width - frameChromeWidth);
}

/** The content columns the widest panel this terminal can hold would leave,
 * which is what a layout has to fit inside before a panel is sized around it. */
export function availableInnerWidth(terminalColumns: number): number {
  return innerWidth(layoutColumns(terminalColumns));
}

/** What truncation leaves in place of what it removed. */
const ellipsis = "…";

/** Text cut to the columns available, at its end. */
export function truncateEnd(text: string, columns: number): string {
  if (displayWidth(text) <= columns) return text;
  if (columns < 1) return "";
  const budget = columns - displayWidth(ellipsis);
  let kept = "";
  let used = 0;
  for (const character of text) {
    const width = displayWidth(character);
    if (used + width > budget) break;
    used += width;
    kept += character;
  }
  return kept + ellipsis;
}

/** Text padded with spaces to exactly the columns given, measured in columns
 * rather than code units so a label of wide glyphs fills its cell rather than
 * overrunning it. */
export function padToWidth(text: string, columns: number): string {
  const cut = truncateEnd(text, columns);
  return cut.padEnd(cut.length + columns - displayWidth(cut));
}

/** One piece of a rendered row or edge, carrying its own shading so a line can
 * mix chrome with content — a dimmed divider between two lists, a dimmed
 * prompt before what the user typed — and still be cut as a whole. */
export type FrameSegment = {
  readonly key: string;
  readonly text: string;
  readonly dim?: boolean;
  /** The cursor bar, drawn as the terminal's own inversion. */
  readonly inverse?: boolean;
};

/** One content row of a panel. */
export type FrameRow = {
  readonly key: string;
  readonly segments: readonly FrameSegment[];
  /** Text whose tail matters more than its head — entered text — so a row too
   * wide for the panel keeps its end and its caret rather than its start. */
  readonly tail?: boolean;
};

export function segmentsWidth(segments: readonly FrameSegment[]): number {
  let total = 0;
  for (const segment of segments) total += displayWidth(segment.text);
  return total;
}

/**
 * A run of segments cut to the columns available, from whichever end matters
 * less. The cut crosses segment boundaries without losing either side's
 * shading, because a row is one line however many pieces it was described in.
 */
export function truncateSegments(
  segments: readonly FrameSegment[],
  columns: number,
  fromStart = false,
): readonly FrameSegment[] {
  if (segmentsWidth(segments) <= columns) return segments;
  if (columns < 1) return [];
  const characters: FrameSegment[] = [];
  for (const segment of segments) {
    for (const character of segment.text) {
      characters.push({ ...segment, text: character });
    }
  }
  const budget = columns - displayWidth(ellipsis);
  const ordered = fromStart ? [...characters].reverse() : characters;
  const kept: FrameSegment[] = [];
  let used = 0;
  for (const character of ordered) {
    const width = displayWidth(character.text);
    if (used + width > budget) break;
    used += width;
    kept.push(character);
  }
  if (fromStart) kept.reverse();
  const edge = (fromStart ? kept[0] : kept.at(-1)) ?? {
    key: "cut",
    text: "",
  };
  const marker: FrameSegment = { ...edge, text: ellipsis };
  const all = fromStart ? [marker, ...kept] : [...kept, marker];
  // Adjacent characters sharing a shading rejoin, so the renderer is handed
  // the runs it would have been handed without the cut.
  const cut: FrameSegment[] = [];
  for (const character of all) {
    const open = cut.at(-1);
    if (
      open !== undefined &&
      (open.dim ?? false) === (character.dim ?? false) &&
      (open.inverse ?? false) === (character.inverse ?? false)
    ) {
      cut[cut.length - 1] = { ...open, text: open.text + character.text };
      continue;
    }
    cut.push(character);
  }
  return cut;
}

/** The border characters a panel is drawn with: double for a select, single
 * for a text entry. */
const borders = {
  double: {
    left: "╔",
    right: "╗",
    base: "╚",
    close: "╝",
    fill: "═",
    side: "║",
  },
  single: {
    left: "┌",
    right: "┐",
    base: "└",
    close: "┘",
    fill: "─",
    side: "│",
  },
} as const;

/**
 * One horizontal edge of a frame with its pieces set into it.
 *
 * A piece set into an edge costs the panel no row and moves nothing when it
 * appears or goes: the edge is drawn either way, and only what is written over
 * it changes. That is the whole reason the filter and the overflow counts live
 * here rather than in rows of their own — a row that comes and goes takes
 * every option row with it, and a reader who has just started typing or
 * scrolling is exactly the reader who cannot afford that.
 *
 * The left piece starts where the content below it starts, two columns in. The
 * right piece ends one column short of the closing corner. Where they cannot
 * both fit the left one is cut, because the right one is a count and a cut
 * count is a wrong count.
 */
/** The columns an edge leaves for the piece set into its left: everything
 * between the corners, less the one fill column after the opening corner and
 * whatever the right piece holds. */
export function edgeRoom(width: number, held: number): number {
  return Math.max(0, width - 2 - 1 - held);
}

export function frameEdge(
  glyphs: {
    readonly open: string;
    readonly close: string;
    readonly fill: string;
  },
  width: number,
  left: readonly FrameSegment[],
  right: readonly FrameSegment[],
  /** Columns held for the right piece whether it has anything to say or not,
   * filled with the edge's own glyph while it has not. Holding the room is
   * what stops the left piece from growing and shrinking as the right one
   * comes and goes — a title that retruncates on every scroll step is the same
   * restlessness as a row that appears, moved sideways. */
  reserve = 0,
  /** Whether the left piece keeps its end rather than its start when it has to
   * be cut — which is what a line being typed into needs, so the caret is
   * never the part that goes. */
  leftTail = false,
): readonly FrameSegment[] {
  const middle = Math.max(0, width - 2);
  const chrome = (key: string, text: string): FrameSegment => ({
    key,
    text,
    dim: true,
  });
  const held = Math.max(reserve, segmentsWidth(right));
  const cut = truncateSegments(left, edgeRoom(width, held), leftTail);
  const gap = Math.max(0, middle - 1 - segmentsWidth(cut) - held);
  return [
    chrome("open", `${glyphs.open}${glyphs.fill.repeat(Math.min(1, middle))}`),
    ...cut,
    chrome("gap", glyphs.fill.repeat(gap)),
    chrome("held", glyphs.fill.repeat(held - segmentsWidth(right))),
    ...right,
    chrome("close", glyphs.close),
  ];
}

type FrameProps = {
  /** Set into the top edge: the request message, or the trail of the columns
   * on screen, or the message of a field under collection. */
  readonly title: string;
  /** A select is double-line; a standalone input and a field are single-line. */
  readonly double: boolean;
  /** The whole panel, borders included, as `panelWidth` computed it. */
  readonly width: number;
  /** The terminal's width, which the hint line is capped against separately:
   * it sits outside the panel and is free to be wider than it. */
  readonly columns: number;
  /** The key hint line drawn under the panel. */
  readonly hint: string | undefined;
  /** Set into the top edge on the right, before the corner. */
  readonly topRight?: readonly FrameSegment[] | undefined;
  /** Set into the bottom edge from the left, where the content starts. */
  readonly bottomLeft?: readonly FrameSegment[] | undefined;
  /** Set into the bottom edge on the right, before the corner. */
  readonly bottomRight?: readonly FrameSegment[] | undefined;
  /** Columns held on the right of both edges whether their pieces have
   * anything to say or not, so the title keeps the width it had. */
  readonly edgeReserve?: number | undefined;
  /** Whether the piece set into the bottom edge keeps its end rather than its
   * start when it has to be cut. */
  readonly bottomLeftTail?: boolean | undefined;
  readonly rows: readonly FrameRow[];
};

/**
 * The one framed panel every dialog is drawn in: a bordered box carrying its
 * message as a title set into the top edge, whatever the caller sets into its
 * edges beside it, and a key hint line beneath it.
 *
 * The edges are drawn here rather than by the renderer's own border styles,
 * because a border with things set into it is not a border the renderer can
 * draw. Everything the frame itself draws is dimmed, which together with the
 * inverted cursor bar the caller passes in is the whole palette — no hue is
 * ever named.
 */
export function createFrame(
  react: CoreDependencies["react"],
  ink: CoreDependencies["ink"],
) {
  return function Frame({
    title,
    double,
    width,
    columns,
    hint,
    topRight,
    bottomLeft,
    bottomRight,
    edgeReserve,
    bottomLeftTail,
    rows,
  }: FrameProps) {
    const glyphs = double ? borders.double : borders.single;
    const inner = innerWidth(width);
    const line = (
      key: string,
      segments: readonly FrameSegment[],
      tail = false,
    ) =>
      react.createElement(
        ink.Text,
        { key, wrap: tail ? "truncate-start" : "truncate-end" },
        segments.map((segment) =>
          react.createElement(
            ink.Text,
            {
              key: segment.key,
              dimColor: segment.dim ?? false,
              inverse: segment.inverse ?? false,
            },
            segment.text,
          ),
        ),
      );
    const side = (key: string): FrameSegment => ({
      key,
      text: glyphs.side,
      dim: true,
    });
    const drawn: DialogElement[] = [
      line(
        "top",
        frameEdge(
          { open: glyphs.left, close: glyphs.right, fill: glyphs.fill },
          width,
          // The padding spaces are their own segment rather than a template
          // literal, so a title that is not a string reaches the renderer as
          // itself and fails the render instead of being coerced into one.
          // Cut to the room its own spaces leave rather than with them, so a
          // title too long for the edge still ends a column short of the fill
          // instead of running straight into it.
          [
            { key: "title-open", text: " ", dim: true },
            {
              key: "title",
              text: truncateEnd(
                title,
                edgeRoom(
                  width,
                  Math.max(edgeReserve ?? 0, segmentsWidth(topRight ?? [])),
                ) - 2,
              ),
              dim: true,
            },
            { key: "title-close", text: " ", dim: true },
          ],
          topRight ?? [],
          edgeReserve ?? 0,
        ),
      ),
    ];
    for (const row of rows) {
      // Cut and padded here rather than by the renderer's wrapping, because a
      // row is a run of separately shaded pieces and the padding has to land
      // inside the borders either side of it.
      const fitted = truncateSegments(row.segments, inner, row.tail ?? false);
      const padding = inner - segmentsWidth(fitted);
      drawn.push(
        line(
          row.key,
          [
            side("open"),
            { key: "lead", text: " " },
            ...fitted,
            { key: "pad", text: " ".repeat(Math.max(0, padding)) },
            { key: "trail", text: " " },
            side("close"),
          ],
          row.tail ?? false,
        ),
      );
    }
    drawn.push(
      line(
        "bottom",
        frameEdge(
          { open: glyphs.base, close: glyphs.close, fill: glyphs.fill },
          width,
          bottomLeft ?? [],
          bottomRight ?? [],
          edgeReserve ?? 0,
          bottomLeftTail ?? false,
        ),
      ),
    );
    if (hint !== undefined) {
      // The hint line is capped like the panel is: a hint wide enough to wrap
      // would add a row the viewport's arithmetic never counted.
      const cap = Math.max(1, layoutColumns(columns) - 1);
      drawn.push(
        react.createElement(
          ink.Box,
          { key: "hint", marginLeft: 1, width: cap },
          react.createElement(
            ink.Text,
            { dimColor: true, wrap: "truncate-end" },
            hint,
          ),
        ),
      );
    }
    return react.createElement(
      ink.Box,
      { flexDirection: "column", width },
      drawn,
    );
  };
}

export type FrameComponent = ReturnType<typeof createFrame>;
