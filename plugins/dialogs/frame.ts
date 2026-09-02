import type { CoreDependencies } from "@fx/tx/plugin";
import type { DialogElement } from "./types.ts";

/** The columns a panel spends on chrome rather than content: one border column
 * and one padding column on each side. */
const frameChromeWidth = 4;

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
): number {
  const desired = Math.max(title.length + 2, contentColumns) + frameChromeWidth;
  return Math.min(layoutColumns(terminalColumns), desired);
}

/** The content columns a panel of this width leaves. One column is the floor:
 * a panel with nothing to put in it still has a row to draw. */
export function innerWidth(width: number): number {
  return Math.max(1, width - frameChromeWidth);
}

type FrameProps = {
  /** Set into the panel's top edge: the request message, or the message of a
   * field under collection. */
  readonly title: string;
  /** A select is double-line; a standalone input and a field are single-line. */
  readonly double: boolean;
  /** The whole panel, borders included, as `panelWidth` computed it. */
  readonly width: number;
  /** The terminal's width, which the hint line is capped against separately:
   * it sits outside the panel and is free to be wider than it. Passed in
   * rather than read here, because the caller has already read it to size the
   * panel and a second subscription would only duplicate the listener. */
  readonly columns: number;
  /** The key hint line drawn under the panel, or nothing when another panel
   * follows this one and carries the hints that actually apply. */
  readonly hint: string | undefined;
  readonly children?: DialogElement | readonly DialogElement[];
};

/**
 * The one framed panel every dialog is drawn in: a bordered box carrying its
 * message as a title set into the top edge, and a key hint line beneath it.
 *
 * The title is one absolutely positioned text lifted a row out of the box's
 * content, so the border is the renderer's own rather than characters drawn by
 * hand, and the title lands over it: `╔═ Title ═══╗`. Everything the frame
 * itself draws is dimmed, which together with the inverted cursor bar the
 * caller passes in is the whole palette — no hue is ever named.
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
    children,
  }: FrameProps) {
    /** The title starts two columns in, over the first border segment, and may
     * run up to the column before the closing corner. */
    const titleWidth = Math.max(1, width - 3);
    const panel = react.createElement(
      ink.Box,
      {
        key: "panel",
        flexDirection: "column",
        borderStyle: double ? "double" : "single",
        borderDimColor: true,
        width,
        paddingX: 1,
      },
      react.createElement(
        ink.Box,
        {
          key: "title",
          position: "absolute",
          marginTop: -1,
          width: titleWidth,
        },
        // The padding spaces are separate children rather than a template
        // literal, so a title that is not a string reaches the renderer as
        // itself and fails the render instead of being coerced into one.
        react.createElement(
          ink.Text,
          { dimColor: true, wrap: "truncate-end" },
          " ",
          title,
          " ",
        ),
      ),
      children,
    );
    // The hint line is capped like the panel is: a hint wide enough to wrap
    // would add a row the viewport's arithmetic never counted.
    const hints =
      hint === undefined
        ? undefined
        : react.createElement(
            ink.Box,
            {
              key: "hint",
              marginLeft: 1,
              width: Math.max(1, layoutColumns(columns) - 1),
            },
            react.createElement(
              ink.Text,
              { dimColor: true, wrap: "truncate-end" },
              hint,
            ),
          );
    return react.createElement(
      ink.Box,
      { flexDirection: "column" },
      panel,
      hints,
    );
  };
}

export type FrameComponent = ReturnType<typeof createFrame>;
