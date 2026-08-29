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

type SelectOption<T> = {
  readonly label: string;
  readonly value: T;
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
  }): Promise<T | undefined>;
};

const ESCAPE = String.fromCharCode(27);
const BACKSPACE = String.fromCharCode(127);
const CTRL_A = String.fromCharCode(1);
const CTRL_C = String.fromCharCode(3);
const CARRIAGE_RETURN = "\r";

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
          value = await dialogs.select({
            message: "Preserve source",
            options: [{ label: "One", value: 1 }],
          });
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
      CARRIAGE_RETURN,
    ]);

    expect(result.value).toBe("hello world!abcd");
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
