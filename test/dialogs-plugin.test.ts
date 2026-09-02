import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import dialogsPlugin from "../plugins/dialogs/index.ts";
import { main } from "../src/cli.ts";
import type {
  CommandContext,
  CoreDependencies,
  PluginDefinition,
} from "../src/plugin.ts";
import { coreDependencies } from "../src/plugins.ts";

type TextField = {
  readonly type: "text";
  readonly name: string;
  readonly message: string;
  readonly initialValue?: string;
};

type SelectOption<T> = {
  readonly label: string;
  readonly value: T;
  readonly fields?: readonly TextField[];
};

type SelectResult<T> = {
  readonly value: T;
  readonly values: Readonly<Record<string, string>>;
};

type InputRequest = {
  readonly message: string;
  readonly initialValue?: string;
};

type Dialogs = {
  input(request: InputRequest): Promise<string | undefined>;
  select<T>(request: {
    readonly message: string;
    readonly options: readonly SelectOption<T>[];
    readonly filter?: boolean | "auto";
  }): Promise<SelectResult<T> | undefined>;
};

const ESCAPE = String.fromCharCode(27);
const BACKSPACE = String.fromCharCode(127);
const CTRL_A = String.fromCharCode(1);
const CTRL_C = String.fromCharCode(3);
const CARRIAGE_RETURN = "\r";
const NEXT_LINE = String.fromCharCode(0x85);
const GRINNING_FACE = String.fromCodePoint(0x1f600);

class TerminalInput extends PassThrough {
  readonly rawModes: boolean[] = [];
  refs = 0;
  unrefs = 0;
  activeReferences = 0;
  failRawMode = false;
  failRawModeDisable = false;
  failRawModeDisableOnce = false;
  failUnref = false;
  failUnrefOnce = false;
  isRaw: boolean;
  referenced: boolean;

  constructor(
    readonly isTTY = true,
    initialRaw = false,
    initialReferenced = false,
  ) {
    super();
    this.isRaw = initialRaw;
    this.referenced = initialReferenced;
  }

  hasRef(): boolean {
    return this.referenced;
  }

  setRawMode(enabled: boolean): this {
    this.rawModes.push(enabled);
    if (enabled && this.failRawMode) throw new Error("raw mode failed");
    if (!enabled && (this.failRawModeDisable || this.failRawModeDisableOnce)) {
      this.failRawModeDisableOnce = false;
      throw new Error("raw mode cleanup failed");
    }
    this.isRaw = enabled;
    return this;
  }

  ref(): this {
    this.refs++;
    this.activeReferences++;
    this.referenced = true;
    return this;
  }

  unref(): this {
    this.unrefs++;
    if (this.failUnref || this.failUnrefOnce) {
      this.failUnrefOnce = false;
      throw new Error("unref cleanup failed");
    }
    this.activeReferences = Math.max(0, this.activeReferences - 1);
    this.referenced = false;
    return this;
  }
}

class CapturedOutput extends PassThrough {
  columns = 80;
  rows = 24;
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

class AsyncFailingOutput extends CapturedOutput {
  failure: "callback" | "event" | undefined;

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.failure === "callback") {
      this.failure = undefined;
      queueMicrotask(() => callback(new Error("async output callback failed")));
      return;
    }
    if (this.failure === "event") {
      this.failure = undefined;
      queueMicrotask(() => {
        this.emit("error", new Error("async output event failed"));
        callback();
      });
      return;
    }
    super._transform(chunk, encoding, callback);
  }
}

class BlockingOutput extends CapturedOutput {
  blockNext = false;
  blocked = false;
  #release: (() => void) | undefined;

