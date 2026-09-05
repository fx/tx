import { describe, expect, test } from "bun:test";
import { defaultLayoutColumns } from "../plugins/grid/geometry.ts";
import gridPlugin from "../plugins/grid/index.ts";
import type { GridRequest, OutputStream } from "../plugins/grid/types.ts";
import themePlugin from "../plugins/theme/index.ts";
import { main } from "../src/cli.ts";
import type { PluginDefinition } from "../src/plugin.ts";
import { captureContext } from "./helpers.ts";

/**
 * The grid capability as a consumer declares it for itself: a local structural
 * type, because the capability is internal and nothing about grids is imported
 * across a plugin boundary or exported publicly.
 */
type Grid = {
  print(request: GridRequest): void;
};

/** A stream that keeps what was written to it and answers only what the grid
 * is allowed to read: its width and whether it is a terminal. Nothing here is
 * a process stream, so an escape from the request's own stream fails the suite
 * rather than reaching a real terminal. */
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

/** The character every terminal sequence starts with, and the two patterns
 * over it. They are built rather than written as literals: a control character
 * in a regular expression is unreadable, and the linter rejects one. */
const escapeCharacter = String.fromCharCode(0x1b);
const anySequence = new RegExp(escapeCharacter, "gu");
const stylingSequence = new RegExp(`${escapeCharacter}\\[[0-9;]*m`, "gu");

/** Whitespace `trimEnd` removes and a pattern over ASCII spaces would not, so
 * a cell ending in one is what separates holding back exactly what the
 * renderer takes from guessing at it. Written as escapes because neither is
 * distinguishable from a space in source. */
const nonBreakingSpace = "\u00a0";
const ideographicSpace = "\u3000";

/** Every SGR sequence removed, which is what "with hues removed" means when
 * two printed grids are compared. */
function unstyled(output: string): string {
  return output.replace(stylingSequence, "");
}

/** Whether every escape sequence in the output is a styling one — which is the
 * whole of what a printed grid is allowed to emit. A cursor move, a screen
 * clear, an alternate-screen switch, and a synchronized-output marker would
 * all fail this. */
function stylingOnly(output: string): boolean {
  const escapes = output.match(anySequence)?.length ?? 0;
  const styling = output.match(stylingSequence)?.length ?? 0;
  return escapes === styling;
}

/** A theme override contributing a hue, so "the hue drops out where hues are
 * disabled" is a difference a test can see. The default theme names no hue at
 * all, so without one there would be nothing to drop. */
function hueing(hue: string): PluginDefinition {
  return {
    identity: { name: "hues" },
    load:
      () =>
      ({ register }) => {
        register("theme-override", { content: { hue } });
      },
  };
}

/**
 * The grid capability as a command sees it, read while the command runs rather
 * than during the consumer's own initialization — the only place it can see
 * every provider, because the registry shows a plugin only what committed
 * before it.
 */
async function obtainGrid(
  plugins: readonly PluginDefinition[] = [],
  env: Record<string, string | undefined> = {},
): Promise<{
  readonly grid: Grid;
  readonly count: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let grid: Grid | undefined;
  let count = -1;
  const consumer: PluginDefinition = {
    identity: { name: "surface" },
    load:
      () =>
      ({ command, registrations }) => {
        command((namespace) =>
          namespace.action(() => {
            const registered = registrations<Grid>("grid");
            count = registered.length;
            grid = registered[0];
          }),
        );
      },
  };
  const context = captureContext(env);
  expect(
    await main(
      ["surface"],
      [themePlugin, ...plugins, gridPlugin, consumer],
      context,
    ),
  ).toBe(0);
  if (!grid) throw new Error("The grid capability was not registered");
  return {
    grid,
    count,
    stdout: context.stdoutText(),
    stderr: context.stderrText(),
  };
}

/** One grid printed to a stream of the given shape, with what it wrote. */
async function print(
  request: Omit<GridRequest, "stream">,
  stream: Recorder = recorder(),
  plugins: readonly PluginDefinition[] = [],
  env: Record<string, string | undefined> = {},
): Promise<string> {
  const { grid } = await obtainGrid(plugins, env);
  grid.print({ ...request, stream });
  return stream.text();
}

/** A printed grid as its lines, without the trailing newline that ends it. */
function lines(output: string): readonly string[] {
  expect(output.endsWith("\n")).toBe(true);
  return unstyled(output).slice(0, -1).split("\n");
}

