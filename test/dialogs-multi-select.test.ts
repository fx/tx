import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type {
  Dialogs,
  SelectOption,
  SelectProps,
  SelectRequest,
  SelectResult,
} from "@fx/tx/dialogs";
import { animationInterval } from "../plugins/dialogs/animation.ts";
import {
  type ColumnCell,
  cellsColumnWidth,
  columnCells,
  columnWidth,
  tickedGlyph,
  untickedGlyph,
} from "../plugins/dialogs/columns.ts";
import dialogsPlugin from "../plugins/dialogs/index.ts";
import type { OptionWindow } from "../plugins/dialogs/viewport.ts";
import themePlugin from "../plugins/theme/index.ts";
import { main } from "../src/cli.ts";
import type {
  CommandContext,
  CoreDependencies,
  PluginDefinition,
} from "../src/plugin.ts";
import { coreDependencies } from "../src/plugins.ts";

/**
 * Multi-select, driven through `select` on captured terminal streams and
 * through an embedded `Select` in a host plugin's own render session. Every
 * scenario of the Multi-Select section of the dialogs specification has a test
 * here under its own name.
 */

const ESCAPE = String.fromCharCode(27);
const CTRL_SPACE = String.fromCharCode(0);
const BACKSPACE = String.fromCharCode(127);
const CARRIAGE_RETURN = "\r";
const SPACE = " ";
const UP = `${ESCAPE}[A`;
const DOWN = `${ESCAPE}[B`;
const RIGHT = `${ESCAPE}[C`;
const LEFT = `${ESCAPE}[D`;

/** The top-left corner of a select's frame, which opens every frame whatever
 * its title has become. */
const PANEL = "╔═";

class TerminalInput extends PassThrough {
  readonly isTTY = true;
  readonly rawModes: boolean[] = [];
  isRaw = false;