  release(): void {
    this.#release?.();
    this.#release = undefined;
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.blockNext) {
      super._transform(chunk, encoding, callback);
      return;
    }
    this.blockNext = false;
    this.blocked = true;
    this.#release = () => super._transform(chunk, encoding, callback);
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

/** The message every `runSelection` dialog carries, and so the row every one of
 * its frames opens with. */
const SELECT_MESSAGE = "Pick one";

/** Ink rewrites its whole output on every render, and every select frame opens
 * with the request message, so the text from that message's last occurrence
 * onward is the frame the dialog left on screen. */
function lastFrame(stderr: CapturedOutput): string {
  const output = stderr.text();
  const start = output.lastIndexOf(SELECT_MESSAGE);
  expect(start).toBeGreaterThanOrEqual(0);
  return output.slice(start);
}

/** The escape sequences Ink writes around a frame, so a row count can ignore
 * them. Built from the escape character rather than written literally, so the
 * source carries no control character. */
const CONTROL_SEQUENCE = new RegExp(`${ESCAPE}\\[[\\d;?]*[a-zA-Z]`, "g");

/** The rows of the frame the dialog left on screen, so a test can count them
 * against the terminal's height. */
function frameRows(stderr: CapturedOutput): readonly string[] {
  const rows = lastFrame(stderr).replace(CONTROL_SEQUENCE, "").split("\n");
  while (rows.at(-1) === "") rows.pop();
  return rows;
}

/** A terminal double of a chosen height, for the dialogs whose behavior depends
 * on how many rows they have to work with. */
function terminalOfRows(rows: number): CapturedOutput {
  const stderr = new CapturedOutput();
  stderr.rows = rows;
  return stderr;
}

/** One step a running dialog takes: a chunk written to its input, or something
 * done to the terminal it renders on — a resize, or reading the frame that is
 * on screen while the dialog is still open. */
type SelectionStep =
  | string
  | ((stderr: CapturedOutput) => void | Promise<void>);

async function runSelection<T>(
  options: readonly SelectOption<T>[],
  input: string | readonly SelectionStep[],
  filter?: boolean | "auto",
  stderr: CapturedOutput = new CapturedOutput(),
): Promise<{
  readonly value: T | undefined;
  readonly values: Readonly<Record<string, string>> | undefined;
  readonly stdin: TerminalInput;
  readonly stderr: CapturedOutput;
  readonly stdout: string;
  readonly exitCode: number;
}> {
  const stdin = new TerminalInput();
  const commandContext = context(stdin, stderr);
  const stdoutText = commandContext.stdoutText;
  let result: SelectResult<T> | undefined;
  const running = main(
    ["choose"],
    [
      dialogsPlugin,
      consumer(async (dialogs) => {
        result = await dialogs.select({
          message: SELECT_MESSAGE,
          options,
          ...(filter === undefined ? {} : { filter }),
        });
      }),
    ],
    commandContext,
  );
  await until(() => stdin.rawModes.includes(true));
  for (const step of typeof input === "string" ? [input] : input) {
    if (typeof step === "string") stdin.write(step);
    else await step(stderr);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  const exitCode = await running;
  return {
    value: result?.value,
    values: result?.values,
    stdin,
    stderr,
    stdout: stdoutText(),
    exitCode,
  };
}

async function runEntry(
  request: InputRequest,
  input: readonly string[],
  stdin = new TerminalInput(),
  stderr = new CapturedOutput(),
): Promise<{
  readonly value: string | undefined;
  readonly failure: unknown;
  readonly stdin: TerminalInput;
  readonly stderr: CapturedOutput;
  readonly stdout: string;
  readonly exitCode: number;
}> {
  const commandContext = context(stdin, stderr);
  const stdoutText = commandContext.stdoutText;
  let value: string | undefined;
  let failure: unknown;
  const running = main(
    ["choose"],
    [
      dialogsPlugin,
      consumer(async (dialogs) => {
        try {
          value = await dialogs.input(request);
        } catch (error) {
          failure = error;
        }
      }),
    ],
    commandContext,
  );
  if (input.length > 0) {
    await until(() => stdin.rawModes.includes(true));
    for (const chunk of input) {
      stdin.write(chunk);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }
  const exitCode = await running;
  return { value, failure, stdin, stderr, stdout: stdoutText(), exitCode };
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
    expect(Object.isFrozen(dialogsPlugin)).toBe(true);
    expect(Object.isFrozen(dialogsPlugin.identity)).toBe(true);
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
    expect(Object.keys(registrations[0] ?? {})).toEqual(["input", "select"]);

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
    expect(result.values).toEqual({});
    expect(result.stdout).toBe("");
    const output = result.stderr.text();
    expect(output).toContain(SELECT_MESSAGE);
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
      if (kind === "interaction") {
        stdin.failRawMode = true;
        stdin.failUnrefOnce = true;
      }
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
        expect(result.stdin.unrefs).toBe(2);
        expect(result.stdin.activeReferences).toBe(0);
        expect(result.stdin.rawModes).toEqual([true, false]);
        expect(result.stdin.listenerCount("readable")).toBe(0);
      }
      expect(process.exitCode).not.toBe(1);
    }
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

  test("captures asynchronous output callback and error-event failures", async () => {
    for (const kind of ["callback", "event"] as const) {
      const stdin = new TerminalInput();
      const stderr = new AsyncFailingOutput();
      let failure: unknown;
      const running = main(
        ["choose"],
        [
          dialogsPlugin,
          consumer(async (dialogs) => {
            try {
              await dialogs.select({
                message: "Async output",
                options: [
                  { label: "One", value: 1 },
                  { label: "Two", value: 2 },
                ],
              });
            } catch (error) {
              failure = error;
            }
          }),
        ],
        context(stdin, stderr),
      );
      await until(() => stdin.rawModes.includes(true));
      stderr.failure = kind;
      stdin.write("[B");

      expect(await running).toBe(0);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        kind === "callback"
          ? "async output callback failed"
          : "async output event failed",
      );
      expect(stdin.activeReferences).toBe(0);
      expect(stdin.listenerCount("readable")).toBe(0);
    }
  });

