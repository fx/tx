import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { Grid, GridProps, GridRequest, OutputStream } from "@fx/tx/grid";
import type { ReactNode } from "react";
import gridPlugin from "../plugins/grid/index.ts";
import themePlugin from "../plugins/theme/index.ts";
import { main } from "../src/cli.ts";
import type { PluginDefinition } from "../src/plugin.ts";
import { coreDependencies } from "../src/plugins.ts";
import { type CapturedContext, captureContext } from "./helpers.ts";

/**
 * The grid's embeddable components, driven the way a host plugin drives them:
 * read from the registry while a command runs, typed by the published
 * contract, and rendered through the injected `ink.render` inside a session
 * the test owns on captured streams. Nothing here reaches into the provider
 * for its component; a host never could.
 */

/** A stream that keeps what was written to it and answers only what the grid
 * may read of one. It stands for the stream on a request a host would print,
 * so an embedded grid that wrote to it fails the suite. */
type Recorder = OutputStream & { text(): string };

function recorder(
  properties: { readonly columns?: number; readonly isTTY?: boolean } = {},
): Recorder {
  let written = "";
  return {
    ...properties,
    write(chunk: string) {
      written += chunk;
      return true;
    },
    text: () => written,
  };
}

/** The host's terminal: what its session writes, captured. Wider than any
 * width a test hands the grid, so every line is laid out against the grid's
 * `width` and never against this. */
class Screen extends PassThrough {
  readonly columns = 120;
  readonly rows = 40;
  readonly isTTY = true;
  #written = "";

  constructor() {
    super();
    this.on("data", (chunk) => {
      this.#written += chunk.toString();
    });
  }

  text(): string {
    return this.#written;
  }
}

/** The character every terminal sequence starts with, built rather than
 * written so the source carries no control character. */
const escapeCharacter = String.fromCharCode(0x1b);
const anySequence = new RegExp(`${escapeCharacter}\\[[0-9;?]*[A-Za-z]`, "gu");

/** Lines with every sequence and every line's trailing whitespace removed —
 * what "hues and trailing whitespace removed" means when an embedded grid is
 * compared with a printed one, since what a session writes at the end of a
 * line is its own. */
