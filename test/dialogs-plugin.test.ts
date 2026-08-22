import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import dialogsPlugin from "../plugins/dialogs/index.ts";
import { main } from "../src/cli.ts";
import type { CommandContext, PluginDefinition } from "../src/plugin.ts";

type SelectOption<T> = {
  readonly label: string;
  readonly value: T;
};

type Dialogs = {
  select<T>(request: {
    readonly message: string;
    readonly options: readonly SelectOption<T>[];
  }): Promise<T | undefined>;
};

class TerminalInput extends PassThrough {
  readonly rawModes: boolean[] = [];
  refs = 0;
  unrefs = 0;
  failRawMode = false;
  failRawModeDisable = false;
  failRawModeDisableOnce = false;
  failUnref = false;
  failUnrefOnce = false;

  constructor(readonly isTTY = true) {
    super();
  }

  setRawMode(enabled: boolean): this {
    this.rawModes.push(enabled);
    if (enabled && this.failRawMode) throw new Error("raw mode failed");
    if (!enabled && (this.failRawModeDisable || this.failRawModeDisableOnce)) {
      this.failRawModeDisableOnce = false;
      throw new Error("raw mode cleanup failed");
    }
    return this;
  }

  ref(): this {
    this.refs++;
    return this;
  }

  unref(): this {
    this.unrefs++;
    if (this.failUnref || this.failUnrefOnce) {
      this.failUnrefOnce = false;
      throw new Error("unref cleanup failed");
    }
    return this;
  }
}

class CapturedOutput extends PassThrough {
  readonly columns = 80;
  readonly rows = 24;
  private output = "";

  constructor(readonly isTTY = true) {
    super();
    this.on("data", (chunk) => {
      this.output += chunk.toString();
    });
  }

  text(): string {
    return this.output;
  }
}

class ThrowingOutput extends CapturedOutput {
  failWrites = false;

  override write(
    chunk: unknown,
    callback?: (error: Error | null | undefined) => void,
  ): boolean;
  override write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback?: (error: Error | null | undefined) => void,
  ): boolean;
  override write(
    chunk: unknown,
    encodingOrCallback?:
      | BufferEncoding
      | ((error: Error | null | undefined) => void),
    callback?: (error: Error | null | undefined) => void,
  ): boolean {
    if (this.failWrites) throw new Error("output cleanup failed");
    if (typeof encodingOrCallback === "function") {
      return super.write(chunk, encodingOrCallback);
    }
    if (encodingOrCallback === undefined) return super.write(chunk);
    return callback
      ? super.write(chunk, encodingOrCallback, callback)
      : super.write(chunk, encodingOrCallback);
  }
}

type TestContext = CommandContext & {
  stdoutText(): string;
};