  setRawMode(enabled: boolean): this {
    this.rawModes.push(enabled);
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

class TerminalOutput extends PassThrough {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
  #output = "";

  constructor() {
    super();
    this.on("data", (chunk) => {
      this.#output += chunk.toString();
    });
  }

  text(): string {
    return this.#output;
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** Generous, because nothing it waits behind is an animation. */
const BUDGET = animationInterval * 20;

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + BUDGET;
  for (;;) {
    if (predicate()) return;
    if (performance.now() >= deadline) {
      throw new Error("timed out waiting for dialog state");
    }
    await pause(1);
  }
}

const CONTROL_SEQUENCE = new RegExp(`${ESCAPE}\\[[\\d;?]*[a-zA-Z]`, "g");
const CURSOR_SEQUENCE = new RegExp(`${ESCAPE}\\[[\\d;?]*[A-Za-ln-z]`, "g");
const STYLING_SEQUENCE = new RegExp(`${ESCAPE}\\[([\\d;]*)m`, "g");

function stripped(text: string): string {
  return text.replace(CONTROL_SEQUENCE, "");
}

/** The frame on screen, from the start of the row carrying the last
 * occurrence of `anchor`: Ink rewrites its whole output on every render. */
function lastFrame(output: TerminalOutput, anchor = PANEL): string {
  const text = output.text();
  const found = text.lastIndexOf(anchor);
  expect(found).toBeGreaterThanOrEqual(0);
  const start = text.lastIndexOf("\n", found) + 1;
  let boundary = 0;
  for (const match of text.slice(start, found).matchAll(CURSOR_SEQUENCE)) {
    boundary = (match.index as number) + match[0].length;
  }
  return text.slice(start + boundary);
}

function frameRows(output: TerminalOutput, anchor = PANEL): readonly string[] {
  const rows = stripped(lastFrame(output, anchor)).split("\n");
  while (rows.at(-1) === "") rows.pop();
  return rows;
}

/** Whether `frame` has been written yet and contains `needle`. */
function shows(output: TerminalOutput, needle: string, anchor = PANEL) {
  try {
    return stripped(lastFrame(output, anchor)).includes(needle);
  } catch {
    return false;
  }
}

/** The styling in force at every character of `text`, as the SGR attributes
 * a test reads: dimmed, inverted, and the foreground hue. */
type Styled = {
  readonly char: string;
  readonly dim: boolean;
  readonly inverse: boolean;
  readonly hue: string | undefined;
};

function styled(text: string): readonly Styled[] {
  const cells: Styled[] = [];
  let dim = false;
  let inverse = false;
  let hue: string | undefined;
  let cursor = 0;
  const take = (piece: string) => {
    for (const char of piece) cells.push({ char, dim, inverse, hue });
  };
  for (const match of text.matchAll(STYLING_SEQUENCE)) {
    take(text.slice(cursor, match.index));
    cursor = (match.index as number) + match[0].length;
    for (const code of (match[1] as string).split(";")) {
      if (code === "" || code === "0") {
        dim = false;
        inverse = false;
        hue = undefined;
      } else if (code === "2") dim = true;
      else if (code === "22") dim = false;
      else if (code === "7") inverse = true;
      else if (code === "27") inverse = false;
      else if (code === "31") hue = "red";
      else if (code === "39") hue = undefined;
    }
  }
  take(text.slice(cursor));
  return cells;
}

/** The styling of the first character of the first occurrence of `needle`. */
function styleOf(text: string, needle: string): Styled | undefined {
  const cells = styled(text);
  const at = cells
    .map((cell) => cell.char)
    .join("")
    .indexOf(needle);
  return at < 0 ? undefined : cells[at];
}

/** The marker on a row that opens a sub-dialog. */
const EXPAND_MARKER = "▸";

/** Every inverted run of `frame` as the text it carries — trimmed, with the
 * marker of a row that leads somewhere taken off — and the terminal column it
 * starts at: the cursor bars. */
function barRuns(
  frame: string,
): readonly { readonly text: string; readonly column: number }[] {
  const runs: { text: string; column: number }[] = [];
  const close = (run: string, column: number) => {
    const text = run.trim();
    runs.push({
      text: text.endsWith(` ${EXPAND_MARKER}`)
        ? text.slice(0, -2).trimEnd()
        : text,
      column,
    });
  };
  for (const line of frame.split("\n")) {
    let run = "";
    let start = 0;
    for (const [column, cell] of styled(line).entries()) {
      if (cell.inverse) {
        if (run === "") start = column;
        run += cell.char;
      } else if (run !== "") {
        close(run, start);
        run = "";
      }
    }
    if (run !== "") close(run, start);
  }
  return runs;
}

function bars(frame: string): readonly string[] {
  return barRuns(frame).map((run) => run.text);
}

/** The cursor bar of the column taking keys: the rightmost one on screen. */
function activeRow(output: TerminalOutput, anchor = PANEL): string | undefined {
  try {
    const runs = [...barRuns(lastFrame(output, anchor))];
    runs.sort((one, other) => one.column - other.column);
    return runs.at(-1)?.text;
  } catch {
    return undefined;
  }
}

function labelled(...labels: readonly string[]): SelectOption<string>[] {
  return labels.map((label) => ({ label, value: label }));
}

/** One step: a chunk written to the dialog's input, or a look at the terminal
 * while the dialog is still open. */
type Step = string | ((output: TerminalOutput) => void | Promise<void>);

/** A theme override hueing the `marker` variable alone, so a glyph drawn as
 * `marker` can be told from one drawn as `chrome`, which the default theme
 * dims alike. */
const markedRed: PluginDefinition = {
  identity: { name: "marked" },
  load:
    () =>
    ({ register }) => {
      register("@fx/tx/theme-override", { marker: { hue: "red" } });
    },
};

/** `select` driven on a captured terminal, answering what it resolved with or
 * rejected with and what was drawn. */
async function runSelect<T>(
  request: SelectRequest<T>,
  steps: readonly Step[],
  options: {
    readonly output?: TerminalOutput;
    readonly plugins?: readonly PluginDefinition[];
  } = {},
): Promise<{
  readonly result: SelectResult<T> | undefined;
  readonly failure: unknown;
  readonly output: TerminalOutput;
  readonly input: TerminalInput;
  readonly exitCode: number;
}> {
  const input = new TerminalInput();
  const output = options.output ?? new TerminalOutput();
  let result: SelectResult<T> | undefined;
  let failure: unknown;
  const consumer: PluginDefinition = {
    identity: { name: "choose" },
    load:
      () =>
      ({ command, registrations }) => {
        command((namespace) =>
          namespace.action(async () => {
            const [dialogs] = registrations<Dialogs>("@fx/tx/dialogs");
            try {
              result = await (dialogs as Dialogs).select(request);
            } catch (error) {
              failure = error;
            }
          }),
        );
      },
  };
  const context: CommandContext = {
    cwd: "/work",
    env: {},
    stdin: input as unknown as NodeJS.ReadStream,
    stdout: new TerminalOutput() as unknown as NodeJS.WriteStream,
    stderr: output as unknown as NodeJS.WriteStream,
    plugin: { name: "choose" },
  };
  const running = main(
    ["choose"],
    [themePlugin, ...(options.plugins ?? []), dialogsPlugin, consumer],
    context,
  );
  if (steps.length > 0) {
    await until(() => input.rawModes.includes(true));
    for (const step of steps) {
      if (typeof step === "string") input.write(step);
      else await step(output);
      await pause(2);
    }
  }
  const exitCode = await running;
  return { result, failure, output, input, exitCode };
}

/** A step waiting until the frame on screen shows `needle`. */
function seen(needle: string): Step {
  return (output) => until(() => shows(output, needle));
}

/** A step waiting until the bar of the rightmost column reads `row`. */
function barOn(row: string): Step {
  return (output) => until(() => activeRow(output) === row);
}

const ticked = (label: string) => `${tickedGlyph} ${label}`;
const unticked = (label: string) => `${untickedGlyph} ${label}`;

const greek: SelectRequest<string> = {
  message: "Which hosts?",
  multiple: true,
  options: labelled("alpha", "beta", "gamma"),
};

describe("multi-select through select", () => {
  test("Tick two and take them", async () => {
    const { result } = await runSelect(greek, [
      barOn(unticked("alpha")),
      SPACE,
      barOn(ticked("alpha")),
      DOWN,
      DOWN,
      SPACE,
      barOn(ticked("gamma")),
      CARRIAGE_RETURN,
    ]);
    expect(result?.value).toBe("gamma");
    expect(result?.selected).toEqual(["alpha", "gamma"]);
    expect({ ...result?.values }).toEqual({});
  });

  test("Nothing ticked takes the active option", async () => {
    const { result } = await runSelect(greek, [
      barOn(unticked("alpha")),
      DOWN,
      barOn(unticked("beta")),
      CARRIAGE_RETURN,
    ]);
    expect(result?.value).toBe("beta");
    expect(result?.selected).toEqual(["beta"]);
  });

  test("A pre-tick is submitted without being touched", async () => {
    const request: SelectRequest<string> = {
      ...greek,
      options: [
        { label: "alpha", value: "alpha" },
        { label: "beta", value: "beta", selected: true },
        { label: "gamma", value: "gamma", selected: false },
      ],
    };
    let drawn: readonly string[] = [];
    const { result } = await runSelect(request, [
      barOn(unticked("alpha")),
      (output) => {
        drawn = frameRows(output);
      },
      CARRIAGE_RETURN,
    ]);
    expect(drawn.some((row) => row.includes(ticked("beta")))).toBe(true);
    expect(drawn.some((row) => row.includes(unticked("gamma")))).toBe(true);
    expect(result?.value).toBe("alpha");
    expect(result?.selected).toEqual(["beta"]);
  });

  test("A pre-tick outside a multiple column is rejected", async () => {
    const nested: SelectRequest<string> = {
      message: "Root",
      multiple: true,
      options: [
        {
          label: "deeper",
          value: "deeper",
          dialog: {
            message: "Nested",
            options: [
              { label: "one", value: "one" },
              { label: "two", value: "two", selected: true },
            ],
          },
        },
      ],
    };
    const { failure, output, input, result } = await runSelect(nested, []);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "A pre-ticked select option requires a column declaring multiple",
    );
    expect(result).toBeUndefined();
    expect(output.text()).toBe("");
    expect(input.rawModes).toEqual([]);
  });

  test("a pre-tick in a single-choice root is rejected, and a cyclic request still terminates", async () => {
    const options: SelectOption<string>[] = [
      { label: "loop", value: "loop" },
      { label: "bad", value: "bad", selected: true },
    ];
    const root: SelectRequest<string> = { message: "Cycle", options };
    // The first option opens the request it belongs to, so the walk meets the
    // root again and has to stop there rather than recurse for ever.
    options[0] = { label: "loop", value: "loop", dialog: root };
    const { failure, output } = await runSelect(root, []);
    expect((failure as Error).message).toBe(
      "A pre-ticked select option requires a column declaring multiple",
    );
    expect(output.text()).toBe("");
  });

  test("selected: false outside a multiple column is accepted", async () => {
    const { result, failure } = await runSelect(
      {
        message: "Single",
        options: [
          { label: "alpha", value: "alpha", selected: false },
          { label: "beta", value: "beta" },
        ],
      },
      [barOn("alpha"), CARRIAGE_RETURN],
    );
    expect(failure).toBeUndefined();
    expect(result?.selected).toEqual(["alpha"]);
  });

  test("Space ticks rather than filters", async () => {
    const request: SelectRequest<string> = {
      message: "Which hosts?",
      multiple: true,
      options: labelled("zeta", "cab", "abacus"),
    };
    let drawn: readonly string[] = [];
    const { result } = await runSelect(request, [
      barOn(unticked("zeta")),
      "a",
      seen("› a"),
      SPACE,
      barOn(ticked("zeta")),
      "b",
      seen("› ab"),
      (output) => {
        drawn = frameRows(output);
      },
      CARRIAGE_RETURN,
    ]);
    // The filter took `a` and `b` and never the space between them, and the
    // option active when Space was pressed is ticked — and taken, although
    // `ab` has hidden it since.
    expect(
      drawn.some((row) => row.includes("› ab█") || row.includes("› ab ")),
    ).toBe(true);
    expect(drawn.some((row) => row.includes("zeta"))).toBe(false);
    expect(result?.value).toBe("cab");
    expect(result?.selected).toEqual(["zeta"]);
  });

  test("A pasted space still filters", async () => {
    const request: SelectRequest<string> = {
      message: "Which branch?",
      multiple: true,
      options: labelled("release branch", "main"),
    };
    let drawn: readonly string[] = [];
    const { result } = await runSelect(request, [
      barOn(unticked("release branch")),
      "rel br",
      seen("› rel br"),
      (output) => {
        drawn = frameRows(output);
      },
      CARRIAGE_RETURN,
    ]);
    expect(drawn.some((row) => row.includes("main"))).toBe(false);
    expect(drawn.some((row) => row.includes(unticked("release branch")))).toBe(
      true,
    );
    expect(drawn.some((row) => row.includes(tickedGlyph))).toBe(false);
    expect(result?.value).toBe("release branch");
    expect(result?.selected).toEqual(["release branch"]);
  });

  test("A hidden tick is still taken", async () => {
    let drawn: readonly string[] = [];
    const { result } = await runSelect(greek, [
      barOn(unticked("alpha")),
      SPACE,
      barOn(ticked("alpha")),
      "gam",
      barOn(unticked("gamma")),
      (output) => {
        drawn = frameRows(output);
      },
      CARRIAGE_RETURN,
    ]);
    expect(drawn.some((row) => row.includes("alpha"))).toBe(false);
    expect(result?.value).toBe("gamma");
    expect(result?.selected).toEqual(["alpha"]);
  });

  test("Ticks across columns", async () => {
    const request: SelectRequest<string> = {
      message: "Root",
      multiple: true,
      options: [
        { label: "plain", value: "plain" },
        {
          label: "opens",
          value: "opens",
          dialog: {
            message: "Nested",
            multiple: true,
            options: labelled("first", "second"),
          },
        },
      ],
    };
    const { result } = await runSelect(request, [
      barOn(unticked("plain")),
      SPACE,
      barOn(ticked("plain")),
      DOWN,
      barOn(unticked("opens")),
      CARRIAGE_RETURN,
      barOn(unticked("first")),
      DOWN,
      SPACE,
      barOn(ticked("second")),
      UP,
      barOn(unticked("first")),
      CARRIAGE_RETURN,
    ]);
    expect(result?.value).toBe("first");
    expect(result?.selected).toEqual(["plain", "second"]);
  });

  test("A tick in one column is enough", async () => {
    const request: SelectRequest<string> = {
      message: "Root",
      options: [
        {
          label: "opens",
          value: "opens",
          dialog: {
            message: "Nested",
            multiple: true,
            options: labelled("first", "second"),
          },
        },
      ],
    };
    const { result } = await runSelect(request, [
      barOn("opens"),
      CARRIAGE_RETURN,
      barOn(unticked("first")),
      DOWN,
      SPACE,
      barOn(ticked("second")),
      UP,
      barOn(unticked("first")),
      CARRIAGE_RETURN,
    ]);
    expect(result?.value).toBe("first");
    expect(result?.selected).toEqual(["second"]);
  });

  test("Ticks survive backing out", async () => {
    const request: SelectRequest<string> = {
      message: "Root",
      options: [
        {
          label: "opens",
          value: "opens",
          dialog: {
            message: "Nested",
            multiple: true,
            options: labelled("first", "second"),
          },
        },
      ],
    };
    let reopened: readonly string[] = [];
    const { result } = await runSelect(request, [
      barOn("opens"),
      RIGHT,
      barOn(unticked("first")),
      DOWN,
      SPACE,
      barOn(ticked("second")),
      LEFT,
      (output) => until(() => !shows(output, "Nested")),
      RIGHT,
      seen("Nested"),
      (output) => {
        reopened = frameRows(output);
      },
      ESCAPE,
      (output) => until(() => !shows(output, "Nested")),
      ESCAPE,
    ]);
    expect(reopened.some((row) => row.includes(ticked("second")))).toBe(true);
    // Re-opened on its first option, as any opened column is.
    expect(reopened.some((row) => row.includes(unticked("first")))).toBe(true);
    expect(result).toBeUndefined();
  });

  test("a closed column's ticks are remembered but not taken", async () => {
    const request: SelectRequest<string> = {
      message: "Root",
      options: [
        {
          label: "opens",
          value: "opens",
          dialog: {
            message: "Nested",
            multiple: true,
            options: labelled("first", "second"),
          },
        },
        { label: "elsewhere", value: "elsewhere" },
      ],
    };
    const { result } = await runSelect(request, [
      barOn("opens"),
      CARRIAGE_RETURN,
      barOn(unticked("first")),
      SPACE,
      barOn(ticked("first")),
      LEFT,
      barOn("opens"),
      DOWN,
      barOn("elsewhere"),
      CARRIAGE_RETURN,
    ]);
    expect(result?.value).toBe("elsewhere");
    expect(result?.selected).toEqual(["elsewhere"]);
  });

  test("two options sharing one sub-request keep ticks of their own", async () => {
    const shared: SelectRequest<string> = {
      message: "Shared",
      multiple: true,
      options: labelled("first", "second"),
    };
    const request: SelectRequest<string> = {
      message: "Root",
      options: [
        { label: "one", value: "one", dialog: shared },
        { label: "two", value: "two", dialog: shared },
      ],
    };
    const { result } = await runSelect(request, [
      barOn("one"),
      RIGHT,
      barOn(unticked("first")),
      SPACE,
      barOn(ticked("first")),
      LEFT,
      barOn("one"),
      DOWN,
      barOn("two"),
      RIGHT,
      seen("Shared"),
      barOn(unticked("first")),
      CARRIAGE_RETURN,
    ]);
    expect(result?.value).toBe("first");
    expect(result?.selected).toEqual(["first"]);
  });

  test("a nested column opens with its own pre-ticks", async () => {
    const request: SelectRequest<string> = {
      message: "Root",
      options: [
        {
          label: "opens",
          value: "opens",
          dialog: {
            message: "Nested",
            multiple: true,
            options: [
              { label: "first", value: "first" },
              { label: "second", value: "second", selected: true },
            ],
          },
        },
      ],
    };
    const { result } = await runSelect(request, [
      barOn("opens"),
      CARRIAGE_RETURN,
      seen(ticked("second")),
      CARRIAGE_RETURN,
    ]);
    expect(result?.value).toBe("first");
    expect(result?.selected).toEqual(["second"]);
  });

  test("Space again unticks", async () => {
    const { result } = await runSelect(greek, [
      barOn(unticked("alpha")),
      SPACE,
      barOn(ticked("alpha")),
      SPACE,
      barOn(unticked("alpha")),
      CARRIAGE_RETURN,
    ]);
    expect(result?.selected).toEqual(["alpha"]);
  });

  test("Space with nothing visible does nothing", async () => {
    const { result } = await runSelect(greek, [
      barOn(unticked("alpha")),
      "zzz",
      seen("no match"),
      SPACE,
      BACKSPACE,
      BACKSPACE,
      BACKSPACE,
      barOn(unticked("alpha")),
      CARRIAGE_RETURN,
    ]);
    expect(result?.selected).toEqual(["alpha"]);
  });

  test("a space under a modifier neither ticks nor filters", async () => {
    let drawn: readonly string[] = [];
    const { result } = await runSelect(greek, [
      barOn(unticked("alpha")),
      CTRL_SPACE,
      `${ESCAPE}${SPACE}`,
      "x",
      seen("› x"),
      BACKSPACE,
      (output) => until(() => !shows(output, "no match")),
      (output) => {
        drawn = frameRows(output);
      },
      CARRIAGE_RETURN,
    ]);
    expect(drawn.some((row) => row.includes(tickedGlyph))).toBe(false);
    expect(result?.selected).toEqual(["alpha"]);
  });

  test("Space in a single-choice column reaches the filter", async () => {
    const { result } = await runSelect(
      { message: "Which branch?", options: labelled("release branch", "main") },
      [
        barOn("release branch"),
        "release",
        SPACE,
        "b",
        seen("› release b"),
        CARRIAGE_RETURN,
      ],
    );
    expect(result?.value).toBe("release branch");
    expect(result?.selected).toEqual(["release branch"]);
  });

  test("ticking an option that leads somewhere opens nothing, and Enter still opens it", async () => {
    const request: SelectRequest<string> = {
      message: "Root",
      multiple: true,
      options: [
        {
          label: "opens",
          value: "opens",
          dialog: {
            message: "Nested",
            options: labelled("inner"),
          },
        },
      ],
    };
    let afterTick: readonly string[] = [];
    const { result } = await runSelect(request, [
      barOn(unticked("opens")),
      SPACE,
      barOn(ticked("opens")),
      (output) => {
        afterTick = frameRows(output);
      },
      CARRIAGE_RETURN,
      seen("Nested"),
      CARRIAGE_RETURN,
    ]);
    expect(afterTick.some((row) => row.includes("inner"))).toBe(false);
    expect(result?.value).toBe("inner");
    expect(result?.selected).toEqual(["opens"]);
  });

  test("a finished field collection takes the ticks and not the ticked option's fields", async () => {
    const request: SelectRequest<string> = {
      message: "Which hosts?",
      multiple: true,
      options: [
        { label: "alpha", value: "alpha" },
        {
          label: "other",
          value: "other",
          fields: [{ type: "text", name: "host", message: "Which host?" }],
        },
      ],
    };
    const { result } = await runSelect(request, [
      barOn(unticked("alpha")),
      SPACE,
      barOn(ticked("alpha")),
      DOWN,
      barOn(unticked("other")),
      SPACE,
      barOn(ticked("other")),
      CARRIAGE_RETURN,
      (output) => until(() => output.text().includes("Which host?")),
      "omega",
      CARRIAGE_RETURN,
    ]);
    expect(result?.value).toBe("other");
    expect({ ...result?.values }).toEqual({ host: "omega" });
    expect(result?.selected).toEqual(["alpha", "other"]);

    // Completing on a plain option collects nothing, a ticked option's
    // fields included.
    const plain = await runSelect(request, [
      barOn(unticked("alpha")),
      DOWN,
      SPACE,
      barOn(ticked("other")),
      UP,
      barOn(unticked("alpha")),
      CARRIAGE_RETURN,
    ]);
    expect(plain.result?.value).toBe("alpha");
    expect({ ...plain.result?.values }).toEqual({});
    expect(plain.result?.selected).toEqual(["other"]);
  });

  test("a submitted text leaf takes the ticks of the columns under it", async () => {
    const request: SelectRequest<string> = {
      message: "Which hosts?",
      multiple: true,
      options: [
        { label: "alpha", value: "alpha" },
        {
          label: "tagged",
          value: "tagged",
          dialog: { type: "text", name: "tag", message: "Which tag?" },
        },
      ],
    };
    const { result } = await runSelect(request, [
      barOn(unticked("alpha")),
      SPACE,
      barOn(ticked("alpha")),
      DOWN,
      barOn(unticked("tagged")),
      RIGHT,
      (output) => until(() => output.text().includes("Which tag?")),
      "nightly",
      CARRIAGE_RETURN,
    ]);
    expect(result?.value).toBe("tagged");
    expect({ ...result?.values }).toEqual({ tag: "nightly" });
    expect(result?.selected).toEqual(["alpha"]);
  });

  test("a dialog with no multiple column takes the completing value alone", async () => {
    const { result } = await runSelect(
      { message: "Pick one", options: labelled("alpha", "beta") },
      [barOn("alpha"), DOWN, barOn("beta"), CARRIAGE_RETURN],
    );
    expect(result).toEqual({ value: "beta", values: {}, selected: ["beta"] });
  });
});

describe("multi-select presentation", () => {
  test("the hint names Space tick only where the column taking keys ticks", async () => {
    const request: SelectRequest<string> = {
      message: "Root",
      options: [
        {
          label: "opens",
          value: "opens",
          dialog: {
            message: "Nested",
            multiple: true,
            options: labelled("first"),
          },
        },
      ],
    };
    const hints: string[] = [];
    const hint = (output: TerminalOutput) => {
      hints.push(frameRows(output).at(-1) as string);
    };
    await runSelect(request, [
      barOn("opens"),
      hint,
      RIGHT,
      barOn(unticked("first")),
      hint,
      ESCAPE,
      barOn("opens"),
      hint,
      ESCAPE,
    ]);
    expect(hints.map((line) => line.trim())).toEqual([
      "↑↓ move · →/Enter open · type to filter · Esc cancel",
      "↑↓ move · Space tick · Enter select · ←/Esc back · type to filter",
      "↑↓ move · →/Enter open · type to filter · Esc cancel",
    ]);

    let rootHint = "";
    await runSelect(greek, [
      barOn(unticked("alpha")),
      (output) => {
        rootHint = (frameRows(output).at(-1) as string).trim();
      },
      ESCAPE,
    ]);
    expect(rootHint).toBe(
      "↑↓ move · Space tick · Enter select · type to filter · Esc cancel",
    );
  });

  test("the tick cell leads every row and rides under the cursor bar", async () => {
    let frame = "";
    await runSelect(greek, [
      DOWN,
      SPACE,
      barOn(ticked("beta")),
      (output) => {
        frame = lastFrame(output);
      },
      ESCAPE,
    ]);
    const rows = stripped(frame).split("\n");
    expect(rows[1]).toMatch(/^║ □ alpha +║$/);
    expect(rows[2]).toMatch(/^║ ■ beta +║$/);
    expect(rows[3]).toMatch(/^║ □ gamma +║$/);
    // The bar spans the row from its tick cell, so the tick is part of it.
    const bar = bars(frame);
    expect(bar).toEqual([ticked("beta")]);
    expect(styleOf(frame, tickedGlyph)?.inverse).toBe(true);
  });

  test("the default theme draws the tick cell as the marker variable", async () => {
    let plain = "";
    await runSelect(greek, [
      barOn(unticked("alpha")),
      (output) => {
        plain = lastFrame(output);
      },
      ESCAPE,
    ]);
    const gamma = plain.slice(plain.indexOf("gamma") - 12);
    // The default theme dims `marker`, and the label beside it is content.
    expect(styleOf(gamma, untickedGlyph)?.dim).toBe(true);
    expect(styleOf(gamma, "gamma")?.dim).toBe(false);

    // Hueing `marker` alone hues the glyph and nothing else, so what the
    // glyph names is `marker` rather than `chrome`, which is dimmed alike.
    let hued = "";
    await runSelect(
      greek,
      [
        barOn(unticked("alpha")),
        (output) => {
          hued = lastFrame(output);
        },
        ESCAPE,
      ],
      { plugins: [markedRed] },
    );
    const huedGamma = hued.slice(hued.indexOf("gamma") - 12);
    expect(styleOf(huedGamma, untickedGlyph)?.hue).toBe("red");
    expect(styleOf(huedGamma, "gamma")?.hue).toBeUndefined();
    expect(styleOf(hued, "║")?.hue).toBeUndefined();
  });

  test("a header row is offset by the tick cell so it stays over its fields", async () => {
    const request: SelectRequest<string> = {
      message: "Which release?",
      multiple: true,
      headers: ["Version", "Channel"],
      options: [
        { cells: ["1.6.1", "stable"], value: "1.6.1" },
        { cells: ["2.0.0-rc.1", "next"], value: "2.0.0-rc.1" },
      ],
    };
    let rows: readonly string[] = [];
    await runSelect(request, [
      barOn(`${untickedGlyph} 1.6.1       stable`),
      (output) => {
        rows = frameRows(output);
      },
      ESCAPE,
    ]);
    const header = rows[1] as string;
    const first = rows[2] as string;
    expect(header.indexOf("Version")).toBe(first.indexOf("1.6.1"));
    expect(header.indexOf("Channel")).toBe(first.indexOf("stable"));
    expect(first.indexOf(untickedGlyph)).toBe(header.indexOf("Version") - 2);
  });

  test("a narrow terminal narrows the label before the tick cell", async () => {
    const output = new TerminalOutput();
    output.columns = 20;
    let rows: readonly string[] = [];
    await runSelect(
      {
        message: "Which?",
        multiple: true,
        options: labelled("a label far too long for twenty columns"),
      },
      [
        (terminal) => until(() => shows(terminal, "…")),
        (terminal) => {
          rows = frameRows(terminal);
        },
        ESCAPE,
      ],
      { output },
    );
    // The row keeps its tick cell whole and gives up the label's end.
    expect(rows[1]).toMatch(/^║ □ a label far t… ║$/);
  });
});

describe("the tick cell in one column's cells", () => {
  function window(count: number): OptionWindow {
    return {
      renderedStart: 0,
      count,
      rememberedStart: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    };
  }

  function drawn(cell: ColumnCell | undefined): string {
    if (cell === undefined) return "";
    return `${cell.tick?.text ?? ""}${cell.text}${cell.marker?.text ?? ""}`;
  }

  const options: SelectOption<number>[] = [
    { label: "alpha", value: 1 },
    { label: "beta", value: 2, dialog: { message: "x", options: [] } },
  ];

  test("a column that ticks is two columns wider", () => {
    expect(columnWidth(5, false, false, true)).toBe(7);
    expect(columnWidth(5, true, false, true)).toBe(9);
    expect(columnWidth(5, false, false)).toBe(5);
    expect(cellsColumnWidth([3, 4], false, false, true)).toBe(11);
  });

  test("leads every option row, ticked or not, as marker or under the bar as cursor", () => {
    const cells = columnCells(options, [0, 1], window(2), 1, 9, 2, {
      bar: true,
      ticks: new Set([1]),
    });
    expect(cells.map(drawn)).toEqual(["□ alpha  ", "■ beta  ▸"]);
    expect(cells[0]?.tick).toEqual({ text: "□ ", variable: "marker" });
    expect(cells[1]?.tick).toEqual({ text: "■ ", variable: "cursor" });
  });

  test("keeps the tick and drops the marker in a column too narrow for both", () => {
    const cells = columnCells(options, [0, 1], window(2), 0, 4, 2, {
      bar: false,
      ticks: new Set<number>(),
    });
    expect(cells.map(drawn)).toEqual(["□ a…", "□ b…"]);
    expect(cells[1]?.marker).toBeUndefined();
    // One column affords the glyph alone, and nothing of the label.
    const narrowest = columnCells(options, [0], window(1), 0, 1, 1, {
      bar: false,
      ticks: new Set([0]),
    });
    expect(narrowest.map(drawn)).toEqual(["■"]);
  });

  test("a column matched to nothing spends its row saying so, with no tick", () => {
    const cells = columnCells(options, [], window(0), 0, 10, 1, {
      bar: true,
      ticks: new Set([0]),
    });
    expect(cells[0]?.tick).toBeUndefined();
    expect(drawn(cells[0])).toBe("no match  ");
  });

  test("a single-choice column carries no tick cell", () => {
    const cells = columnCells(options, [0], window(1), 0, 7, 1, { bar: true });
    expect(cells[0]?.tick).toBeUndefined();
    expect(drawn(cells[0])).toBe("alpha  ");
  });
});

/** The host's own terminal input. */
class HostInput extends TerminalInput {}

type Host = {
  readonly dialogs: Dialogs;
  readonly react: CoreDependencies["react"];
  readonly ink: CoreDependencies["ink"];
};

type Rendered = ReturnType<CoreDependencies["react"]["createElement"]>;

/** Runs `scenario` inside a host plugin's command, with the dialogs and the
 * injected React and Ink in hand. */
async function hosted(scenario: (host: Host) => Promise<void>): Promise<{
  readonly exitCode: number;
  readonly commandOutput: string;
}> {
  const stdout = new TerminalOutput();
  const stderr = new TerminalOutput();
  let failure: { readonly reason: unknown } | undefined;
  const host: PluginDefinition = {
    identity: { name: "host" },
    load:
      () =>
      ({ command, dependencies, registrations }) => {
        command((namespace) =>
          namespace.action(async () => {
            const [dialogs] = registrations<Dialogs>("@fx/tx/dialogs");
            try {
              await scenario({
                dialogs: dialogs as Dialogs,
                react: dependencies.react,
                ink: dependencies.ink,
              });
            } catch (reason) {
              failure = { reason };
            }
          }),
        );
      },
  };
  const exitCode = await main(
    ["host"],
    [themePlugin, dialogsPlugin, host],
    {
      cwd: "/work",
      env: {},
      stdin: new HostInput() as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    },
    coreDependencies,
  );
  if (failure) throw failure.reason;
  return { exitCode, commandOutput: stdout.text() + stderr.text() };
}

describe("multi-select through an embedded Select", () => {
  test("a host's Select ticks with Space and submits every tick", async () => {
    const { exitCode, commandOutput } = await hosted(
      async ({ dialogs, react, ink }) => {
        const Select = dialogs.Select as (
          props: SelectProps<string>,
        ) => Rendered;
        const calls: SelectResult<string>[] = [];
        let cancelled = 0;
        const output = new TerminalOutput();
        const input = new HostInput();
        const renderer = ink.render(
          react.createElement(
            ink.Box,
            { flexDirection: "column" },
            react.createElement(ink.Text, null, "Host header"),
            react.createElement(Select, {
              request: greek,
              width: 80,
              height: 8,
              isActive: true,
              onSubmit: (result: SelectResult<string>) => calls.push(result),
              onCancel: () => {
                cancelled += 1;
              },
            }),
          ),
          {
            stdout: output as unknown as NodeJS.WriteStream,
            stdin: input as unknown as NodeJS.ReadStream,
            stderr: output as unknown as NodeJS.WriteStream,
            exitOnCtrlC: false,
            patchConsole: false,
            interactive: true,
          },
        );
        const exit = renderer.waitUntilExit();
        const press = async (chunk: string) => {
          input.write(chunk);
          await pause(5);
        };
        await until(
          () => activeRow(output, "Host header") === unticked("alpha"),
        );
        await press(SPACE);
        await until(() => activeRow(output, "Host header") === ticked("alpha"));
        await press(DOWN);
        await press(DOWN);
        await press(SPACE);
        await until(() => activeRow(output, "Host header") === ticked("gamma"));
        expect(frameRows(output, "Host header").at(-1)?.trim()).toBe(
          "↑↓ move · Space tick · Enter select · type to filter · Esc cancel",
        );
        await press(CARRIAGE_RETURN);
        await until(() => calls.length > 0);
        await pause(animationInterval);
        expect(calls).toHaveLength(1);
        expect(cancelled).toBe(0);
        const [result] = calls;
        expect(result?.value).toBe("gamma");
        expect(result?.selected).toEqual(["alpha", "gamma"]);
        expect({ ...result?.values }).toEqual({});
        renderer.unmount();
        await exit;
      },
    );
    expect(exitCode).toBe(0);
    expect(commandOutput).toBe("");
  });

  test("a pre-tick the function form rejects fails the host's render", async () => {
    await hosted(async ({ dialogs, react, ink }) => {
      const Select = dialogs.Select as (props: SelectProps<string>) => Rendered;
      const request: SelectRequest<string> = {
        message: "Single",
        options: [{ label: "alpha", value: "alpha", selected: true }],
      };
      let rejection: unknown;
      try {
        await dialogs.select(request);
      } catch (error) {
        rejection = error;
      }
      const output = new TerminalOutput();
      const renderer = ink.render(
        react.createElement(Select, {
          request,
          width: 40,
          height: 8,
          isActive: true,
          onSubmit: () => {},
          onCancel: () => {},
        }),
        {
          stdout: output as unknown as NodeJS.WriteStream,
          stdin: new HostInput() as unknown as NodeJS.ReadStream,
          stderr: output as unknown as NodeJS.WriteStream,
          exitOnCtrlC: false,
          patchConsole: false,
          interactive: true,
        },
      );
      let failure: unknown;
      try {
        await renderer.waitUntilExit();
      } catch (error) {
        failure = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe((rejection as Error).message);
      expect(output.text()).not.toContain("╔");
    });
  });
});
