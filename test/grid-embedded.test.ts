import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type {
  Grid,
  GridProps,
  GridRequest,
  GridSelection,
  GridSelectRequest,
  OutputStream,
  SelectGridProps,
} from "@fx/tx/grid";
import type { ReactNode } from "react";
import { animationInterval } from "../plugins/dialogs/animation.ts";
import dialogsPlugin from "../plugins/dialogs/index.ts";
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

/** A grid printed to a stream of the given width, as its comparable lines. */
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

/**
 * The selecting half, driven the same way: a host session on a terminal of its
 * own — a keyboard the test types into and a screen it reads — rendering
 * `grid.SelectGrid` read from the registry. The command's own streams stay
 * captured beside it, so a component that wrote anywhere but through its
 * host's session, or that reached for the command's interactive streams,
 * would show up there.
 */

const ESCAPE = String.fromCharCode(27);
const CARRIAGE_RETURN = "\r";
const DOWN = `${ESCAPE}[B`;

/** The host's keyboard: a terminal input the renderer can put into raw mode
 * and a test can type into. */
class Keyboard extends PassThrough {
  readonly isTTY = true;
  isRaw = false;

  setRawMode(enabled: boolean): this {
    this.isRaw = enabled;
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** Generous, as the function form's own tests are: nothing waited behind here
 * is an animation, and a loaded runner can be slow to draw a first frame. */
const BUDGET = animationInterval * 20;

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + BUDGET;
  for (;;) {
    if (predicate()) return;
    if (performance.now() >= deadline) {
      throw new Error("timed out waiting for the host session");
    }
    await pause(1);
  }
}

/** The grid capability read from a `tx` composing the dialogs provider a
 * selecting grid is drawn through, unless a test composes others. */
async function readSelectingGrid(
  plugins: readonly PluginDefinition[] = [dialogsPlugin],
): Promise<{ readonly grid: Grid; readonly tx: CapturedContext }> {
  const { reads, tx } = await obtainGrid({ plugins });
  return { grid: reads[0] as Grid, tx };
}

/** The host's cast for the selecting component, as for `Grid`. */
function selectingComponent<T, A>(
  grid: Grid,
): (props: SelectGridProps<T, A>) => ReactNode {
  return grid.SelectGrid as (props: SelectGridProps<T, A>) => ReactNode;
}

/** Every call the component made back to its host, in order. */
type Answer<T, A> =
  | { readonly type: "submit"; readonly selection: GridSelection<T, A> }
  | { readonly type: "cancel" };

function answers<T, A>() {
  const calls: Answer<T, A>[] = [];
  return {
    calls,
    onSubmit: (selection: GridSelection<T, A>) =>
      calls.push({ type: "submit", selection }),
    onCancel: () => calls.push({ type: "cancel" }),
  };
}

/** The line a selecting host draws above the grid, which also opens every
 * frame it draws, so the latest frame is what follows its last occurrence. */
const selectingTitle = "selecting host";

/**
 * A host session drawing `View` beneath its title, on a keyboard and screen
 * of its own. Debug mode writes every frame whole and in turn, so the latest
 * frame is whatever follows the title's last occurrence.
 */
function hostSession(view: () => ReactNode) {
  const { react, ink } = coreDependencies;
  const View = () =>
    react.createElement(
      ink.Box,
      { flexDirection: "column" },
      react.createElement(ink.Text, null, selectingTitle),
      view(),
    );
  const keyboard = new Keyboard();
  const screen = new Screen();
  const instance = ink.render(react.createElement(View), {
    stdout: screen,
    stdin: keyboard,
    stderr: screen,
    debug: true,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  let exited = false;
  const exit = instance.waitUntilExit().then(
    () => {
      exited = true;
    },
    (reason: unknown) => {
      exited = true;
      throw reason;
    },
  );
  return {
    screen,
    exit,
    exited: () => exited,
    /** The latest frame's lines beneath the host's title, every sequence and
     * every line's trailing whitespace removed. */
    rows(): readonly string[] {
      const text = screen.text();
      const found = text.lastIndexOf(selectingTitle);
      if (found < 0) return [];
      return comparable(text.slice(found + selectingTitle.length)).slice(1);
    },
    /** Types one chunk and lets the session answer it. */
    async press(chunk: string): Promise<void> {
      keyboard.write(chunk);
      await pause(5);
    },
    async close(): Promise<void> {
      instance.unmount();
      await exit;
    },
  };
}

/** A host widget answering keys of its own, as whichever of a host's panels
 * has focus does. It keeps the session reading its keyboard while the grid is
 * inactive, so a key typed then is answered then rather than held for later. */
function hostKeys(seen: string[]): ReactNode {
  const { react, ink } = coreDependencies;
  const Keys = () => {
    ink.useInput((input) => {
      seen.push(input);
    });
    return null;
  };
  return react.createElement(Keys);
}

const services: GridSelectRequest<string, string> = {
  message: "Services",
  headers: ["NAME", "STATE"],
  rows: [
    {
      cells: ["alpha", "up"],
      value: "alpha",
      actions: [
        { label: "connect", value: "connect" },
        { label: "open logs", value: "logs" },
      ],
    },
    {
      cells: ["bravo", "down"],
      value: "bravo",
      actions: [
        { label: "connect", value: "connect" },
        { label: "open logs", value: "logs" },
      ],
    },
  ],
};

function shows(
  session: ReturnType<typeof hostSession>,
  text: string,
): () => boolean {
  return () => session.rows().some((row) => row.includes(text));
}

describe("the embeddable selecting grid", () => {
  test("is the same component on every read of the capability", async () => {
    const { reads } = await obtainGrid({ plugins: [dialogsPlugin] });
    const [first, second] = reads as [Grid, Grid];

    expect(typeof first.SelectGrid).toBe("function");
    expect(second.SelectGrid).toBe(first.SelectGrid);
  });

  test("calls the host back once with the row and the action it acted on", async () => {
    const { grid, tx } = await readSelectingGrid();
    const SelectGrid = selectingComponent<string, string>(grid);
    const calls = answers<string, string>();
    const session = hostSession(() =>
      coreDependencies.react.createElement(SelectGrid, {
        request: services,
        width: 60,
        height: 12,
        isActive: true,
        ...calls,
      }),
    );

    await until(shows(session, "bravo"));
    expect(session.rows().some((row) => /NAME\s+STATE/u.test(row))).toBe(true);
    await session.press(DOWN);
    await session.press(CARRIAGE_RETURN);
    await until(shows(session, "open logs"));
    await session.press(CARRIAGE_RETURN);
    await until(() => calls.calls.length > 0);
    // Nothing more arrives: the component is one-shot.
    await pause(animationInterval);

    expect(calls.calls).toEqual([
      { type: "submit", selection: { value: "bravo", action: "connect" } },
    ]);
    // The host's session is the host's: the grid settling ends nothing.
    expect(session.exited()).toBe(false);
    await session.close();
    expect(tx.stdoutText()).toBe("");
    expect(tx.stderrText()).toBe("");
  });

  test("calls the host back with the row alone where it offers no actions", async () => {
    const { grid } = await readSelectingGrid();
    const SelectGrid = selectingComponent<string, string>(grid);
    const calls = answers<string, string>();
    const session = hostSession(() =>
      coreDependencies.react.createElement(SelectGrid, {
        request: {
          message: "Services",
          rows: [
            {
              cells: ["alpha"],
              value: "alpha",
              actions: [{ label: "connect", value: "connect" }],
            },
            // Computed actions, of which this row has none.
            { cells: ["bravo"], value: "bravo", actions: [] },
          ],
        },
        width: 60,
        height: 12,
        isActive: true,
        ...calls,
      }),
    );

    await until(shows(session, "bravo"));
    await session.press(DOWN);
    await session.press(CARRIAGE_RETURN);
    await until(() => calls.calls.length > 0);
    await session.close();

    expect(calls.calls).toEqual([
      { type: "submit", selection: { value: "bravo" } },
    ]);
    const [call] = calls.calls as [Answer<string, string>];
    expect(
      "action" in
        (call as { selection: GridSelection<string, string> }).selection,
    ).toBe(false);
  });

  test("calls the host back once on Escape and writes to no stream", async () => {
    const { grid, tx } = await readSelectingGrid();
    const SelectGrid = selectingComponent<string, string>(grid);
    const calls = answers<string, string>();
    const session = hostSession(() =>
      coreDependencies.react.createElement(SelectGrid, {
        request: services,
        width: 60,
        height: 12,
        isActive: true,
        ...calls,
      }),
    );

    await until(shows(session, "bravo"));
    await session.press(ESCAPE);
    await until(() => calls.calls.length > 0);
    await session.press(ESCAPE);
    await pause(animationInterval);

    expect(calls.calls).toEqual([{ type: "cancel" }]);
    expect(session.exited()).toBe(false);
    await session.close();
    expect(tx.stdoutText()).toBe("");
    expect(tx.stderrText()).toBe("");
  });

  test("takes no keys while inactive, and answers the first once active", async () => {
    const { grid } = await readSelectingGrid();
    const { react } = coreDependencies;
    const SelectGrid = selectingComponent<string, string>(grid);
    const calls = answers<string, string>();
    const seen: string[] = [];
    let activate: (() => void) | undefined;
    let activeCommitted = false;
    const session = hostSession(() => {
      const [isActive, setActive] = react.useState(false);
      activate = () => setActive(true);
      // The host is the root, and a parent's effects run after its
      // children's: once this reports the active render committed, the
      // grid's input subscription already exists.
      react.useEffect(() => {
        if (isActive) activeCommitted = true;
      }, [isActive]);
      return react.createElement(
        react.Fragment,
        null,
        hostKeys(seen),
        react.createElement(SelectGrid, {
          request: {
            message: "Services",
            rows: [
              { cells: ["alpha"], value: "alpha" },
              { cells: ["bravo"], value: "bravo" },
            ],
          },
          width: 60,
          height: 12,
          isActive,
          ...calls,
        }),
      );
    });

    await until(shows(session, "bravo"));
    await session.press(DOWN);
    await session.press(CARRIAGE_RETURN);
    await until(() => seen.length >= 2);
    await pause(animationInterval / 5);
    expect(calls.calls).toEqual([]);

    (activate as () => void)();
    // A fixed pause is a race: on a loaded runner the activated render may
    // not have committed, and the Enter would be dropped.
    await until(() => activeCommitted);
    await session.press(CARRIAGE_RETURN);
    await until(() => calls.calls.length > 0);
    await session.close();

    // The cursor never moved while the grid was inactive.
    expect(calls.calls).toEqual([
      { type: "submit", selection: { value: "alpha" } },
    ]);
  });

  test("draws within the host's height and width", async () => {
    const { grid } = await readSelectingGrid();
    const SelectGrid = selectingComponent<number, never>(grid);
    const session = hostSession(() =>
      coreDependencies.react.createElement(SelectGrid, {
        request: {
          message: "Rows",
          rows: Array.from({ length: 30 }, (_, index) => ({
            cells: [`row ${String(index + 1).padStart(2, "0")}`],
            value: index + 1,
          })),
        },
        width: 50,
        height: 9,
        isActive: true,
        ...answers<number, never>(),
      }),
    );

    await until(shows(session, "row 01"));
    const rows = session.rows();
    await session.close();

    // Nine rows in all: two edges, six rows of the grid, and the hint line.
    expect(rows).toHaveLength(9);
    expect(rows.filter((row) => row.includes("row "))).toHaveLength(6);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(50);
  });

  test("fails the host's render naming the count when no dialogs provider is composed", async () => {
    const { grid } = await readSelectingGrid([]);
    const SelectGrid = selectingComponent<string, string>(grid);
    const calls = answers<string, string>();
    const session = hostSession(() =>
      coreDependencies.react.createElement(SelectGrid, {
        request: services,
        width: 60,
        height: 12,
        isActive: true,
        ...calls,
      }),
    );

    let failure: unknown;
    try {
      await session.exit;
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Expected exactly one dialogs capability, but found 0",
    );
    expect(session.screen.text()).not.toContain("alpha");
    expect(calls.calls).toEqual([]);
  });

  test("fails the host's render when the dialogs provider is repeated", async () => {
    const another: PluginDefinition = {
      identity: { name: "more-dialogs" },
      load:
        () =>
        ({ register }) => {
          register("@fx/tx/dialogs", {});
        },
    };
    const { grid } = await readSelectingGrid([dialogsPlugin, another]);
    const SelectGrid = selectingComponent<string, string>(grid);
    const session = hostSession(() =>
      coreDependencies.react.createElement(SelectGrid, {
        request: services,
        width: 60,
        height: 12,
        isActive: true,
        ...answers<string, string>(),
      }),
    );

    let failure: unknown;
    try {
      await session.exit;
    } catch (error) {
      failure = error;
    }

    expect((failure as Error).message).toBe(
      "Expected exactly one dialogs capability, but found 2",
    );
  });
});