describe("the grid capability", () => {
  test("is registered exactly once for a command to read", async () => {
    const { count } = await obtainGrid();

    expect(count).toBe(1);
  });

  test("claims no command namespace", async () => {
    const context = captureContext();

    const exitCode = await main(["grid"], [themePlugin, gridPlugin], context);

    expect(exitCode).not.toBe(0);
    expect(context.stderrText()).toContain('Unknown command "grid"');
  });

  test("hands every consumer the same frozen capability", async () => {
    const { grid } = await obtainGrid();

    expect(Object.isFrozen(grid)).toBe(true);
  });

  test("fails when the theme it needs is not composed exactly once", async () => {
    let grid: Grid | undefined;
    const consumer: PluginDefinition = {
      identity: { name: "surface" },
      load:
        () =>
        ({ command, registrations }) => {
          command((namespace) =>
            namespace.action(() => {
              grid = registrations<Grid>("grid")[0];
            }),
          );
        },
    };
    expect(
      await main(["surface"], [gridPlugin, consumer], captureContext()),
    ).toBe(0);

    expect(() =>
      grid?.print({ stream: recorder(), rows: [["alpha"]] }),
    ).toThrow("Expected exactly one theme capability, but found 0");
  });
});

describe("printing a grid", () => {
  test("writes an aligned table to the stream the request carries", async () => {
    const output = await print({
      headers: ["NAME", "COUNT"],
      rows: [
        ["alpha", { text: "1", align: "end" }],
        ["charlie-delta", { text: "220", align: "end" }],
      ],
      summary: "2 rows",
    });

    expect(lines(output)).toEqual([
      "NAME           COUNT",
      "alpha              1",
      "charlie-delta    220",
      "",
      "2 rows",
    ]);
  });

  test("writes nothing to the streams the command itself was given", async () => {
    const stream = recorder();
    const { grid, stdout, stderr } = await obtainGrid();

    grid.print({ stream, rows: [["alpha"]] });

    expect(stream.text()).toBe("alpha\n");
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  test("prints a grid with no rows as its empty message", async () => {
    expect(
      lines(
        await print({
          headers: ["NAME"],
          rows: [],
          empty: "Nothing to show.",
          summary: "0 rows",
        }),
      ),
    ).toEqual(["Nothing to show.", "", "0 rows"]);
  });

  test("prints nothing at all when there is nothing to print", async () => {
    expect(await print({ rows: [] })).toBe("");
  });

  test("does not require an interactive stream", async () => {
    const redirected = recorder({ isTTY: false });

    expect(lines(await print({ rows: [["alpha"]] }, redirected))).toEqual([
      "alpha",
    ]);
  });

  test("removes control characters from every string it draws", async () => {
    const output = await print({
      headers: ["N\u001b[2JAME"],
      rows: [["al\npha"]],
      summary: "1 row",
    });

    expect(lines(output)).toEqual(["N[2JAME", "alpha", "", "1 row"]);
    expect(stylingOnly(output)).toBe(true);
  });

  test("prints the same table however wide the stream says it is", async () => {
    // A table needs no width at all, so a narrow terminal does not re-flow it
    // and a wide one does not pad it out: the canvas is the measured grid.
    const request = {
      headers: ["NAME", "COUNT"],
      rows: [
        ["charlie-delta", "220"],
        ["b", "1"],
      ],
      summary: "2 rows",
    } as const satisfies Omit<GridRequest, "stream">;

    const narrow = await print(request, recorder({ columns: 5 }));
    const wide = await print(request, recorder({ columns: 200 }));

    expect(narrow).toBe(wide);
    expect(lines(narrow)).toEqual([
      "NAME           COUNT",
      "charlie-delta  220",
      "b              1",
      "",
      "2 rows",
    ]);
  });

  test("prints a cell's own trailing spaces and adds none of its own", async () => {
    // Two different rules, one per row. The grid rewrites nothing the consumer
    // supplied, so the first row's last cell keeps the two spaces it was given.
    // The grid also pads no column past the last cell with anything in it, so
    // the second row ends on a character even though its column is a space
    // wider than the cell that ends it.
    const output = await print({
      rows: [
        ["alpha", "b  "],
        ["c", "dd"],
      ],
    });

    expect(lines(output)).toEqual(["alpha  b  ", "c      dd"]);
  });

  test("prints trailing whitespace a space pattern would have missed", async () => {
    // The renderer ends a line with `trimEnd`, which removes the whole Unicode
    // whitespace set rather than the ASCII space alone. A cell ending in a
    // non-breaking or an ideographic space is therefore one the grid has to
    // hold back too, which is why what it holds back is computed with
    // `trimEnd` rather than with a pattern that would have covered only the
    // last of these three.
    const output = await print({
      rows: [
        ["a", `x${nonBreakingSpace}`],
        ["b", `y${ideographicSpace}`],
        ["c", "z  "],
      ],
    });

    expect(lines(output)).toEqual([
      `a  x${nonBreakingSpace}`,
      `b  y${ideographicSpace}`,
      "c  z  ",
    ]);
  });

  test("prints that whitespace the same whether or not the cell is hued", async () => {
    // The renderer removes what trails a line, and it cannot see a styled run
    // to remove — so a cell ending in whitespace would survive with a hue and
    // be rewritten without one, which would make the printed characters depend
    // on the colour decision.
    const request = {
      rows: [[`x${nonBreakingSpace}`], [`y${ideographicSpace}`], ["z  "]],
    } as const;
    const hue = [hueing("red")];

    const coloured = await print(request, recorder({ isTTY: true }), hue, {});
    const plain = await print(request, recorder({ isTTY: true }), hue, {
      NO_COLOR: "1",
    });

    expect(plain).toBe(`x${nonBreakingSpace}\ny${ideographicSpace}\nz  \n`);
    expect(unstyled(coloured)).toBe(plain);
  });

  test("prints a cell of nothing but spaces as those spaces", async () => {
    // Held back in their entirety, so the line the renderer draws is empty and
    // what is printed is the consumer's spaces alone. It is not the
    // placeholder either: that is for a cell left with nothing after its
    // control characters are removed, and a space is not one of those.
    expect(await print({ rows: [["alpha", "   "]] })).toBe("alpha     \n");
  });

  test("draws a cell left empty as the placeholder", async () => {
    expect(lines(await print({ rows: [["alpha", ""], ["b"]] }))).toEqual([
      "alpha  —",
      "b      —",
    ]);
  });
});

describe("what a printed grid may emit", () => {
  test("carries no repaint, cursor, or screen-clearing sequence", async () => {
    const output = await print(
      {
        headers: ["NAME"],
        rows: [["alpha"], ["b"]],
        summary: "2 rows",
      },
      recorder({ isTTY: true, columns: 80 }),
    );

    expect(stylingOnly(output)).toBe(true);
    expect(output).not.toContain(`${escapeCharacter}[?`);
  });

  test("prints the same bytes on a terminal and through a pipe", async () => {
    const request = {
      layout: "flow",
      headers: ["IGNORED"],
      rows: [["alpha", "beta"], ["gamma"], ["delta"]],
      summary: "4 items",
    } as const satisfies Omit<GridRequest, "stream">;

    const terminal = await print(
      request,
      recorder({ isTTY: true, columns: defaultLayoutColumns }),
    );
    const piped = await print(request, recorder());

    expect(unstyled(terminal)).toBe(unstyled(piped));
    // The default theme names no hue at all, so there is nothing for the
    // colour decision to drop and the two are identical byte for byte.
    expect(terminal).toBe(piped);
  });

  test("emits no hue where hues are disabled and the hued one where they are", async () => {
    const request = { rows: [["alpha"]] } as const;
    const hue = [hueing("red")];

    const coloured = await print(
      request,
      recorder({ isTTY: true }),
      hue,
      // A terminal with nothing above it in the precedence order to say
      // otherwise is the one case that emits hues.
      {},
    );
    const plain = await print(request, recorder({ isTTY: true }), hue, {
      NO_COLOR: "1",
    });

    expect(coloured).toContain(`${escapeCharacter}[31m`);
    expect(unstyled(coloured)).toBe(plain);
    expect(plain).toBe("alpha\n");
  });
});

describe("the width a layout decides against", () => {
  const rows = [
    ["alpha", "beta", "gamma"],
    ["delta", "epsilon", "zeta"],
  ] as const;

  test("takes the stream's own width", async () => {
    expect(
      lines(
        await print(
          { layout: "flow", rows: [...rows] },
          recorder({ columns: 16 }),
        ),
      ),
    ).toEqual(["alpha    delta", "beta     epsilon", "gamma    zeta"]);
  });

  test("takes eighty columns from a stream reporting none", async () => {
    const reported = await print(
      { layout: "flow", rows: [...rows] },
      recorder({ columns: defaultLayoutColumns }),
    );
    const silent = await print({ layout: "flow", rows: [...rows] }, recorder());

    expect(lines(silent)).toEqual([
      "alpha    beta     gamma    delta    epsilon  zeta",
    ]);
    expect(silent).toBe(reported);
  });
});
