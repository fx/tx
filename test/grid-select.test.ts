import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { animationInterval } from "../plugins/dialogs/animation.ts";
import dialogsPlugin from "../plugins/dialogs/index.ts";
import type { CellOption } from "../plugins/grid/dialogs.ts";
import gridPlugin from "../plugins/grid/index.ts";
import {
  type RowChoice,
  selection,
  selectRequest,
} from "../plugins/grid/select.ts";
import type {
  GridRequest,
  GridSelection,
  GridSelectRequest,
} from "../plugins/grid/types.ts";
import themePlugin from "../plugins/theme/index.ts";
import { main } from "../src/cli.ts";
import type { CommandContext, PluginDefinition } from "../src/plugin.ts";

/**
 * The grid capability as a consumer declares it for itself: a local structural
 * type, because the capability is internal and nothing about grids is imported
 * across a plugin boundary or exported publicly.
 */
type Grid = {
  print(request: GridRequest): void;
  select<T, A>(
    request: GridSelectRequest<T, A>,
  ): Promise<GridSelection<T, A> | undefined>;
};

const ESCAPE = String.fromCharCode(27);
const CARRIAGE_RETURN = "\r";
const DOWN = `${ESCAPE}[B`;
const LEFT = `${ESCAPE}[D`;
const RIGHT = `${ESCAPE}[C`;
/** A screen-clearing sequence, which is what a cell's text must never be able
 * to put on the terminal. Built from the escape character rather than written
 * literally, so the source carries no control character. */
const CLEAR_SCREEN = `${ESCAPE}[2J`;

/** A terminal's input side: a stream the renderer can put into raw mode and a
 * test can script keystrokes into. It also records what was done to it,
 * because the terminal-handover guarantee is a statement about exactly that —
 * the raw mode left on it and the listeners left attached to it. */
class TerminalInput extends PassThrough {
  readonly isTTY: boolean;
  readonly rawModes: boolean[] = [];
  isRaw = false;
  failRawMode = false;
  #referenced = false;

  constructor(isTTY = true) {
    super();
    this.isTTY = isTTY;
  }

  hasRef(): boolean {
    return this.#referenced;
  }

  setRawMode(enabled: boolean): this {
    this.rawModes.push(enabled);
    if (enabled && this.failRawMode) throw new Error("raw mode failed");
    this.isRaw = enabled;
    return this;
  }

  ref(): this {
    this.#referenced = true;
    return this;
  }

  unref(): this {
    this.#referenced = false;
    return this;
  }
}

/** A terminal's output side, of a fixed size, keeping everything written to it
 * so a test can read what was on screen. */
class TerminalOutput extends PassThrough {
  readonly isTTY: boolean;
  readonly columns = 80;
  readonly rows = 24;
  #written = "";

  constructor(isTTY = true) {
    super();
    this.isTTY = isTTY;
    this.on("data", (chunk) => {
      this.#written += chunk.toString();
    });
  }

  text(): string {
    return this.#written;
  }
}

function commandContext(
  stdin: TerminalInput,
  stderr: TerminalOutput,
): CommandContext & { stdoutText(): string } {
  const stdout = new TerminalOutput();
  return {
    cwd: "/work",
    env: {},
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    plugin: { name: "test" },
    stdoutText: () => stdout.text(),
  };
}

/**
 * How long a wait for the grid to reach a state is given. Deliberately
 * generous — a first frame is not an animation, and a loaded runner can be
 * slow to produce one — and written in the constant the dialogs animate on so
 * it can never come to race them.
 */