  test("preserves undefined and null primary failures over cleanup failures", async () => {
    for (const reason of [undefined, null] as const) {
      const stdin = new TerminalInput();
      const stderr = new CapturedOutput();
      let caught:
        | { readonly present: true; readonly reason: unknown }
        | undefined;
      const running = main(
        ["choose"],
        [
          dialogsPlugin,
          consumer(async (dialogs) => {
            try {
              await dialogs.select({
                message: "Sentinel",
                options: [{ label: "One", value: 1 }],
              });
            } catch (error) {
              caught = { present: true, reason: error };
            }
          }),
        ],
        context(stdin, stderr),
      );
      await until(() => stdin.rawModes.includes(true));
      stdin.failRawModeDisableOnce = true;
      stdin.emit("error", reason);

      expect(await running).toBe(0);
      expect(caught).toEqual({ present: true, reason });
      expect(stdin.activeReferences).toBe(0);
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

  test("supports sequential reuse without retaining input listeners", async () => {
    const stdin = new TerminalInput();
    const unrelatedReadable = () => {};
    stdin.on("readable", unrelatedReadable);
    const stderr = new CapturedOutput();
    const commandContext = context(stdin, stderr);
    const values: (number | undefined)[] = [];
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          values.push(
            (
              await dialogs.select({
                message: "First",
                options: [{ label: "One", value: 1 }],
              })
            )?.value,
          );
          values.push(
            (
              await dialogs.select({
                message: "Second",
                options: [{ label: "Two", value: 2 }],
              })
            )?.value,
          );
        }),
      ],
      commandContext,
    );
    await until(() => stdin.rawModes.length === 1);
    stdin.emit("data", Buffer.from("\r"));
    await until(() => stdin.rawModes.length === 3);
    stdin.emit("data", Buffer.from("\r"));

    expect(await running).toBe(0);
    expect(values).toEqual([1, 2]);
    expect(stdin.rawModes).toEqual([true, false, true, false]);
    expect(stdin.activeReferences).toBe(0);
    expect(stdin.listeners("readable")).toContain(unrelatedReadable);
    stdin.removeListener("readable", unrelatedReadable);
    expect(stdin.listenerCount("readable")).toBe(0);
  });

  test("restores paused input and preserves preexisting raw and referenced state", async () => {
    const stdin = new TerminalInput(true, true, true);
    stdin.pause();
    const stderr = new CapturedOutput();
    let value: number | undefined;
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          value = (
            await dialogs.select({
              message: "Preserve source",
              options: [{ label: "One", value: 1 }],
            })
          )?.value;
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stderr.text().includes("One"));
    stdin.write("\r");

    expect(await running).toBe(0);
    expect(value).toBe(1);
    expect(stdin.readableFlowing).toBe(false);
    expect(stdin.isRaw).toBe(true);
    expect(stdin.referenced).toBe(true);
    expect(stdin.refs).toBe(0);
    expect(stdin.unrefs).toBe(0);
  });

  test("releases every successfully owned input reference", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    const ink: CoreDependencies["ink"] = {
      ...coreDependencies.ink,
      render(...args: Parameters<CoreDependencies["ink"]["render"]>) {
        const options = args[1] as { readonly stdin: NodeJS.ReadStream };
        for (let reference = 0; reference < 5; reference++) {
          options.stdin.ref();
        }
        return coreDependencies.ink.render(...args);
      },
    };
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          await dialogs.select({
            message: "Many references",
            options: [{ label: "One", value: 1 }],
          });
        }),
      ],
      context(stdin, stderr),
      { ...coreDependencies, ink },
    );
    await until(() => stderr.text().includes("One"));
    stdin.write("");

    expect(await running).toBe(0);
    expect(stdin.refs).toBeGreaterThan(3);
    expect(stdin.unrefs).toBe(stdin.refs);
    expect(stdin.activeReferences).toBe(0);
  });

  test("forwards TTY dimensions and resize events to Ink", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let initial: readonly [
      boolean | undefined,
      number | undefined,
      number | undefined,
    ] = [] as never;
    let resized: readonly [number | undefined, number | undefined] | undefined;
    const ink: CoreDependencies["ink"] = {
      ...coreDependencies.ink,
      render(...args: Parameters<CoreDependencies["ink"]["render"]>) {
        const options = args[1] as { readonly stdout: NodeJS.WriteStream };
        const output = options.stdout;
        initial = [output.isTTY, output.columns, output.rows];
        const onResize = () => {
          resized = [output.columns, output.rows];
        };
        output.on("resize", onResize);
        const renderer = coreDependencies.ink.render(...args);
        return {
          ...renderer,
          unmount() {
            output.removeListener("resize", onResize);
            renderer.unmount();
          },
        };
      },
    };
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          await dialogs.select({
            message: "Resize",
            options: [{ label: "One", value: 1 }],
          });
        }),
      ],
      context(stdin, stderr),
      { ...coreDependencies, ink },
    );
    await until(() => stderr.text().includes("One"));
    stderr.columns = 120;
    stderr.rows = 40;
    stderr.emit("resize");
    stdin.write("");

    expect(await running).toBe(0);
    expect(initial).toEqual([true, 80, 24]);
    expect(resized).toEqual([120, 40]);
  });

  test("stops forwarding input while renderer exit is pending", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    const release = Promise.withResolvers<void>();
    const ink: CoreDependencies["ink"] = {
      ...coreDependencies.ink,
      render(...args: Parameters<CoreDependencies["ink"]["render"]>) {
        const renderer = coreDependencies.ink.render(...args);
        return {
          ...renderer,
          waitUntilExit() {
            return renderer.waitUntilExit().then(() => release.promise);
          },
        };
      },
    };
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          await dialogs.select({
            message: "Pending exit",
            options: [{ label: "One", value: 1 }],
          });
        }),
      ],
      context(stdin, stderr),
      { ...coreDependencies, ink },
    );
    await until(() => stderr.text().includes("One"));
    stdin.write("\r");
    await until(() => stdin.rawModes.includes(false));

    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdin.listenerCount("error")).toBe(0);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    release.resolve();
    expect(await running).toBe(0);
  });

  test("waits for interrupted renderer teardown and its output barrier", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    const releaseBarrier = Promise.withResolvers<void>();
    let failure: unknown;
    let unmountCalls = 0;
    let barrierReached = false;
    const ink: CoreDependencies["ink"] = {
      ...coreDependencies.ink,
      render(...args: Parameters<CoreDependencies["ink"]["render"]>) {
        const renderer = coreDependencies.ink.render(...args);
        return {
          ...renderer,
          unmount() {
            unmountCalls++;
            if (unmountCalls === 1) {
              throw new Error("renderer unmount interrupted");
            }
            renderer.unmount();
          },
          waitUntilExit() {
            return renderer.waitUntilExit().then(async (result) => {
              await releaseBarrier.promise;
              barrierReached = true;
              return result;
            });
          },
        };
      },
    };
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          try {
            await dialogs.select({
              message: "Unmount failure",
              options: [{ label: "One", value: 1 }],
            });
          } catch (error) {
            failure = error;
          }
        }),
      ],
      context(stdin, stderr),
      { ...coreDependencies, ink },
    );
    await until(() => stderr.text().includes("One"));
    stdin.emit("error", new Error("dialog failed"));
    await until(() => unmountCalls === 2);

    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(barrierReached).toBe(false);
    releaseBarrier.resolve();

    expect(await running).toBe(0);
    expect(barrierReached).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("dialog failed");
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.activeReferences).toBe(0);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdin.listenerCount("error")).toBe(0);
  });

  test("rejects after finite retries when renderer unmount persistently throws", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let failure: unknown;
    let unmountCalls = 0;
    let actualRenderer:
      | ReturnType<CoreDependencies["ink"]["render"]>
      | undefined;
    const ink: CoreDependencies["ink"] = {
      ...coreDependencies.ink,
      render(...args: Parameters<CoreDependencies["ink"]["render"]>) {
        const renderer = coreDependencies.ink.render(...args);
        actualRenderer = renderer;
        return {
          ...renderer,
          unmount() {
            unmountCalls++;
            throw new Error(`persistent renderer failure ${unmountCalls}`);
          },
        };
      },
    };
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          try {
            await dialogs.select({
              message: "Persistent unmount failure",
              options: [{ label: "One", value: 1 }],
            });
          } catch (error) {
            failure = error;
          }
        }),
      ],
      context(stdin, stderr),
      { ...coreDependencies, ink },
    );
    await until(() => stderr.text().includes("One"));
    stdin.write("");

    const timeout = Symbol("timeout");
    const result = await Promise.race([
      running,
      new Promise<typeof timeout>((resolve) =>
        setTimeout(() => resolve(timeout), 100),
      ),
    ]);
    expect(result).toBe(0);
    expect(unmountCalls).toBe(2);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("persistent renderer failure 1");
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdin.listenerCount("error")).toBe(0);

    if (!actualRenderer) throw new Error("renderer was not created");
    actualRenderer.unmount();
    await actualRenderer.waitUntilExit();
  });

  test("waits for pending output when renderer unmount persistently throws", async () => {
    const stdin = new TerminalInput();
    const stderr = new BlockingOutput();
    let failure: unknown;
    let unmountCalls = 0;
    let actualRenderer:
      | ReturnType<CoreDependencies["ink"]["render"]>
      | undefined;
    const ink: CoreDependencies["ink"] = {
      ...coreDependencies.ink,
      render(...args: Parameters<CoreDependencies["ink"]["render"]>) {
        const renderer = coreDependencies.ink.render(...args);
        actualRenderer = renderer;
        return {
          ...renderer,
          unmount() {
            unmountCalls++;
            throw new Error(`persistent renderer failure ${unmountCalls}`);
          },
        };
      },
    };
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          try {
            await dialogs.select({
              message: "Pending output",
              options: [
                { label: "One", value: 1 },
                { label: "Two", value: 2 },
              ],
            });
          } catch (error) {
            failure = error;
          }
        }),
      ],
      context(stdin, stderr),
      { ...coreDependencies, ink },
    );
    await until(() => stderr.text().includes("Two"));
    stderr.blockNext = true;
    stdin.write("[B");
    await until(() => stderr.blocked);
    stdin.write("");
    await until(() => unmountCalls === 2);

    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    stderr.release();

    expect(await running).toBe(0);
    expect((failure as Error).message).toBe("persistent renderer failure 1");
    if (!actualRenderer) throw new Error("renderer was not created");
    actualRenderer.unmount();
    await actualRenderer.waitUntilExit();
  });

  test("preserves terminal cleanup failure over a later unmount wrapper failure", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let failure: unknown;
    let unmountCalls = 0;
    const ink: CoreDependencies["ink"] = {
      ...coreDependencies.ink,
      render(...args: Parameters<CoreDependencies["ink"]["render"]>) {
        const renderer = coreDependencies.ink.render(...args);
        return {
          ...renderer,
          unmount() {
            unmountCalls++;
            renderer.unmount();
            throw new Error(`wrapper failure ${unmountCalls}`);
          },
        };
      },
    };
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          try {
            await dialogs.select({
              message: "Cleanup precedence",
              options: [{ label: "One", value: 1 }],
            });
          } catch (error) {
            failure = error;
          }
        }),
      ],
      context(stdin, stderr),
      { ...coreDependencies, ink },
    );
    await until(() => stderr.text().includes("One"));
    stdin.failRawModeDisable = true;
    stdin.write("");

    expect(await running).toBe(0);
    expect(unmountCalls).toBe(2);
    expect((failure as Error).message).toBe("raw mode cleanup failed");
  });
});