function comparable(text: string): readonly string[] {
  const lines = text
    .replace(anySequence, "")
    .split("\n")
    .map((line) => line.trimEnd());
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

/** A theme override contributing a hue, so whether colour is on for a stream
 * is a difference the element shows. */
function hueing(hue: string): PluginDefinition {
  return {
    identity: { name: "hues" },
    load:
      () =>
      ({ register }) => {
        register("@fx/tx/theme-override", { content: { hue } });
      },
  };
}

/**
 * The grid capability as a host command reads it, from a `tx` whose injected
 * standard error is captured and reports the given TTY-ness — the stream the
 * embedded grid resolves its theme for.
 */
async function obtainGrid(
  options: {
    readonly plugins?: readonly PluginDefinition[];
    readonly stderrIsTTY?: boolean;
  } = {},
): Promise<{ readonly reads: readonly Grid[]; readonly tx: CapturedContext }> {
  const reads: Grid[] = [];
  const host: PluginDefinition = {
    identity: { name: "host" },
    load:
      () =>
      ({ command, registrations }) => {
        command((namespace) =>
          namespace.action(() => {
            for (let read = 0; read < 2; read += 1) {
              const [grid] = registrations<Grid>("@fx/tx/grid");
              if (grid) reads.push(grid);
            }
          }),
        );
      },
  };
  const captured = captureContext();
  const tx: CapturedContext = {
    ...captured,
    stderr: Object.assign(captured.stderr, {
      isTTY: options.stderrIsTTY ?? false,
    }),
  };
  expect(
    await main(
      ["host"],
      [themePlugin, ...(options.plugins ?? []), gridPlugin, host],
      tx,
    ),
  ).toBe(0);
  expect(reads).toHaveLength(2);
  return { reads, tx };
}

async function readGrid(
  options: Parameters<typeof obtainGrid>[0] = {},
): Promise<Grid> {
  const { reads } = await obtainGrid(options);
  return reads[0] as Grid;
}

/** The cast a host makes where it hands the component to `createElement`: the
 * published contract types it as returning `unknown`, so it names no React
 * type, and the host — which has React's types — supplies the element type. */
function component(grid: Grid): (props: GridProps) => ReactNode {
  return grid.Grid as (props: GridProps) => ReactNode;
}

/** The text a host draws above the grid, so a grid taking no rows is visible
 * as the host's own line standing alone. */
const hostTitle = "host";

/** A host session: one title line and the grid beneath it in a column as wide
 * as the width the host hands the grid. */
type Session = {
  /** The frame the session drew for its latest render. */
  readonly frame: string;
  rerender(props: GridProps): Promise<string>;
  close(): Promise<void>;
};

/**
 * Mounts a host rendering `grid.Grid` through the injected `ink.render`.
 *
 * Debug mode writes every frame whole and in turn rather than repainting one,
 * so a render's frame is exactly what the screen gained since the last one.
 */
async function mount(grid: Grid, props: GridProps): Promise<Session> {
  const { react, ink } = coreDependencies;
  const Embedded = component(grid);
  const view = (next: GridProps) =>
    react.createElement(
      ink.Box,
      { flexDirection: "column", width: next.width },
      react.createElement(ink.Text, null, hostTitle),
      react.createElement(Embedded, next),
    );
  const screen = new Screen();
  const instance = ink.render(view(props), {
    stdout: screen,
    stdin: new PassThrough(),
    stderr: screen,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  let seen = 0;
  const nextFrame = async (): Promise<string> => {
    await instance.waitUntilRenderFlush();
    const written = screen.text();
    const frame = written.slice(seen);
    seen = written.length;
    return frame;
  };
  const session = {
    frame: await nextFrame(),
    async rerender(next: GridProps): Promise<string> {
      instance.rerender(view(next));
      session.frame = await nextFrame();
      return session.frame;
    },
    async close(): Promise<void> {
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
  return session;
}

/** The grid's own lines in a host frame: everything beneath the host's title,
 * compared as `comparable` reads it. */
function gridRows(frame: string): readonly string[] {
  const [title, ...rows] = comparable(frame);
  expect(title).toBe(hostTitle);
  return rows;
}

/** A rendered element as the tree a host's session receives. */
type Element = {
  readonly props: { readonly children?: unknown; readonly color?: string };
};

/** Every character an element carries, in order. */
function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf((node as Element).props.children);
}

/**
 * The element `Grid` hands its host, read rather than drawn: the host's
 * session decides what reaches a terminal, so a cell's own trailing spaces
 * are asserted on what the session was given to draw.
 *
 * A probe component calls `Grid` in its own render to see the element — the
 * one place it can be seen, since a component's output is otherwise the
 * renderer's — and draws it, so the probe's session is a real host session.
 */
async function handedElement(
  grid: Grid,
  props: GridProps,
): Promise<{ readonly element: unknown; readonly frame: string }> {
  const { react, ink } = coreDependencies;
  const Embedded = component(grid);
  let element: unknown;
  function Probe(): ReactNode {
    const drawn = Embedded(props);
    element = drawn;
    return drawn;
  }
  const screen = new Screen();
  const instance = ink.render(react.createElement(Probe), {
    stdout: screen,
    stdin: new PassThrough(),
    stderr: screen,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await instance.waitUntilRenderFlush();
  const frame = screen.text();
  instance.unmount();
  await instance.waitUntilExit();
  return { element, frame };
}

/** The element's lines: one per child of the column it is. */
function elementLines(element: unknown): readonly string[] {
  const children = (element as Element).props.children as readonly unknown[];
  return children.map(textOf);
}

/** Every styled run of the element, with the props it is drawn with. */
function elementRuns(element: unknown): readonly Element["props"][] {
  const children = (element as Element).props.children as readonly Element[];
  return children.flatMap((line) =>
    (line.props.children as readonly Element[]).map((run) => run.props),
  );
}

/** A table printed to a stream of the given width, as its unstyled lines. */
async function printed(
  request: Omit<GridRequest, "stream">,
  columns: number,
): Promise<readonly string[]> {
  const grid = await readGrid();
  const stream = recorder({ columns });
  grid.print({ ...request, stream });
  return comparable(stream.text());
}

const sixItems: GridRequest["rows"] = [
  ["alpha"],
  ["bravo"],
  ["delta"],
  ["gamma"],
  ["kappa"],
  ["omega"],
];

describe("the embeddable grid", () => {
  test("is the same component on every read of the capability", async () => {
    const { reads } = await obtainGrid();
    const [first, second] = reads as [Grid, Grid];

    expect(typeof first.Grid).toBe("function");
    expect(second.Grid).toBe(first.Grid);
  });

  test("hands its host the flow print writes at the same width", async () => {
    const request: Omit<GridRequest, "stream"> = {
      layout: "flow",
      rows: [
        ["alpha", "bravo"],
        ["charlie"],
        [{ text: "delta", variable: "danger" }],
        ["echo"],
        ["foxtrot"],
        ["golf"],
        ["hotel"],
        ["india"],
        ["juliett"],
        ["kilo"],
        ["lima"],
        ["mike"],
        ["november"],
      ],
      summary: "13 items",
    };
    const grid = await readGrid();

    const session = await mount(grid, { request, width: 60 });
    await session.close();

    const expected = await printed(request, 60);
    // More than one column and more than one line, so the comparison is of a
    // flow the width actually shaped rather than of a single run of items.
    expect(expected.length).toBeGreaterThan(3);
    expect(expected[0]?.split(/ {2,}/u).length).toBeGreaterThan(2);
    expect(gridRows(session.frame)).toEqual(expected);
  });

  test("hands its host the table print writes", async () => {
    const request: Omit<GridRequest, "stream"> = {
      headers: ["NAME", "COUNT"],
      rows: [
        ["alpha", { text: "1", align: "end" }],
        ["charlie-delta", { text: "220", align: "end" }],
      ],
      summary: "2 rows",
    };
    const grid = await readGrid();

    const session = await mount(grid, { request, width: 40 });
    await session.close();

    expect(gridRows(session.frame)).toEqual(await printed(request, 40));
  });

  test("re-flows its items when the host renders it narrower or wider", async () => {
    const request: Omit<GridRequest, "stream"> = {
      layout: "flow",
      rows: sixItems,
    };
    const grid = await readGrid();

    const session = await mount(grid, { request, width: 18 });
    const twoColumns = gridRows(session.frame);
    const threeColumns = gridRows(
      await session.rerender({ request, width: 24 }),
    );
    await session.close();

    expect(twoColumns).toEqual([
      "alpha  gamma",
      "bravo  kappa",
      "delta  omega",
    ]);
    expect(threeColumns).toEqual([
      "alpha  delta  kappa",
      "bravo  gamma  omega",
    ]);
  });

  test("draws the request of the render it is in", async () => {
    const grid = await readGrid();

    const session = await mount(grid, {
      request: { rows: [["before"]] },
      width: 40,
    });
    const first = gridRows(session.frame);
    const second = gridRows(
      await session.rerender({ request: { rows: [["after"]] }, width: 40 }),
    );
    await session.close();

    expect(first).toEqual(["before"]);
    expect(second).toEqual(["after"]);
  });

  test("writes nothing to the stream a table request carries", async () => {
    const stream = recorder({ columns: 80, isTTY: true });
    const request: GridRequest = {
      stream,
      headers: ["NAME", "STATE"],
      rows: [
        ["alpha", "up"],
        ["bravo", "down"],
      ],
    };
    const { reads, tx } = await obtainGrid();
    const grid = reads[0] as Grid;

    // The request a host would print, handed over unchanged.
    const session = await mount(grid, { request, width: 40 });
    await session.close();

    expect(stream.text()).toBe("");
    expect(tx.stdoutText()).toBe("");
    expect(tx.stderrText()).toBe("");
    expect(gridRows(session.frame)).toEqual([
      "NAME   STATE",
      "alpha  up",
      "bravo  down",
    ]);
  });

  test("hands its host a cell's own trailing spaces", async () => {
    const request: Omit<GridRequest, "stream"> = {
      rows: [
        ["alpha", "two  "],
        ["bravo", "x"],
      ],
    };
    const grid = await readGrid();

    const { element } = await handedElement(grid, { request, width: 40 });
    const lines = elementLines(element);

    expect(lines[0]).toBe("alpha  two  ");
    expect(lines[0]?.endsWith("two  ")).toBe(true);
    expect(lines[0]?.endsWith("two   ")).toBe(false);
    // The same characters print writes, trailing spaces and all.
    const stream = recorder({ columns: 40 });
    grid.print({ ...request, stream });
    expect(lines).toEqual(stream.text().slice(0, -1).split("\n"));
  });

  test("draws nothing and takes no rows when there is nothing to draw", async () => {
    const grid = await readGrid();

    const session = await mount(grid, { request: { rows: [] }, width: 40 });
    await session.close();
    const { element } = await handedElement(grid, {
      request: { rows: [] },
      width: 40,
    });

    expect(gridRows(session.frame)).toEqual([]);
    expect(element).toBeNull();
  });

  test("draws an empty grid's message", async () => {
    const request: Omit<GridRequest, "stream"> = {
      rows: [],
      empty: "no services",
    };
    const grid = await readGrid();

    const session = await mount(grid, { request, width: 40 });
    await session.close();

    expect(gridRows(session.frame)).toEqual(await printed(request, 40));
    expect(gridRows(session.frame)).toEqual(["no services"]);
  });

  test("removes the control characters a cell carries", async () => {
    const request: Omit<GridRequest, "stream"> = {
      rows: [[`ev${escapeCharacter}[2Jil\r\nline`, "next"]],
    };
    const grid = await readGrid();

    const { element, frame } = await handedElement(grid, {
      request,
      width: 40,
    });

    expect(elementLines(element)).toEqual(["ev[2Jilline  next"]);
    expect(frame).not.toContain(`${escapeCharacter}[2J`);
    expect(comparable(frame)).toEqual(["ev[2Jilline  next"]);
  });

  test("resolves its theme for the standard error tx injected", async () => {
    const request: Omit<GridRequest, "stream"> & { stream: OutputStream } = {
      // A terminal on the request, which the embedded grid does not read:
      // were colour decided by it, the hue would be on in both cases below.
      stream: recorder({ isTTY: true }),
      rows: [["alpha"]],
    };
    const hue = [hueing("red")];

    const terminal = await handedElement(
      await readGrid({ plugins: hue, stderrIsTTY: true }),
      { request, width: 40 },
    );
    const redirected = await handedElement(
      await readGrid({ plugins: hue, stderrIsTTY: false }),
      { request, width: 40 },
    );

    expect(elementRuns(terminal.element).map((run) => run.color)).toEqual([
      "red",
    ]);
    expect(elementRuns(redirected.element).map((run) => run.color)).toEqual([
      undefined,
    ]);
  });
});
