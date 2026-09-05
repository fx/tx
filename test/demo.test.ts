import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { demoPlugin } from "../demo/index.ts";
import {
  type Dialogs,
  type Grid,
  type GridRequest,
  type GridSelection,
  type GridSelectRequest,
  type InputRequest,
  order,
  type PrintRequest,
  type ScenarioName,
  type SelectRequest,
  type SelectResult,
  scenarios,
} from "../demo/scenarios.ts";
import { animationInterval } from "../plugins/dialogs/animation.ts";
import dialogsPlugin from "../plugins/dialogs/index.ts";
import gridPlugin from "../plugins/grid/index.ts";
import themePlugin from "../plugins/theme/index.ts";
import { main } from "../src/cli.ts";
import type { CommandContext, PluginDefinition } from "../src/plugin.ts";
import { captureContext } from "./helpers.ts";

/** What the runner asked for, in the order it asked: the demo's whole
 * observable behavior besides what it prints. */
type Asked =
  | { readonly kind: "input"; readonly request: InputRequest }
  | { readonly kind: "select"; readonly request: SelectRequest<unknown> }
  | { readonly kind: "grid"; readonly request: PrintRequest }
  | {
      readonly kind: "rows";
      readonly request: GridSelectRequest<string, string>;
    };

/**
 * A dialogs provider that answers without rendering. It stands in for the
 * bundled one wherever the subject is the runner — which scenario it presents,
 * in which order, and what it prints — rather than what a dialog looks like on
 * screen, so those assertions neither need a terminal nor wait for one.
 */
function stubDialogs(
  asked: Asked[],
  answer: (request: Asked) => unknown = () => undefined,
): PluginDefinition {
  return {
    identity: { name: "dialogs" },
    load:
      () =>
      ({ register }) => {
        register<Dialogs>("dialogs", {
          async input(request) {
            const call = { kind: "input", request } as const;
            asked.push(call);
            return answer(call) as string | undefined;
          },
          async select<T>(request: SelectRequest<T>) {
            const call = {
              kind: "select",
              request: request as SelectRequest<unknown>,
            } as const;
            asked.push(call);
            return answer(call) as SelectResult<T> | undefined;
          },
        });
      },
  };
}

/**
 * A grid provider that records what it was asked to print without drawing
 * anything, so the assertions about the runner — which scenario it presents,
 * in which order, and what it prints — neither need a canvas nor measure one.
 */
function stubGrid(asked: Asked[]): PluginDefinition {
  return {
    identity: { name: "grid" },
    load:
      () =>
      ({ register }) => {
        register<Grid>("grid", {
          print({ stream: _stream, ...request }: GridRequest) {
            asked.push({ kind: "grid", request });
          },
          async select<T, A>(request: GridSelectRequest<T, A>) {
            asked.push({
              kind: "rows",
              request: request as unknown as GridSelectRequest<string, string>,
            });
            const [first] = request.rows;
            if (!first) throw new Error("an interactive grid with no rows");
            return { value: first.value } as GridSelection<T, A>;
          },
        });
      },
  };
}

/** The demo run headless: the runner over injected streams, against whichever
 * providers the case is about. */
async function runDemo(
  argv: readonly string[],
  providers: readonly PluginDefinition[],
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const context = captureContext();
  const exitCode = await main(argv, [...providers, demoPlugin], context);
  return {
    exitCode,
    stdout: context.stdoutText(),
    stderr: context.stderrText(),
  };
}

/** The line the runner prints for one answered scenario. A printed grid gets
 * none: the grid is the output. */
function reported(name: ScenarioName, result: unknown): string {
  return `${name}: ${JSON.stringify(result)}\n`;
}

/** Every styling sequence removed, so an assertion about a printed grid is
 * about the columns rather than about the theme. The pattern is built rather
 * than written as a literal: a control character in a regular expression is
 * unreadable, and the linter rejects one. */