describe("select filter", () => {
  const DOWN = `${ESCAPE}[B`;
  const UP = `${ESCAPE}[A`;

  function named(
    ...labels: readonly string[]
  ): readonly SelectOption<string>[] {
    return labels.map((label) => ({ label, value: label.toLowerCase() }));
  }

  const eight = named(
    "Alpha",
    "Beta",
    "Gamma",
    "Alphabet",
    "Delta",
    "Epsilon",
    "Zeta",
    "Eta",
  );
  const nine = [...eight, { label: "Theta", value: "theta" }];

  test("turns itself on above eight options and narrows to the terms typed", async () => {
    const result = await runSelection(nine, ["alp", CARRIAGE_RETURN]);

    expect(result.value).toBe("alpha");
    expect(result.values).toEqual({});
    const frame = lastFrame(result.stderr);
    expect(frame).toContain("› alp");
    expect(frame).toContain("> Alpha");
    expect(frame).toContain("  Alphabet");
    expect(frame.indexOf("> Alpha")).toBeLessThan(frame.indexOf("Alphabet"));
    expect(frame).not.toContain("Beta");
    expect(frame).not.toContain("Gamma");
  });

  test("stays off at eight options, leaving typed text ignored", async () => {
    const result = await runSelection(eight, ["alp", CARRIAGE_RETURN]);

    expect(result.value).toBe("alpha");
    const frame = lastFrame(result.stderr);
    expect(frame).not.toContain("›");
    expect(frame).toContain("> Alpha");
    expect(frame).toContain("  Gamma");
  });

  test("honours an explicit setting whatever the option count", async () => {
    const enabled = await runSelection(
      named("Alpha", "Beta", "Gamma"),
      ["bet", CARRIAGE_RETURN],
      true,
    );
    expect(enabled.value).toBe("beta");
    const enabledFrame = lastFrame(enabled.stderr);
    expect(enabledFrame).toContain("› bet");
    expect(enabledFrame).toContain("> Beta");
    expect(enabledFrame).not.toContain("Alpha");

    const disabled = await runSelection(nine, ["alp", CARRIAGE_RETURN], false);
    expect(disabled.value).toBe("alpha");
    const disabledFrame = lastFrame(disabled.stderr);
    expect(disabledFrame).not.toContain("›");
    expect(disabledFrame).toContain("  Gamma");
  });

  test("requires every term, in any order, against the label alone", async () => {
    const branches: readonly SelectOption<string>[] = [
      { label: "release branch", value: "release" },
      { label: "branch archive", value: "archive" },
      { label: "main", value: "main" },
    ];
    const result = await runSelection(
      branches,
      ["branch rel", CARRIAGE_RETURN],
      true,
    );

    expect(result.value).toBe("release");
    const frame = lastFrame(result.stderr);
    expect(frame).toContain("> release branch");
    expect(frame).not.toContain("branch archive");
    expect(frame).not.toContain("main");
  });

  test("widens again on Backspace and ignores one on empty text", async () => {
    const narrowed = await runSelection(
      named("Alpha", "Beta", "Gamma"),
      ["gam", CARRIAGE_RETURN],
      true,
    );
    expect(narrowed.value).toBe("gamma");
    expect(lastFrame(narrowed.stderr)).not.toContain("Alpha");

    const widened = await runSelection(
      named("Alpha", "Beta", "Gamma"),
      [BACKSPACE, "gam", BACKSPACE, BACKSPACE, BACKSPACE, CARRIAGE_RETURN],
      true,
    );
    expect(widened.value).toBe("alpha");
    const frame = lastFrame(widened.stderr);
    expect(frame).toContain("> Alpha");
    expect(frame).toContain("  Beta");
    expect(frame).toContain("  Gamma");
  });

  test("keeps a user-provided option reachable when nothing else matches", async () => {
    const result = await runSelection(
      [
        { label: "Alpha", value: "alpha" },
        { label: "Beta", value: "beta" },
        {
          label: "Other…",
          value: "other",
          fields: [{ type: "text", name: "branch", message: "Branch name" }],
        },
      ],
      ["zzz", CARRIAGE_RETURN, "release", CARRIAGE_RETURN],
      true,
    );

    expect(result.value).toBe("other");
    expect(result.values).toEqual({ branch: "release" });
    const frame = lastFrame(result.stderr);
    expect(frame).toContain("› zzz");
    expect(frame).toContain("> Other…");
    expect(frame).not.toContain("Alpha");
    expect(frame).not.toContain("Beta");
  });

  test("shows no match, refuses Enter and navigation, and stays cancellable", async () => {
    const cancelled = await runSelection(
      named("Alpha", "Beta", "Gamma"),
      ["zzz", CARRIAGE_RETURN, ESCAPE],
      true,
    );
    expect(cancelled.value).toBeUndefined();
    const frame = lastFrame(cancelled.stderr);
    expect(frame).toContain("› zzz");
    expect(frame).toContain("no match");
    expect(frame).not.toContain("Alpha");

    const recovered = await runSelection(
      named("Alpha", "Beta", "Gamma"),
      [
        "zzz",
        DOWN,
        UP,
        CARRIAGE_RETURN,
        BACKSPACE,
        BACKSPACE,
        BACKSPACE,
        CARRIAGE_RETURN,
      ],
      true,
    );
    expect(recovered.value).toBe("alpha");
    expect(lastFrame(recovered.stderr)).not.toContain("no match");
  });

  test("navigates the visible list and clamps at its last entry", async () => {
    const result = await runSelection(
      named("Alpha", "Beta", "Alpaca", "Gamma", "Alpine"),
      ["alp", DOWN, DOWN, DOWN, CARRIAGE_RETURN],
      true,
    );

    expect(result.value).toBe("alpine");
    const frame = lastFrame(result.stderr);
    expect(frame).toContain("  Alpha");
    expect(frame).toContain("  Alpaca");
    expect(frame).toContain("> Alpine");
    expect(frame).not.toContain("Beta");
    expect(frame).not.toContain("Gamma");
  });

  test("makes the first visible option active whenever the text changes", async () => {
    const result = await runSelection(
      named("Alpha", "Beta", "Alpaca"),
      [DOWN, DOWN, "alp", CARRIAGE_RETURN],
      true,
    );

    expect(result.value).toBe("alpha");
  });

  test.each([
    ["Escape", ESCAPE],
    ["Ctrl-C", CTRL_C],
  ])(
    "cancels with %s while the filter text is not empty",
    async (_l, chunk) => {
      const result = await runSelection(
        named("Alpha", "Beta", "Gamma"),
        ["alp", chunk],
        true,
      );

      expect(result.exitCode).toBe(0);
      expect(result.value).toBeUndefined();
      expect(lastFrame(result.stderr)).toContain("› alp");
    },
  );

  test("stops accepting filter edits once field collection begins", async () => {
    const result = await runSelection(
      [
        { label: "Known", value: "known" },
        {
          label: "Custom",
          value: "custom",
          fields: [{ type: "text", name: "branch", message: "Branch name" }],
        },
      ],
      ["cus", CARRIAGE_RETURN, "abcd", BACKSPACE, CARRIAGE_RETURN],
      true,
    );

    expect(result.value).toBe("custom");
    expect(result.values).toEqual({ branch: "abc" });
    const frame = lastFrame(result.stderr);
    expect(frame).toContain("› cus");
    expect(frame).not.toContain("cusabc");
    expect(frame).not.toContain("Known");
  });
});