const DIALOG_BUDGET = animationInterval * 20;

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + DIALOG_BUDGET;
  for (;;) {
    if (predicate()) return;
    if (performance.now() >= deadline) {
      throw new Error("timed out waiting for the interactive grid");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

/** Every control sequence the renderer writes around a frame, so a test that
 * matches on what the reader sees can ignore them. */
const CONTROL_SEQUENCE = new RegExp(`${ESCAPE}\\[[\\d;?]*[a-zA-Z]`, "g");

/** The sequence a red hue is emitted as, which is how a test sees whether a
 * cell's declared role survived into a selecting grid. */
const RED = `${ESCAPE}[31m`;

function screen(stderr: TerminalOutput): string {
  return stderr.text().replace(CONTROL_SEQUENCE, "");
}

/** One step a running grid takes: a chunk written to its input, or something
 * read while it is still open — the frame on screen, or what standard output
 * has had written to it so far. */
type Step =
  | string
  | ((
      stderr: TerminalOutput,
      stdoutText: () => string,
    ) => void | Promise<void>);

/** Waits until the frame on screen carries this text, so a keystroke is never
 * written into a column that has not been drawn yet. */
function shown(stderr: TerminalOutput, text: string): Step {
  return async () => {
    await until(() => screen(stderr).includes(text));
  };
}

/** A theme override contributing a hue to a variable, so "a declared role does
 * not survive into a selecting grid" is a difference a test can see. The
 * default theme names no hue at all, so without one there would be nothing to
 * look for. */
function hueing(variable: string, hue: string): PluginDefinition {
  return {
    identity: { name: "hues" },
    load:
      () =>
      ({ register }) => {
        register("@fx/tx/theme-override", { [variable]: { hue } });
      },
  };
}

type Driven<T, A> = {
  readonly chosen: GridSelection<T, A> | undefined;
  readonly failure: unknown;
  readonly stdin: TerminalInput;
  readonly stderr: TerminalOutput;
  readonly stdout: string;
  readonly exitCode: number;
};

/**
 * One interactive grid driven on injected streams.
 *
 * The composed plugins default to the three an interactive grid needs — a
 * theme for the dialog to resolve its appearances from, the dialogs capability
 * the rows are driven by, and the grid itself. A subset is not a smaller test
 * but a different one, and one whose dialog would throw before raw mode and
 * leave a wait for it hanging until the runner timed the case out.
 */
async function drive<T, A>(
  request: GridSelectRequest<T, A>,
  steps: readonly Step[] = [],
  options: {
    readonly stdin?: TerminalInput;
    readonly stderr?: TerminalOutput;
    readonly plugins?: readonly PluginDefinition[];
  } = {},
): Promise<Driven<T, A>> {
  const stdin = options.stdin ?? new TerminalInput();
  const stderr = options.stderr ?? new TerminalOutput();
  const context = commandContext(stdin, stderr);
  let chosen: GridSelection<T, A> | undefined;
  let failure: unknown;
  const consumer: PluginDefinition = {
    identity: { name: "surface" },
    load:
      () =>
      ({ command, registrations }) => {
        command((namespace) =>
          namespace.action(async () => {
            const [grid] = registrations<Grid>("grid");
            if (!grid)
              throw new Error("the grid capability was not registered");
            try {
              chosen = await grid.select(request);
            } catch (error) {
              failure = error;
            }
          }),
        );
      },
  };
  const running = main(
    ["surface"],
    [
      ...(options.plugins ?? [themePlugin, dialogsPlugin, gridPlugin]),
      consumer,
    ],
    context,
  );
  if (steps.length > 0) {
    await until(() => stdin.rawModes.includes(true));
    for (const step of steps) {
      if (typeof step === "string") stdin.write(step);
      else await step(stderr, context.stdoutText);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }
  const exitCode = await running;
  return {
    chosen,
    failure,
    stdin,
    stderr,
    stdout: context.stdoutText(),
    exitCode,
  };
}

/** The actions the rows of `fleet` offer, except the one that offers none. */
const actions = [
  { label: "connect", value: "connect" },
  { label: "open logs", value: "logs" },
] as const;

/** A grid whose rows identify themselves, with actions computed per row and
 * one row left with none — the shape a consumer writes. */
const fleet: GridSelectRequest<string, string> = {
  message: "Pick a service",
  headers: ["SERVICE", "STATE"],
  rows: [
    { cells: ["api", "running"], value: "api", actions: [...actions] },
    { cells: ["worker", "running"], value: "worker", actions: [...actions] },
    { cells: ["legacy", "retired"], value: "legacy", actions: [] },
  ],
};

/** The same grid with no actions declared anywhere, for the cases an action
 * would only be one more thing on screen for. */
const plainFleet: GridSelectRequest<string, string> = {
  message: "Pick a service",
  headers: ["SERVICE", "STATE"],
  rows: fleet.rows.map(({ cells, value }) => ({ cells, value })),
};

/** The options of the rows column, narrowed to the shape they are: rows are
 * cells rather than labels, which is settled once here so the assertions can
 * read the fields a cell option has. */
function rowOptions<T, A>(
  request: GridSelectRequest<T, A>,
): readonly CellOption<RowChoice>[] {
  return selectRequest(request).options as readonly CellOption<RowChoice>[];
}

describe("composing a grid request onto a select", () => {
  test("carries every row's cells as the option's own", () => {
    const request = selectRequest(plainFleet);

    expect(request.message).toBe("Pick a service");
    expect(request.headers).toEqual(["SERVICE", "STATE"]);
    expect(request.options).toEqual([
      { cells: ["api", "running"], value: { row: 0 } },
      { cells: ["worker", "running"], value: { row: 1 } },
      { cells: ["legacy", "retired"], value: { row: 2 } },
    ]);
  });

  test("drops a cell's declared role and alignment", () => {
    // A select takes an option's cells as display text, so there is nothing on
    // that side for either to be expressed against. Neither is smuggled
    // through as anything else: what reaches the dialog is a string.
    const request = selectRequest({
      message: "Pick one",
      rows: [
        {
          cells: [
            { text: "api", variable: "danger" },
            { text: "12", align: "end" },
          ],
          value: "api",
        },
      ],
    });

    expect(request.options).toEqual([
      { cells: ["api", "12"], value: { row: 0 } },
    ]);
  });

  test("pads a short row out to the column count rather than shortening it", () => {
    // A select column requires the same number of cells on every option, and
    // the grid — which already has a column-count rule — satisfies it rather
    // than passing a ragged set of rows through to be rejected.
    const short: GridSelectRequest<string, string> = {
      message: "Pick one",
      headers: ["ONE", "TWO", "THREE"],
      rows: [
        { cells: ["a", "b", "c"], value: "a" },
        { cells: ["d"], value: "d" },
      ],
    };

    expect(rowOptions(short).map((option) => option.cells)).toEqual([
      ["a", "b", "c"],
      ["d", "—", "—"],
    ]);
  });

  test("pads the headers out to the widest row", () => {
    const request = selectRequest({
      message: "Pick one",
      headers: ["ONE"],
      rows: [{ cells: ["a", "b"], value: "a" }],
    });

    expect(request.headers).toEqual(["ONE", ""]);
  });

  test("declares no headers where the request declares none", () => {
    // An empty list means the column declares none, exactly as omitting it
    // does — the same emptiness rule a row's actions follow.
    expect("headers" in selectRequest(plainFleet)).toBe(true);
    expect(
      "headers" in
        selectRequest({ message: "Pick one", rows: plainFleet.rows }),
    ).toBe(false);
    expect(
      "headers" in
        selectRequest({
          message: "Pick one",
          headers: [],
          rows: plainFleet.rows,
        }),
    ).toBe(false);
  });

  test("removes control characters from every string it hands over", () => {
    const injected: GridSelectRequest<string, string> = {
      message: `Pick${CLEAR_SCREEN} one`,
      headers: [`S\nERVICE`],
      rows: [
        {
          cells: ["a\rpi"],
          value: "api",
          actions: [{ label: `conn${CLEAR_SCREEN}ect`, value: "connect" }],
        },
      ],
    };
    const request = selectRequest(injected);
    const [option] = rowOptions(injected);

    expect(request.message).toBe("Pick[2J one");
    expect(request.headers).toEqual(["SERVICE"]);
    expect(option?.cells).toEqual(["api"]);
    expect(option?.dialog?.options).toEqual([
      { label: "conn[2Ject", value: { row: 0, action: 0 } },
    ]);
  });

  test("makes a row's actions the sub-dialog that row opens", () => {
    const [first, , third] = rowOptions(fleet);

    expect(first?.dialog).toEqual({
      // The actions column is titled by the row it belongs to, which is what
      // puts that row in the panel's trail beside the grid's own message.
      message: "api",
      options: [
        { label: "connect", value: { row: 0, action: 0 } },
        { label: "open logs", value: { row: 0, action: 1 } },
      ],
    });
    // An empty action list means the row declares none, exactly as omitting
    // one does: it opens nothing.
    expect(third !== undefined && "dialog" in third).toBe(false);
  });

  test("titles the actions of a row with no cells with the grid's message", () => {
    // A request whose rows carry no cells at all is rejected before it
    // renders — a column of options declaring no display text — so this title
    // is never drawn. The fallback is here so what the grid hands over is a
    // stated string rather than an undefined leaking into a request.
    const options = rowOptions({
      message: "Pick one",
      rows: [{ cells: [], value: "a", actions: [...actions] }],
    });

    expect(options[0]?.dialog?.message).toBe("Pick one");
  });
});

describe("mapping a chosen option back", () => {
  test("answers with the row alone where no action was chosen", () => {
    const chosen = selection(fleet, { row: 2 });

    expect(chosen).toEqual({ value: "legacy" });
    // An absent action means the chosen row offered none, so the key is absent
    // rather than present and undefined.
    expect("action" in chosen).toBe(false);
  });

  test("answers with both the row and the action it was chosen for", () => {
    // The mapping composing over a sub-dialog needs: a nested select resolves
    // with the completing option's value alone, so the value carried through
    // the actions column has to identify both.
    expect(selection(fleet, { row: 1, action: 1 })).toEqual({
      value: "worker",
      action: "logs",
    });
  });

  test("identifies a row by where it is rather than by what it carries", () => {
    // Nothing about a consumer's values has to be unique, comparable, or
    // hashable for the answer to come back whole: two rows carrying one value
    // are still two rows.
    const shared = { name: "api" };
    const request: GridSelectRequest<{ name: string }, string> = {
      message: "Pick one",
      rows: [
        { cells: ["one"], value: shared, actions: [...actions] },
        { cells: ["two"], value: shared, actions: [...actions] },
      ],
    };
    const chosen: RowChoice = { row: 1, action: 0 };

    expect(selection(request, chosen).value).toBe(shared);
    expect(selection(request, chosen).action).toBe("connect");
  });
});

describe("driving an interactive grid", () => {
  test("answers with the value the caller supplied for the chosen row", async () => {
    const { chosen, exitCode, failure } = await drive(plainFleet, [
      DOWN,
      CARRIAGE_RETURN,
    ]);

    expect(failure).toBeUndefined();
    expect(exitCode).toBe(0);
    expect(chosen).toEqual({ value: "worker" });
  });

  test("presents the rows as aligned cells under the headers naming them", async () => {
    const { stderr, chosen } = await drive(plainFleet, [CARRIAGE_RETURN]);
    const drawn = screen(stderr);

    expect(chosen).toEqual({ value: "api" });
    expect(drawn).toContain("Pick a service");
    expect(drawn).toContain("SERVICE");
    expect(drawn).toContain("STATE");
    expect(drawn).toContain("legacy");
  });

  test("carries both the row and the action through the actions column", async () => {
    const stderr = new TerminalOutput();

    const { chosen, exitCode } = await drive(
      fleet,
      [
        DOWN,
        shown(stderr, "worker"),
        RIGHT,
        shown(stderr, "open logs"),
        DOWN,
        CARRIAGE_RETURN,
      ],
      { stderr },
    );

    expect(exitCode).toBe(0);
    expect(chosen).toEqual({ value: "worker", action: "logs" });
  });

  test("resolves on the row alone where its computed actions are empty", async () => {
    const stderr = new TerminalOutput();

    const { chosen, failure } = await drive(
      fleet,
      [DOWN, DOWN, shown(stderr, "legacy"), CARRIAGE_RETURN],
      { stderr },
    );

    // Nothing was rejected, and the row offering none is taken by the very key
    // that opens the actions of the rows that do.
    expect(failure).toBeUndefined();
    expect(chosen).toEqual({ value: "legacy" });
    expect("action" in (chosen as object)).toBe(false);
  });

  test("drives the rows again when the reader backs out of the actions", async () => {
    const stderr = new TerminalOutput();

    const { chosen } = await drive(
      fleet,
      [
        DOWN,
        shown(stderr, "worker"),
        RIGHT,
        shown(stderr, "open logs"),
        LEFT,
        DOWN,
        shown(stderr, "legacy"),
        CARRIAGE_RETURN,
      ],
      { stderr },
    );

    // Backing out returned to the row list with its cursor where it was, so
    // one Down from there is the row after `worker` rather than the first.
    expect(chosen).toEqual({ value: "legacy" });
  });

  test("answers with nothing when the reader cancels", async () => {
    const { chosen, exitCode, stderr } = await drive(fleet, [ESCAPE]);

    // A cancelled selection resolves to nothing and assigns no exit code.
    expect(exitCode).toBe(0);
    expect(chosen).toBeUndefined();
    expect(screen(stderr)).toContain("Pick a service");
  });

  test("draws every cell as content whatever role it declared", async () => {
    const request: GridSelectRequest<string, string> = {
      message: "Pick a service",
      rows: [{ cells: [{ text: "api", variable: "danger" }], value: "api" }],
    };

    const { stderr, chosen } = await drive(request, [CARRIAGE_RETURN], {
      plugins: [
        themePlugin,
        hueing("danger", "red"),
        dialogsPlugin,
        gridPlugin,
      ],
    });

    expect(chosen).toEqual({ value: "api" });
    expect(stderr.text()).toContain("api");
    // The role was dropped rather than composed with the cursor bar, so the
    // hue the theme gives it never reaches the screen.
    expect(stderr.text()).not.toContain(RED);
  });

  test("lets no control character a cell carried reach the terminal", async () => {
    const stderr = new TerminalOutput();

    const { chosen } = await drive(
      {
        message: `Pick${CLEAR_SCREEN} a service`,
        headers: [`SERV${CLEAR_SCREEN}ICE`],
        rows: [
          {
            cells: [`a${CLEAR_SCREEN}pi`],
            value: "api",
            actions: [{ label: `conn${CLEAR_SCREEN}ect`, value: "connect" }],
          },
        ],
      },
      // What is on screen is the text the escape character was removed from,
      // so the row and the action are waited for and matched by that.
      [RIGHT, shown(stderr, "conn[2Ject"), CARRIAGE_RETURN],
      { stderr },
    );

    // Selecting is bound by the same rule printing is: the grid is where text
    // the consumer did not author enters tx, so nothing it hands the dialog
    // can reach the terminal as a command.
    expect(chosen).toEqual({ value: "api", action: "connect" });
    expect(stderr.text()).not.toContain(CLEAR_SCREEN);
    expect(screen(stderr)).toContain("a[2Jpi");
    expect(screen(stderr)).toContain("Pick[2J a service");
  });

  test("fills a row that stopped short out to the placeholder", async () => {
    const { stderr, chosen } = await drive(
      {
        message: "Pick a service",
        headers: ["SERVICE", "STATE"],
        rows: [
          { cells: ["api", "running"], value: "api" },
          { cells: ["worker"], value: "worker" },
        ],
      },
      [CARRIAGE_RETURN],
    );

    expect(chosen).toEqual({ value: "api" });
    expect(screen(stderr)).toContain("—");
  });
});

describe("what an interactive grid rejects", () => {
  test("rejects an absent interactive stream before rendering", async () => {
    const stdin = new TerminalInput(false);

    const { failure, chosen, stderr } = await drive(fleet, [], { stdin });

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "requires interactive input and error streams",
    );
    expect(chosen).toBeUndefined();
    // Rejected before any terminal state changed: nothing was drawn and the
    // terminal was never taken, so there is nothing to restore.
    expect(stderr.text()).toBe("");
    expect(stdin.rawModes).toEqual([]);
  });

  test("rejects a grid with no rows before rendering", async () => {
    const { failure, stderr, stdin } = await drive({
      message: "Pick a service",
      rows: [],
    });

    expect((failure as Error).message).toContain(
      "A select dialog requires at least one option",
    );
    expect(stderr.text()).toBe("");
    expect(stdin.rawModes).toEqual([]);
  });

  test("rejects rows that carry no cells at all before rendering", async () => {
    const { failure, stderr } = await drive({
      message: "Pick a service",
      rows: [{ cells: [], value: "api" }],
    });

    expect((failure as Error).message).toContain(
      "A select option requires either a label or cells",
    );
    expect(stderr.text()).toBe("");
  });

  test("fails when the dialogs capability is not composed exactly once", async () => {
    const { failure, stderr } = await drive(fleet, [], {
      plugins: [themePlugin, gridPlugin],
    });

    expect((failure as Error).message).toBe(
      "Expected exactly one dialogs capability, but found 0",
    );
    expect(stderr.text()).toBe("");
  });
});

describe("the terminal a settled selection hands over", () => {
  /** What every settled selection is held to, whichever way it settled: the
   * terminal out of raw mode, the handler the dialog installed gone, and
   * nothing written after it settled. A consumer starting a process the moment
   * this resolves is starting it against exactly this state. */
  async function expectRestored(
    stdin: TerminalInput,
    stderr: TerminalOutput,
  ): Promise<void> {
    expect(stdin.isRaw).toBe(false);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdin.listenerCount("error")).toBe(0);
    const settled = stderr.text();
    await new Promise<void>((resolve) =>
      setTimeout(resolve, animationInterval * 2),
    );
    expect(stderr.text()).toBe(settled);
  }

  test("is restored after a completed selection", async () => {
    const stderr = new TerminalOutput();

    const { chosen, stdin, stdout } = await drive(
      fleet,
      [RIGHT, shown(stderr, "connect"), CARRIAGE_RETURN],
      { stderr },
    );

    expect(chosen).toEqual({ value: "api", action: "connect" });
    // The dialog took the terminal and gave it back: raw mode was entered, and
    // the last thing done to it was leaving.
    expect(stdin.rawModes).toContain(true);
    expect(stdin.rawModes.at(-1)).toBe(false);
    await expectRestored(stdin, stderr);
    expect(stdout).toBe("");
  });

  test("is restored after a cancelled selection", async () => {
    const stderr = new TerminalOutput();

    const { chosen, stdin, stdout } = await drive(fleet, [ESCAPE], { stderr });

    expect(chosen).toBeUndefined();
    expect(stdin.rawModes.at(-1)).toBe(false);
    await expectRestored(stdin, stderr);
    expect(stdout).toBe("");
  });

  test("is restored after a failed selection", async () => {
    const stdin = new TerminalInput();
    stdin.failRawMode = true;
    const stderr = new TerminalOutput();

    const { failure, chosen, stdout } = await drive(fleet, [], {
      stdin,
      stderr,
    });

    // A consumer never has to repair a terminal it did not break, and a
    // failure is exactly when it would be least able to.
    expect(failure).toBeInstanceOf(Error);
    expect(chosen).toBeUndefined();
    await expectRestored(stdin, stderr);
    expect(stdout).toBe("");
  });

  test("leaves standard output untouched throughout a selection", async () => {
    const stderr = new TerminalOutput();
    let midSelection: string | undefined;

    const { stdout, chosen, stdin } = await drive(
      fleet,
      [
        RIGHT,
        shown(stderr, "connect"),
        (_stderr, stdoutText) => {
          midSelection = stdoutText();
        },
        CARRIAGE_RETURN,
      ],
      { stderr },
    );

    // Nothing of the grid's is on standard output at any point, so a
    // consumer's own output and a launched process's remain the only things on
    // it.
    expect(midSelection).toBe("");
    expect(stdout).toBe("");
    expect(stdin.rawModes).toContain(true);
    expect(chosen).toEqual({ value: "api", action: "connect" });
  });
});