const stylingSequence = new RegExp(
  `${String.fromCharCode(0x1b)}\\[[0-9;]*m`,
  "gu",
);

function unstyled(output: string): string {
  return output.replace(stylingSequence, "");
}

/** The answer a select resolves with when the person takes the first row. */
function firstRow(request: SelectRequest<unknown>): SelectResult<unknown> {
  const [first] = request.options;
  if (!first) throw new Error("a select with no options");
  return { value: first.value, values: {} };
}

describe("the demo runner", () => {
  test("presents every scenario in order when given none", async () => {
    const asked: Asked[] = [];

    const { exitCode, stdout, stderr } = await runDemo(
      ["demo"],
      [
        stubDialogs(asked, (call) =>
          call.kind === "select" ? firstRow(call.request) : "spring",
        ),
        stubGrid(asked),
      ],
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(asked.map((call) => call.request)).toEqual(
      order.map((name) => scenarios[name].request),
    );
    expect(stdout).toBe(
      order
        .map((name) => {
          const scenario = scenarios[name];
          if (scenario.kind === "grid") return "";
          if (scenario.kind === "input") return reported(name, "spring");
          if (scenario.kind === "rows") {
            return reported(name, { value: scenario.request.rows[0]?.value });
          }
          return reported(name, firstRow(scenario.request));
        })
        .join(""),
    );
  });

  test("presents only the scenario it is given", async () => {
    const asked: Asked[] = [];

    const { exitCode, stdout } = await runDemo(
      ["demo", "leaf"],
      [
        stubDialogs(asked, (call) =>
          call.kind === "select" ? firstRow(call.request) : undefined,
        ),
        stubGrid(asked),
      ],
    );

    expect(exitCode).toBe(0);
    expect(asked).toEqual([
      { kind: "select", request: scenarios.leaf.request },
    ]);
    expect(stdout).toBe(reported("leaf", { value: "stable", values: {} }));
  });

  test("reports a cancelled dialog as cancelled", async () => {
    const asked: Asked[] = [];

    const { exitCode, stdout } = await runDemo(
      ["demo", "input"],
      [stubDialogs(asked), stubGrid(asked)],
    );

    expect(exitCode).toBe(0);
    expect(stdout).toBe("input: cancelled\n");
  });

  test("rejects a scenario it does not carry", async () => {
    const asked: Asked[] = [];

    const { exitCode, stdout, stderr } = await runDemo(
      ["demo", "nope"],
      [stubDialogs(asked)],
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain('unknown scenario: "nope"');
    expect(stderr).toContain(`one of: ${order.join(", ")}`);
    expect(asked).toEqual([]);
  });

  test("prints a grid instead of reporting an answer", async () => {
    const asked: Asked[] = [];

    const { exitCode, stdout } = await runDemo(
      ["demo", "grid"],
      [stubDialogs(asked), themePlugin, gridPlugin],
    );

    expect(exitCode).toBe(0);
    expect(asked).toEqual([]);
    expect(stdout).not.toContain("grid:");
    // The real grid, so the demo is showing what a consumer would get: a
    // header row, columns aligned to one width, and a summary beneath.
    expect(unstyled(stdout).split("\n").slice(0, 2)).toEqual([
      "PACKAGE         STATUS   TESTS",
      "core            ready      128",
    ]);
    expect(stdout).toContain("5 packages");
  });

  test("fails when nothing provides the dialogs capability", async () => {
    const { exitCode, stdout, stderr } = await runDemo(["demo"], []);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("dialogs capability missing");
  });

  test("fails when nothing provides the grid capability", async () => {
    const asked: Asked[] = [];

    const { exitCode, stdout, stderr } = await runDemo(
      ["demo"],
      [stubDialogs(asked)],
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("grid capability missing");
  });
});

/** A terminal's input side: a stream the renderer can put into raw mode and
 * a test can script keystrokes into. */
class TerminalInput extends PassThrough {
  readonly isTTY = true;
  readonly rawModes: boolean[] = [];
  isRaw = false;
  private referenced = false;

  hasRef(): boolean {
    return this.referenced;
  }

  setRawMode(enabled: boolean): this {
    this.rawModes.push(enabled);
    this.isRaw = enabled;
    return this;
  }

  ref(): this {
    this.referenced = true;
    return this;
  }

  unref(): this {
    this.referenced = false;
    return this;
  }
}

/** A terminal's output side, of a fixed size, keeping everything written to
 * it so a test can read what was on screen. */
class TerminalOutput extends PassThrough {
  readonly isTTY = true;
  readonly columns = 80;
  readonly rows = 24;
  private written = "";

  constructor() {
    super();
    this.on("data", (chunk) => {
      this.written += chunk.toString();
    });
  }

  text(): string {
    return this.written;
  }
}

/** Every control sequence the renderer writes around a frame, so a test that
 * matches on what the reader sees can ignore them. Built from the escape
 * character rather than written literally, so the source carries no control
 * character. */
const CONTROL_SEQUENCE = new RegExp(
  `${String.fromCharCode(27)}\\[[\\d;?]*[a-zA-Z]`,
  "g",
);

/**
 * How long a wait for the dialog to take the terminal is given. Deliberately
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
      throw new Error("timed out waiting for the dialog to open");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

describe("the demo on a terminal", () => {
  test("renders the scenario it is given and prints the answer", async () => {
    const stdin = new TerminalInput();
    const stderr = new TerminalOutput();
    const stdout = new TerminalOutput();
    const context: CommandContext = {
      cwd: "/work",
      env: {},
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      plugin: { name: "demo" },
    };

    const running = main(
      ["demo", "select"],
      [themePlugin, dialogsPlugin, gridPlugin, demoPlugin],
      context,
    );
    await until(() => stdin.rawModes.includes(true));
    stdin.write("\r");
    const exitCode = await running;

    expect(exitCode).toBe(0);
    expect(stderr.text()).toContain("Pick a bump");
    expect(stdout.text()).toBe(
      `select: ${JSON.stringify({ value: "patch", values: {} })}\n`,
    );
  });

  /** The table scenario driven through the real plugin, which is the only
   * place the catalogue meets the validations: a column of cells with headers
   * is either accepted and drawn as a table, or rejected before it renders. */
  test("draws the table scenario under the headers naming its fields", async () => {
    const stdin = new TerminalInput();
    const stderr = new TerminalOutput();
    const stdout = new TerminalOutput();
    const context: CommandContext = {
      cwd: "/work",
      env: {},
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      plugin: { name: "demo" },
    };

    const running = main(
      ["demo", "cells"],
      [themePlugin, dialogsPlugin, gridPlugin, demoPlugin],
      context,
    );
    await until(() => stdin.rawModes.includes(true));
    stdin.write("\r");
    const exitCode = await running;

    expect(exitCode).toBe(0);
    const screen = stderr.text().replace(CONTROL_SEQUENCE, "");
    expect(screen).toContain("Pick a release");
    expect(screen).toContain("Version");
    expect(screen).toContain("Published");
    expect(stdout.text()).toBe(
      `cells: ${JSON.stringify({ value: "1.6.1", values: {} })}\n`,
    );
  });
});

describe("the demo entry point", () => {
  test("does not run the demo on import", () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        'Bun.argv.slice = () => { throw new Error("demo invoked during import"); }; await import("./demo/index.ts");',
      ],
      { cwd: `${import.meta.dir}/..` },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  });

  test("runs from the package script", () => {
    const result = Bun.spawnSync([process.execPath, "run", "demo", "--help"], {
      cwd: `${import.meta.dir}/..`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Usage: tx demo");
    for (const name of order) {
      expect(result.stdout.toString()).toContain(name);
    }
  });
});