describe("select viewport and extended navigation", () => {
  const DOWN = `${ESCAPE}[B`;
  const HOME = `${ESCAPE}[H`;
  const END = `${ESCAPE}[F`;
  const PAGE_UP = `${ESCAPE}[5~`;
  const PAGE_DOWN = `${ESCAPE}[6~`;

  /** Labels are numbered from `01`, so no label is a substring of another and
   * an assertion that one row is absent means it. */
  function listed(count: number): readonly SelectOption<number>[] {
    return Array.from({ length: count }, (_, index) => ({
      label: `Option ${String(index + 1).padStart(2, "0")}`,
      value: index + 1,
    }));
  }

  /** Thirty options of which the fifteen odd positions carry `Alpha`, so a
   * filter leaves a list still longer than the window. */
  const mixed: readonly SelectOption<number>[] = Array.from(
    { length: 30 },
    (_, index) => ({
      label: `${index % 2 === 0 ? "Beta" : "Alpha"} ${String(index).padStart(2, "0")}`,
      value: index,
    }),
  );

  const shortTerminalFrame = [SELECT_MESSAGE, "›", "> Option 01", "▼ 29 more"];

  const repeated = (chunk: string, times: number): readonly string[] =>
    Array.from({ length: times }, () => chunk);

  test("opens at the top and counts the options hidden below", async () => {
    const result = await runSelection(
      listed(30),
      [CARRIAGE_RETURN],
      undefined,
      terminalOfRows(40),
    );

    expect(result.value).toBe(1);
    const frame = lastFrame(result.stderr);
    expect(frame).toContain("> Option 01");
    expect(frame).toContain("  Option 10");
    expect(frame).not.toContain("Option 11");
    expect(frame).toContain("▼ 20 more");
    expect(frame).not.toContain("▲");
  });

  test("follows the active option and counts both sides", async () => {
    const result = await runSelection(
      listed(30),
      [...repeated(DOWN, 10), CARRIAGE_RETURN],
      undefined,
      terminalOfRows(40),
    );

    expect(result.value).toBe(11);
    const frame = lastFrame(result.stderr);
    expect(frame).toContain("▲ 1 more");
    expect(frame).toContain("  Option 02");
    expect(frame).toContain("> Option 11");
    expect(frame).toContain("▼ 19 more");
    expect(frame).not.toContain("Option 01");
    expect(frame).not.toContain("Option 12");
  });

  test("shrinks in a short terminal and stays shorter than it", async () => {
    const result = await runSelection(
      listed(30),
      [CARRIAGE_RETURN],
      undefined,
      terminalOfRows(8),
    );

    expect(result.value).toBe(1);
    expect(frameRows(result.stderr)).toEqual(shortTerminalFrame);
    expect(frameRows(result.stderr).length).toBeLessThan(8);
  });

  test("re-derives the window after the terminal is resized", async () => {
    const result = await runSelection(
      listed(30),
      [
        (stderr) => {
          stderr.rows = 8;
          stderr.emit("resize");
        },
        CARRIAGE_RETURN,
      ],
      undefined,
      terminalOfRows(40),
    );

    expect(result.value).toBe(1);
    expect(frameRows(result.stderr)).toEqual(shortTerminalFrame);
  });

  test("jumps to the last and the first visible option", async () => {
    const end = await runSelection(
      listed(30),
      [END, CARRIAGE_RETURN],
      undefined,
      terminalOfRows(40),
    );
    expect(end.value).toBe(30);
    const endFrame = lastFrame(end.stderr);
    expect(endFrame).toContain("▲ 20 more");
    expect(endFrame).toContain("> Option 30");
    expect(endFrame).not.toContain("▼");

    const home = await runSelection(
      listed(30),
      [END, HOME, CARRIAGE_RETURN],
      undefined,
      terminalOfRows(40),
    );
    expect(home.value).toBe(1);
    expect(lastFrame(home.stderr)).toContain("> Option 01");
  });

  test("pages by the window's height and clamps at either end", async () => {
    const back = await runSelection(
      listed(30),
      [END, PAGE_UP, CARRIAGE_RETURN],
      undefined,
      terminalOfRows(40),
    );
    expect(back.value).toBe(20);

    const top = await runSelection(
      listed(30),
      [...repeated(PAGE_UP, 2), CARRIAGE_RETURN],
      undefined,
      terminalOfRows(40),
    );
    expect(top.value).toBe(1);

    const bottom = await runSelection(
      listed(30),
      [...repeated(PAGE_DOWN, 4), CARRIAGE_RETURN],
      undefined,
      terminalOfRows(40),
    );
    expect(bottom.value).toBe(30);
  });

  test("pages by the shrunken window in a short terminal", async () => {
    const result = await runSelection(
      listed(30),
      [PAGE_DOWN, CARRIAGE_RETURN],
      undefined,
      terminalOfRows(12),
    );

    expect(result.value).toBe(6);
  });

  test("leaves room for a collected field in a short terminal", async () => {
    let collecting: readonly string[] = [];
    const result = await runSelection(
      [
        ...listed(29),
        {
          label: "Other…",
          value: 0,
          fields: [{ type: "text", name: "branch", message: "Branch name" }],
        },
      ],
      [
        END,
        CARRIAGE_RETURN,
        "abc",
        async (stderr) => {
          // Ink batches its writes, so the frame carrying the entered text is
          // not on screen the instant the chunk is written.
          await until(() => stderr.text().includes("abc"));
          collecting = frameRows(stderr);
        },
        CARRIAGE_RETURN,
      ],
      undefined,
      terminalOfRows(8),
    );

    expect(result.value).toBe(0);
    expect(result.values).toEqual({ branch: "abc" });
    expect(collecting).toEqual([
      SELECT_MESSAGE,
      "›",
      "▲ 29 more",
      "> Other…",
      "Branch name",
      "abc",
    ]);
    expect(collecting.length).toBeLessThan(8);
  });

  test("windows the filtered list rather than the supplied one", async () => {
    const result = await runSelection(
      mixed,
      ["alpha", END, CARRIAGE_RETURN],
      undefined,
      terminalOfRows(40),
    );

    expect(result.value).toBe(29);
    const frame = lastFrame(result.stderr);
    expect(frame).toContain("› alpha");
    expect(frame).toContain("▲ 5 more");
    expect(frame).toContain("  Alpha 11");
    expect(frame).toContain("> Alpha 29");
    expect(frame).not.toContain("Alpha 09");
    expect(frame).not.toContain("▼");
    expect(frame).not.toContain("Beta");
  });
});