function context(stdin: TerminalInput, stderr: CapturedOutput): TestContext {
  const stdout = new CapturedOutput();
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

function consumer(
  action: (dialogs: Dialogs, commandContext: CommandContext) => Promise<void>,
): PluginDefinition {
  return {
    identity: { name: "choose" },
    load:
      () =>
      ({ command, context: commandContext, registrations }) => {
        command((namespace) =>
          namespace.action(async () => {
            const [dialogs] = registrations<Dialogs>("dialogs");
            if (!dialogs) throw new Error("dialogs capability missing");
            await action(dialogs, commandContext);
          }),
        );
      },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for dialog state");
}

async function runSelection<T>(
  options: readonly SelectOption<T>[],
  input: string | readonly string[],
): Promise<{
  readonly value: T | undefined;
  readonly stdin: TerminalInput;
  readonly stderr: CapturedOutput;
  readonly stdout: string;
  readonly exitCode: number;
}> {
  const stdin = new TerminalInput();
  const stderr = new CapturedOutput();
  const commandContext = context(stdin, stderr);
  const stdoutText = commandContext.stdoutText;
  let value: T | undefined;
  const running = main(
    ["choose"],
    [
      dialogsPlugin,
      consumer(async (dialogs) => {
        value = await dialogs.select({ message: "Pick one", options });
      }),
    ],
    commandContext,
  );
  await until(() => stdin.rawModes.includes(true));
  for (const chunk of typeof input === "string" ? [input] : input) {
    stdin.write(chunk);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  const exitCode = await running;
  return { value, stdin, stderr, stdout: stdoutText(), exitCode };
}

async function runRejected<T>(
  options: readonly SelectOption<T>[],
  stdin = new TerminalInput(),
  stderr = new CapturedOutput(),
): Promise<{
  readonly exitCode: number;
  readonly failure: unknown;
  readonly stdin: TerminalInput;
  readonly stderr: CapturedOutput;
}> {
  let failure: unknown;
  const exitCode = await main(
    ["choose"],
    [
      dialogsPlugin,
      consumer(async (dialogs) => {
        try {
          await dialogs.select({ message: "Failure", options });
        } catch (error) {
          failure = error;
        }
      }),
    ],
    context(stdin, stderr),
  );
  return { exitCode, failure, stdin, stderr };
}

describe("bundled dialogs provider", () => {
  test("registers one namespace-free capability without changing root help", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    const commandContext = context(stdin, stderr);
    let registrations: readonly Dialogs[] = [];
    const inspector: PluginDefinition = {
      identity: { name: "inspector" },
      load:
        () =>
        ({ command, registrations: read }) => {
          command((namespace) =>
            namespace.action(() => {
              registrations = read<Dialogs>("dialogs");
            }),
          );
        },
    };

    expect(
      await main(["inspector"], [dialogsPlugin, inspector], commandContext),
    ).toBe(0);
    expect(registrations).toHaveLength(1);
    expect(Object.keys(registrations[0] ?? {})).toEqual(["select"]);

    const helpContext = context(new TerminalInput(), new CapturedOutput());
    const helpText = helpContext.stdoutText;
    expect(await main(["--help"], [dialogsPlugin], helpContext)).toBe(0);
    expect(helpText()).not.toContain("dialogs");
  });

  test("renders on stderr, keeps stdout clean, and selects the first exact value", async () => {
    const value = { id: 1 };
    const result = await runSelection(
      [
        { label: "Alpha", value },
        { label: "Beta", value: { id: 2 } },
        { label: "Gamma", value: { id: 3 } },
      ],
      "\r",
    );

    expect(result.exitCode).toBe(0);
    expect(result.value).toBe(value);
    expect(result.stdout).toBe("");
    const output = result.stderr.text();
    expect(output).toContain("Pick one");
    expect(output).toContain("> Alpha");
    expect(output.indexOf("Alpha")).toBeLessThan(output.indexOf("Beta"));
    expect(output.indexOf("Beta")).toBeLessThan(output.indexOf("Gamma"));
  });

  test("clamps navigation, ignores unrelated input, and preserves duplicate order", async () => {
    const first = new Error("same");
    const second = new Error("same");
    const result = await runSelection(
      [
        { label: "Duplicate", value: first },
        { label: "Duplicate", value: second },
        { label: "Last", value: first },
      ],
      ["x", "[A", "[B", "[B", "[B", "[A", "\r"],
    );

    expect(result.value).toBe(second);
    const output = result.stderr.text();
    expect(output.indexOf("Duplicate")).toBeLessThan(
      output.lastIndexOf("Duplicate"),
    );
    expect(output).toContain("Last");
  });

  test("applies coalesced navigation before selection", async () => {
    const result = await runSelection(
      [
        { label: "First", value: 1 },
        { label: "Second", value: 2 },
      ],
      "[B\r",
    );

    expect(result.value).toBe(2);
  });

  test("returns an Error option by identity instead of treating it as failure", async () => {
    const selected = new Error("selected value");
    const result = await runSelection(
      [{ label: "Error", value: selected }],
      "\r",
    );
    expect(result.exitCode).toBe(0);
    expect(result.value).toBe(selected);
  });

  test.each([
    ["Escape", ""],
    ["Ctrl-C", ""],
  ])("cancels with %s and lets the command continue", async (_label, input) => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    const commandContext = context(stdin, stderr);
    const stdoutText = commandContext.stdoutText;
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs, currentContext) => {
          expect(
            await dialogs.select({
              message: "Cancel",
              options: [{ label: "Only", value: 1 }],
            }),
          ).toBeUndefined();
          currentContext.stdout.write("continued\n");
        }),
      ],
      commandContext,
    );
    await until(() => stdin.rawModes.includes(true));
    stdin.write(input);

    expect(await running).toBe(0);
    expect(stdoutText()).toBe("continued\n");
    expect(process.exitCode).not.toBe(1);
  });

  test("rejects empty and non-TTY requests before rendering or terminal changes", async () => {
    for (const [options, stdin, stderr] of [
      [[], new TerminalInput(), new CapturedOutput()],
      [
        [{ label: "One", value: 1 }],
        new TerminalInput(false),
        new CapturedOutput(),
      ],
      [
        [{ label: "One", value: 1 }],
        new TerminalInput(),
        new CapturedOutput(false),
      ],
    ] as const) {
      const result = await runRejected(options, stdin, stderr);
      expect(result.exitCode).toBe(0);
      expect(result.failure).toBeInstanceOf(Error);
      expect(result.stderr.text()).toBe("");
      expect(result.stdin.rawModes).toEqual([]);
    }
  });

  test("rejects render and interaction failures without exiting", async () => {
    for (const kind of ["render", "interaction"] as const) {
      const stdin = new TerminalInput();
      const stderr = new CapturedOutput();
      if (kind === "interaction") stdin.failRawMode = true;
      const option: SelectOption<number> =
        kind === "render"
          ? (Object.defineProperty({ value: 1 }, "label", {
              get() {
                throw new Error("render failed");
              },
            }) as SelectOption<number>)
          : { label: "One", value: 1 };
      const result = await runRejected([option], stdin, stderr);
      expect(result.exitCode).toBe(0);
      expect(result.failure).toBeInstanceOf(Error);
      expect((result.failure as Error).message).toContain(
        kind === "render" ? "render failed" : "raw mode failed",
      );
      if (kind === "interaction") {
        expect(result.stdin.refs).toBe(1);
        expect(result.stdin.unrefs).toBe(1);
        expect(result.stdin.rawModes).toEqual([true, false]);
        expect(result.stdin.listenerCount("readable")).toBe(0);
      }
      expect(process.exitCode).not.toBe(1);
    }
  });

  test("does not retain beforeExit listeners after repeated initial render failures", async () => {
    const beforeExitListeners = process.listenerCount("beforeExit");
    const option = Object.defineProperty({ value: 1 }, "label", {
      get() {
        throw new Error("render failed");
      },
    }) as SelectOption<number>;

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runRejected([option]);
      expect(result.failure).toBeInstanceOf(Error);
      expect(process.listenerCount("beforeExit")).toBe(beforeExitListeners);
    }
  });

  test("rejects renderer unmount failure without retaining its listener", async () => {
    const beforeExitListeners = process.listenerCount("beforeExit");
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let writableStateFailures = 0;
    Object.defineProperty(stderr, "writableEnded", {
      configurable: true,
      get() {
        if (writableStateFailures > 0) {
          writableStateFailures--;
          throw new Error("renderer unmount failed");
        }
        return false;
      },
    });
    let failure: unknown;
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          try {
            await dialogs.select({
              message: "Unmount",
              options: [{ label: "One", value: 1 }],
            });
          } catch (error) {
            failure = error;
          }
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stdin.rawModes.includes(true));
    writableStateFailures = 1;
    stdin.write("\r");

    expect(await running).toBe(0);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("renderer unmount failed");
    expect(stdin.refs).toBe(stdin.unrefs);
    expect(stdin.listenerCount("readable")).toBe(0);
    expect(process.listenerCount("beforeExit")).toBe(beforeExitListeners);
  });

  test("rejects synchronous terminal teardown failures after cleanup", async () => {
    for (const kind of [
      "raw mode",
      "raw mode persistent",
      "output",
      "unref once",
      "unref persistent",
    ] as const) {
      const stdin = new TerminalInput();
      const stderr =
        kind === "output" ? new ThrowingOutput() : new CapturedOutput();
      if (kind === "raw mode") stdin.failRawModeDisableOnce = true;
      if (kind === "raw mode persistent") stdin.failRawModeDisable = true;
      if (kind === "unref once") stdin.failUnrefOnce = true;
      if (kind === "unref persistent") stdin.failUnref = true;
      let failure: unknown;
      const running = main(
        ["choose"],
        [
          dialogsPlugin,
          consumer(async (dialogs) => {
            try {
              await dialogs.select({
                message: "Teardown",
                options: [{ label: "One", value: 1 }],
              });
            } catch (error) {
              failure = error;
            }
          }),
        ],
        context(stdin, stderr),
      );
      await until(() => stdin.rawModes.includes(true));
      if (stderr instanceof ThrowingOutput) stderr.failWrites = true;
      stdin.write("\r");

      expect(await running).toBe(0);
      expect({ kind, failure }).toEqual({ kind, failure: expect.any(Error) });
      expect((failure as Error).message).toContain(
        kind.startsWith("raw mode")
          ? "raw mode cleanup failed"
          : kind === "output"
            ? "output cleanup failed"
            : "unref cleanup failed",
      );
      if (kind.startsWith("raw mode") || kind === "output") {
        expect(stdin.refs).toBe(stdin.unrefs);
      } else {
        expect(stdin.unrefs).toBeGreaterThanOrEqual(stdin.refs);
      }
      expect(stdin.listenerCount("readable")).toBe(0);
    }
  });

  test("restores raw mode, listeners, refs, and flushed output before settling", async () => {
    const result = await runSelection(
      [
        { label: "One", value: 1 },
        { label: "Two", value: 2 },
      ],
      ["[B", "\r"],
    );

    expect(result.value).toBe(2);
    expect(result.stdin.rawModes).toEqual([true, false]);
    expect(result.stdin.refs).toBe(1);
    expect(result.stdin.unrefs).toBe(1);
    expect(result.stdin.listenerCount("readable")).toBe(0);
    expect(result.stderr.text()).toContain("> Two");
  });

  test("supports sequential reuse without retaining process or input listeners", async () => {
    const beforeExitListeners = process.listenerCount("beforeExit");
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    const commandContext = context(stdin, stderr);
    const values: (number | undefined)[] = [];
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          values.push(
            await dialogs.select({
              message: "First",
              options: [{ label: "One", value: 1 }],
            }),
          );
          values.push(
            await dialogs.select({
              message: "Second",
              options: [{ label: "Two", value: 2 }],
            }),
          );
        }),
      ],
      commandContext,
    );
    await until(() => stdin.rawModes.length === 1);
    stdin.write("\r");
    await until(() => stdin.rawModes.length === 3);
    stdin.write("\r");

    expect(await running).toBe(0);
    expect(values).toEqual([1, 2]);
    expect(stdin.rawModes).toEqual([true, false, true, false]);
    expect(stdin.listenerCount("readable")).toBe(0);
    expect(process.listenerCount("beforeExit")).toBe(beforeExitListeners);
  });
});
