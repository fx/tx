import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { demoPlugin } from "../demo/index.ts";
import {
  type Dialogs,
  type InputRequest,
  order,
  type ScenarioName,
  type SelectRequest,
  type SelectResult,
  scenarios,
} from "../demo/scenarios.ts";
import { animationInterval } from "../plugins/dialogs/animation.ts";
import dialogsPlugin from "../plugins/dialogs/index.ts";
import { main } from "../src/cli.ts";
import type { CommandContext, PluginDefinition } from "../src/plugin.ts";
import { captureContext } from "./helpers.ts";

/** What the runner asked for, in the order it asked: the demo's whole
 * observable behavior besides what it prints. */
type Asked =
  | { readonly kind: "input"; readonly request: InputRequest }
  | { readonly kind: "select"; readonly request: SelectRequest<unknown> };

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

/** The demo run headless: the runner over injected streams, against whichever
 * dialogs provider the case is about. */
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

/** The line the runner prints for one answered scenario. */
function reported(name: ScenarioName, result: unknown): string {
  return `${name}: ${JSON.stringify(result)}\n`;
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
          call.kind === "input" ? "spring" : firstRow(call.request),
        ),
      ],
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(asked.map((call) => call.request)).toEqual(
      order.map((name) => scenarios[name].request),
    );
    expect(stdout).toBe(
      order
        .map((name, index) => {
          const call = asked[index] as Asked;
          return reported(
            name,
            call.kind === "input" ? "spring" : firstRow(call.request),
          );
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
          firstRow(call.request as SelectRequest<unknown>),
        ),
      ],
    );

    expect(exitCode).toBe(0);
    expect(asked).toEqual([
      {
        kind: "select",
        request: scenarios.leaf.request as SelectRequest<unknown>,
      },
    ]);
    expect(stdout).toBe(reported("leaf", { value: "stable", values: {} }));
  });

  test("reports a cancelled dialog as cancelled", async () => {
    const asked: Asked[] = [];

    const { exitCode, stdout } = await runDemo(
      ["demo", "input"],
      [stubDialogs(asked)],
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

  test("fails when nothing provides the dialogs capability", async () => {
    const { exitCode, stdout, stderr } = await runDemo(["demo"], []);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("dialogs capability missing");
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
      [dialogsPlugin, demoPlugin],
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