describe("bundled text input dialog", () => {
  test("renders the message and initial value on stderr and keeps stdout clean", async () => {
    const result = await runEntry({ message: "Branch", initialValue: "main" }, [
      "-next",
      CARRIAGE_RETURN,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.value).toBe("main-next");
    expect(result.stdout).toBe("");
    const output = result.stderr.text();
    expect(output).toContain("Branch");
    expect(output).toContain("main");
    expect(output).toContain("main-next");
  });

  test("starts empty and appends typed characters in order", async () => {
    const result = await runEntry({ message: "Name" }, [
      "r",
      "e",
      "l",
      CARRIAGE_RETURN,
    ]);

    expect(result.value).toBe("rel");
    expect(result.stderr.text()).toContain("rel");
  });

  test("appends a multi-character chunk whole and drops the control characters it carries", async () => {
    const result = await runEntry({ message: "Paste" }, [
      "hello world!",
      `ab${CARRIAGE_RETURN}cd`,
      `ef${NEXT_LINE}gh`,
      CARRIAGE_RETURN,
    ]);

    expect(result.value).toBe("hello world!abcdefgh");
  });

  test("removes the last character on Backspace and does nothing when the value is empty", async () => {
    const result = await runEntry({ message: "Branch", initialValue: "main" }, [
      BACKSPACE,
      BACKSPACE,
      BACKSPACE,
      BACKSPACE,
      BACKSPACE,
      "dev",
      CARRIAGE_RETURN,
    ]);

    expect(result.value).toBe("dev");
    expect(result.stderr.text()).toContain("dev");

    const empty = await runEntry({ message: "Branch" }, [
      BACKSPACE,
      CARRIAGE_RETURN,
    ]);
    expect(empty.value).toBe("");
  });

  test("removes a whole non-BMP character on Backspace", async () => {
    const result = await runEntry({ message: "Emoji" }, [
      `a${GRINNING_FACE}`,
      BACKSPACE,
      CARRIAGE_RETURN,
    ]);

    expect(result.value).toBe("a");
  });

  test("leaves the value unchanged for navigation, tab, control, and meta input", async () => {
    const result = await runEntry({ message: "Ignore" }, [
      "ok",
      `${ESCAPE}[A`,
      `${ESCAPE}[B`,
      "\t",
      CTRL_A,
      `${ESCAPE}x`,
      CARRIAGE_RETURN,
    ]);

    expect(result.value).toBe("ok");
  });

  test("leaves the value unchanged for an escape sequence Ink does not resolve to a key", async () => {
    const result = await runEntry({ message: "Unresolved" }, [
      "ok",
      `${ESCAPE}[25~`,
      `${ESCAPE}[I`,
      `${ESCAPE}[12;3H`,
      CARRIAGE_RETURN,
    ]);

    expect(result.value).toBe("ok");
  });

  test("keeps Enter, Escape, and Backspace meaning the same under a modifier", async () => {
    const submitted = await runEntry({ message: "Alt" }, [
      "ok",
      `${ESCAPE}${CARRIAGE_RETURN}`,
    ]);
    expect(submitted.value).toBe("ok");

    const cancelled = await runEntry({ message: "Twice" }, [
      "ok",
      `${ESCAPE}${ESCAPE}`,
    ]);
    expect(cancelled.value).toBeUndefined();

    const deleted = await runEntry({ message: "Alt backspace" }, [
      "ok",
      `${ESCAPE}${BACKSPACE}`,
      CARRIAGE_RETURN,
    ]);
    expect(deleted.value).toBe("o");
  });

  test.each([
    ["Enter", CARRIAGE_RETURN, ""],
    ["Escape", ESCAPE, undefined],
    ["Ctrl-C", CTRL_C, undefined],
  ])(
    "distinguishes an empty submission from cancellation with %s",
    async (_label, chunk, expected) => {
      const result = await runEntry({ message: "Empty" }, [chunk]);

      expect(result.exitCode).toBe(0);
      expect(result.value).toBe(expected);
      expect(result.failure).toBeUndefined();
      expect(process.exitCode).not.toBe(1);
    },
  );

  test("rejects a non-interactive request before rendering or terminal changes", async () => {
    for (const [stdin, stderr] of [
      [new TerminalInput(false), new CapturedOutput()],
      [new TerminalInput(), new CapturedOutput(false)],
    ] as const) {
      const result = await runEntry(
        { message: "Redirected" },
        [],
        stdin,
        stderr,
      );
      expect(result.exitCode).toBe(0);
      expect(result.value).toBeUndefined();
      expect(result.failure).toBeInstanceOf(Error);
      expect((result.failure as Error).message).toBe(
        "An input dialog requires interactive input and error streams",
      );
      expect(result.stderr.text()).toBe("");
      expect(result.stdin.rawModes).toEqual([]);
    }
  });

  test("rejects a rendering failure without exiting", async () => {
    const message = { unrenderable: true } as unknown as string;
    const result = await runEntry({ message }, []);

    expect(result.exitCode).toBe(0);
    expect(result.value).toBeUndefined();
    expect(result.failure).toBeInstanceOf(Error);
    expect((result.failure as Error).message).toContain("React child");
    expect(result.stdin.listenerCount("data")).toBe(0);
    expect(process.exitCode).not.toBe(1);
  });

  test("rejects an interaction failure without exiting", async () => {
    const stdin = new TerminalInput();
    stdin.failRawMode = true;
    const result = await runEntry({ message: "Raw mode" }, [], stdin);

    expect(result.exitCode).toBe(0);
    expect(result.value).toBeUndefined();
    expect((result.failure as Error).message).toContain("raw mode failed");
    expect(process.exitCode).not.toBe(1);
  });

  test("restores raw mode, references, and listeners before settling", async () => {
    const result = await runEntry({ message: "Cleanup" }, [
      "value",
      CARRIAGE_RETURN,
    ]);

    expect(result.value).toBe("value");
    expect(result.stdin.rawModes).toEqual([true, false]);
    expect(result.stdin.refs).toBe(result.stdin.unrefs);
    expect(result.stdin.activeReferences).toBe(0);
    expect(result.stdin.listenerCount("data")).toBe(0);
    expect(result.stdin.listenerCount("error")).toBe(0);
  });

  test("rejects a terminal teardown failure after cleanup", async () => {
    const stdin = new TerminalInput();
    stdin.failRawModeDisable = true;
    const result = await runEntry(
      { message: "Teardown" },
      ["x", CARRIAGE_RETURN],
      stdin,
    );

    expect(result.exitCode).toBe(0);
    expect((result.failure as Error).message).toBe("raw mode cleanup failed");
    expect(result.stdin.listenerCount("data")).toBe(0);
  });
});

describe("user-provided select options", () => {
  const branch: TextField = {
    type: "text",
    name: "branch",
    message: "Branch name",
  };
  // Messages deliberately share no text with their names, so a result keyed by
  // the displayed message instead of the field name cannot pass.
  const owner: TextField = {
    type: "text",
    name: "owner",
    message: "Which account?",
  };
  const repository: TextField = {
    type: "text",
    name: "repository",
    message: "Which project?",
  };

  function mixed(): readonly SelectOption<string>[] {
    return [
      { label: "Known", value: "known" },
      { label: "Custom", value: "custom", fields: [branch] },
    ];
  }

  test("tells a plain option apart from a user-provided one by its collected values", async () => {
    const plain = await runSelection(mixed(), [CARRIAGE_RETURN]);
    expect(plain.value).toBe("known");
    expect(plain.values).toEqual({});

    const provided = await runSelection(mixed(), [
      `${ESCAPE}[B`,
      CARRIAGE_RETURN,
      "release",
      CARRIAGE_RETURN,
    ]);
    expect(provided.value).toBe("custom");
    expect(provided.values).toEqual({ branch: "release" });
    const output = provided.stderr.text();
    expect(output).toContain("Branch name");
    expect(output).toContain("release");
    expect(provided.stdout).toBe("");
  });

  test("prompts each field only after the previous one is submitted", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let result: SelectResult<string> | undefined;
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          result = await dialogs.select({
            message: "Pick one",
            options: [
              {
                label: "Custom",
                value: "custom",
                fields: [owner, repository],
              },
            ],
          });
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stderr.text().includes("Custom"));
    expect(stderr.text()).not.toContain(owner.message);
    stdin.write(CARRIAGE_RETURN);
    await until(() => stderr.text().includes(owner.message));
    expect(stderr.text()).not.toContain(repository.message);
    stdin.write("fx");
    await until(() => stderr.text().includes("fx"));
    stdin.write(CARRIAGE_RETURN);
    await until(() => stderr.text().includes(repository.message));
    stdin.write("tx");
    await until(() => stderr.text().includes("tx"));
    stdin.write(CARRIAGE_RETURN);

    expect(await running).toBe(0);
    expect(result).toEqual({
      value: "custom",
      values: { owner: "fx", repository: "tx" },
    });
  });

  test("starts every collected field from its own initial value", async () => {
    const accepted = await runSelection(
      [
        {
          label: "Custom",
          value: "custom",
          fields: [
            { ...owner, initialValue: "fx" },
            { ...repository, initialValue: "tx" },
          ],
        },
      ],
      [CARRIAGE_RETURN, CARRIAGE_RETURN, CARRIAGE_RETURN],
    );
    expect(accepted.values).toEqual({ owner: "fx", repository: "tx" });

    const edited = await runSelection(
      [
        {
          label: "Custom",
          value: "custom",
          fields: [{ ...branch, initialValue: "origin" }],
        },
      ],
      [CARRIAGE_RETURN, BACKSPACE, "-2", CARRIAGE_RETURN],
    );
    expect(edited.values).toEqual({ branch: "origi-2" });
    expect(edited.stderr.text()).toContain("origi-2");
  });

  test("refuses option navigation once field collection has begun", async () => {
    const result = await runSelection(
      [
        { label: "Custom", value: "custom", fields: [branch] },
        { label: "Known", value: "known" },
      ],
      [CARRIAGE_RETURN, `${ESCAPE}[B`, CARRIAGE_RETURN],
    );

    expect(result.value).toBe("custom");
    expect(result.values).toEqual({ branch: "" });
    expect(result.stderr.text()).not.toContain("> Known");
  });

  test.each([
    ["Escape", ESCAPE],
    ["Ctrl-C", CTRL_C],
  ])(
    "cancels the whole dialog with %s at the option stage and mid-collection",
    async (_label, chunk) => {
      const options: readonly SelectOption<string>[] = [
        {
          label: "Custom",
          value: "custom",
          fields: [owner, repository],
        },
      ];

      const atOptions = await runSelection(options, [chunk]);
      expect(atOptions.value).toBeUndefined();
      expect(atOptions.values).toBeUndefined();
      expect(atOptions.exitCode).toBe(0);

      const atFirstField = await runSelection(options, [
        CARRIAGE_RETURN,
        chunk,
      ]);
      expect(atFirstField.value).toBeUndefined();
      expect(atFirstField.values).toBeUndefined();

      const midCollection = await runSelection(options, [
        CARRIAGE_RETURN,
        "fx",
        CARRIAGE_RETURN,
        chunk,
      ]);
      expect(midCollection.value).toBeUndefined();
      expect(midCollection.values).toBeUndefined();
      expect(midCollection.exitCode).toBe(0);
      expect(midCollection.stdin.rawModes).toEqual([true, false]);
      expect(process.exitCode).not.toBe(1);
    },
  );

  test("collects a field whose name shadows an inherited property", async () => {
    const result = await runSelection(
      [
        {
          label: "Custom",
          value: "custom",
          fields: [
            { type: "text", name: "__proto__", message: "Which prototype?" },
            { type: "text", name: "constructor", message: "Which builder?" },
            { type: "text", name: "toString", message: "Which printer?" },
          ],
        },
      ],
      [
        CARRIAGE_RETURN,
        "a",
        CARRIAGE_RETURN,
        "b",
        CARRIAGE_RETURN,
        "c",
        CARRIAGE_RETURN,
      ],
    );

    const values = result.values as Readonly<Record<string, string>>;
    const own = (name: string) =>
      Object.getOwnPropertyDescriptor(values, name)?.value;
    expect(Object.keys(values)).toEqual([
      "__proto__",
      "constructor",
      "toString",
    ]);
    expect(own("__proto__")).toBe("a");
    expect(own("constructor")).toBe("b");
    expect(own("toString")).toBe("c");
  });

  test.each([
    ["Escape", ESCAPE],
    ["Ctrl-C", CTRL_C],
  ])(
    "cancels with %s delivered in the same chunk as the Enter that began collection",
    async (_label, chunk) => {
      const result = await runSelection(
        [{ label: "Custom", value: "custom", fields: [owner] }],
        [`${CARRIAGE_RETURN}${BACKSPACE}${chunk}`],
      );

      expect(result.exitCode).toBe(0);
      expect(result.value).toBeUndefined();
      expect(result.values).toBeUndefined();
      expect(result.stdin.rawModes).toEqual([true, false]);
    },
  );

  test("declines input aimed at a field that was already submitted", async () => {
    const result = await runSelection(
      [{ label: "Custom", value: "custom", fields: [owner, repository] }],
      [
        CARRIAGE_RETURN,
        "a",
        `${CARRIAGE_RETURN}${BACKSPACE}${CARRIAGE_RETURN}`,
        "b",
        CARRIAGE_RETURN,
      ],
    );

    expect(result.value).toBe("custom");
    expect(result.values).toEqual({ owner: "a", repository: "b" });
    expect(result.stderr.text()).toContain(repository.message);
  });

  test("keeps the first settlement when one chunk carries input past it", async () => {
    const past = `${CARRIAGE_RETURN}${BACKSPACE}${CARRIAGE_RETURN}`;

    const afterLastField = await runSelection(
      [{ label: "Custom", value: "custom", fields: [owner] }],
      [CARRIAGE_RETURN, "a", past],
    );
    expect(afterLastField.value).toBe("custom");
    expect(afterLastField.values).toEqual({ owner: "a" });

    const afterPlainOption = await runSelection(
      [
        { label: "Known", value: "known" },
        { label: "Other", value: "other" },
      ],
      [past],
    );
    expect(afterPlainOption.value).toBe("known");
    expect(afterPlainOption.values).toEqual({});
  });

  test("rejects an invalid field declaration before rendering or terminal changes", async () => {
    for (const [fields, message] of [
      [[], "A user-provided select option requires at least one field"],
      [
        [owner, { ...owner, message: "Owner again" }],
        'A select option repeats the field name "owner"',
      ],
    ] as const) {
      const result = await runRejected([
        { label: "Known", value: 1 },
        { label: "Custom", value: 2, fields },
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.failure).toBeInstanceOf(Error);
      expect((result.failure as Error).message).toBe(message);
      expect(result.stderr.text()).toBe("");
      expect(result.stdin.rawModes).toEqual([]);
    }
  });

  test("collects every stage in one render session without tearing down between them", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let renders = 0;
    let unmounts = 0;
    const ink: CoreDependencies["ink"] = {
      ...coreDependencies.ink,
      render(...args: Parameters<CoreDependencies["ink"]["render"]>) {
        renders++;
        const renderer = coreDependencies.ink.render(...args);
        return {
          ...renderer,
          unmount() {
            unmounts++;
            renderer.unmount();
          },
        };
      },
    };
    let result: SelectResult<string> | undefined;
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          result = await dialogs.select({
            message: "Pick one",
            options: [
              {
                label: "Custom",
                value: "custom",
                fields: [owner, repository],
              },
            ],
          });
        }),
      ],
      context(stdin, stderr),
      { ...coreDependencies, ink },
    );
    await until(() => stdin.rawModes.includes(true));
    for (const chunk of [
      CARRIAGE_RETURN,
      "fx",
      CARRIAGE_RETURN,
      "tx",
      CARRIAGE_RETURN,
    ]) {
      expect(unmounts).toBe(0);
      expect(stdin.rawModes).toEqual([true]);
      stdin.write(chunk);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }

    expect(await running).toBe(0);
    expect(result).toEqual({
      value: "custom",
      values: { owner: "fx", repository: "tx" },
    });
    expect(renders).toBe(1);
    expect(unmounts).toBe(1);
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.refs).toBe(1);
    expect(stdin.unrefs).toBe(1);
    expect(stdin.activeReferences).toBe(0);
    expect(stdin.listenerCount("data")).toBe(0);
  });
});
