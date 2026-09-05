import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  animationInterval,
  flashDuration,
  flashInterval,
} from "../plugins/dialogs/animation.ts";
import dialogsPlugin from "../plugins/dialogs/index.ts";
import { stackedValues } from "../plugins/dialogs/select.ts";
import {
  collectingChromeHeight,
  selectChromeHeight,
} from "../plugins/dialogs/viewport.ts";
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
  readonly dialog?: SelectRequest<T> | TextField;
};

type SelectRequest<T> = {
  readonly message: string;
  readonly options: readonly SelectOption<T>[];
  readonly filter?: "typed" | "always";
  readonly expand?: "enter" | "tab";
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
  select<T>(request: SelectRequest<T>): Promise<SelectResult<T> | undefined>;
};

const ESCAPE = String.fromCharCode(27);
const BACKSPACE = String.fromCharCode(127);
const CTRL_A = String.fromCharCode(1);
const CTRL_C = String.fromCharCode(3);
const CARRIAGE_RETURN = "\r";
const UP = `${ESCAPE}[A`;
const DOWN = `${ESCAPE}[B`;
const RIGHT = `${ESCAPE}[C`;
const LEFT = `${ESCAPE}[D`;
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

/**
 * How long `until` waits by default: for a dialog to open, to put its first
 * frame on screen, or to settle behind a flash.
 *
 * Deliberately generous, because none of those is an animation. A runner with
 * twenty test files in flight can be slow to produce a first frame long after
 * the dialogs themselves are correct, and this loop previously counted
 * iterations rather than milliseconds, so it had no wall-clock bound at all.
 * Bounding it tightly would trade a hang for a flake. It is still written in
 * the constant the dialogs animate on rather than as a bare number, so it can
 * never come to race the animation it is waiting behind.
 */
const DIALOG_BUDGET = animationInterval * 20;

/** The budget a wait on the caret's or the indicator's own phase gets: two full
 * phases plus the room to observe the second. Tight on purpose, unlike the
 * default — a phase that never arrives is exactly the defect these tests exist
 * to catch, so this one has to fail rather than keep waiting. */
const PHASE_BUDGET = animationInterval * 3;

async function until(
  predicate: () => boolean,
  budget = DIALOG_BUDGET,
): Promise<void> {
  const deadline = performance.now() + budget;
  for (;;) {
    if (predicate()) return;
    if (performance.now() >= deadline) {
      throw new Error("timed out waiting for dialog state");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

/** The message every `runSelection` dialog carries, and so the row every one of
 * its frames opens with. */
const SELECT_MESSAGE = "Pick one";

/** The top-left corner of a select's frame, which anchors the frame on screen
 * whatever its title has become: a browser titles itself with the trail of
 * columns it is showing, and a narrow terminal cuts that trail short. */
const PANEL = "╔═";

/** The escape sequences the renderer writes around a frame, so a test that
 * matches on what the user reads can ignore them. Built from the escape
 * character rather than written literally, so the source carries no control
 * character. */
const CONTROL_SEQUENCE = new RegExp(`${ESCAPE}\\[[\\d;?]*[a-zA-Z]`, "g");

/** The text a frame puts on screen, with every styling and cursor sequence
 * removed. */
function stripped(text: string): string {
  return text.replace(CONTROL_SEQUENCE, "");
}

/** Every control sequence except the SGR styling codes: cursor movement,
 * erasure, and mode switches. Ink leaves its last row unterminated and
 * repositions the cursor before rewriting, so the previous frame's last row
 * shares a line of the byte stream with the next frame's first row and this is
 * the boundary between them. */
const CURSOR_SEQUENCE = new RegExp(`${ESCAPE}\\[[\\d;?]*[A-Za-ln-z]`, "g");

/** Ink rewrites its whole output on every render, and every select frame opens
 * with the request message set into its top border, so the frame the dialog
 * left on screen begins at the start of the row carrying that message's last
 * occurrence. The row is taken whole, because the message now shares it with
 * the border either side of it, and from after the last repositioning ahead of
 * it, because the row the previous frame ended with is still on that line. */
function lastFrame(stderr: CapturedOutput, anchor = SELECT_MESSAGE): string {
  const output = stderr.text();
  const found = output.lastIndexOf(anchor);
  expect(found).toBeGreaterThanOrEqual(0);
  const start = output.lastIndexOf("\n", found) + 1;
  let boundary = 0;
  for (const match of output.slice(start, found).matchAll(CURSOR_SEQUENCE)) {
    boundary = (match.index as number) + match[0].length;
  }
  return output.slice(start + boundary);
}

/** The rows of the frame the dialog left on screen, so a test can count them
 * against the terminal's height. */
function frameRows(
  stderr: CapturedOutput,
  anchor = SELECT_MESSAGE,
): readonly string[] {
  const rows = stripped(lastFrame(stderr, anchor)).split("\n");
  while (rows.at(-1) === "") rows.pop();
  return rows;
}

/** The sequences the renderer wraps a dimmed run in, which is how a test tells
 * chrome from content and a pulsing indicator from a resting one. */
const DIM_OPEN = `${ESCAPE}[2m`;
const DIM_CLOSE = `${ESCAPE}[22m`;

/** The marker drawn on the right of a row that opens a sub-dialog. */
const EXPAND_MARKER = "▸";

/**
 * Every cursor bar in the given output, as the text it carries and the column
 * it starts at. A bar is the terminal's own inversion and nothing else, and
 * every column draws the same one on the choice it was left on, so nothing
 * about a bar says which column is being driven — where it sits does.
 *
 * Read line by line, tracking the styling state across each: the renderer
 * emits only the transitions between adjacent cells, so a pair-matching reader
 * would mistake where a run begins and ends. The starting column is what tells
 * the columns apart — they sit left to right in the order they were opened, so
 * the rightmost bar belongs to the column being driven.
 */
function barRuns(
  text: string,
): readonly { readonly text: string; readonly column: number }[] {
  const runs: { text: string; column: number }[] = [];
  const sequences = new RegExp(`${ESCAPE}\\[([\\d;]*)m`, "g");
  for (const line of text.split("\n")) {
    let inverse = false;
    let column = 0;
    let carried: { text: string; column: number } | undefined;
    let cursor = 0;
    const take = (piece: string) => {
      if (piece === "") return;
      if (inverse) {
        carried ??= { text: "", column };
        carried.text += piece;
      }
      column += piece.length;
    };
    const close = () => {
      if (carried === undefined) return;
      runs.push(carried);
      carried = undefined;
    };
    for (const match of line.matchAll(sequences)) {
      take(line.slice(cursor, match.index));
      cursor = (match.index as number) + match[0].length;
      for (const code of (match[1] as string).split(";")) {
        if (code === "" || code === "0" || code === "27") {
          close();
          inverse = false;
        } else if (code === "7") inverse = true;
      }
    }
    take(line.slice(cursor));
    close();
  }
  return runs;
}

/** Every cursor bar as the label it carries. The bar spans its whole column,
 * marker and padding included; tests about which row the cursor is on say so
 * with the label, and that an expandable row carries the marker at all is
 * asserted where the marker is the subject. */
function bars(text: string): readonly string[] {
  return barRuns(text).map((run) => {
    const label = run.text.trimEnd();
    return label.endsWith(` ${EXPAND_MARKER}`)
      ? label.slice(0, -2).trimEnd()
      : label;
  });
}

/** The columns each cursor bar spans, padding included — which is what makes
 * it a bar across its column rather than a highlighted label. */
function barWidths(text: string): readonly number[] {
  return barRuns(text).map((run) => run.text.length);
}

/** Whether the given text is dimmed where it appears in the output.
 *
 * Read by tracking the styling state across the whole frame rather than by
 * looking for an opening sequence in front of it: the renderer emits only the
 * transitions between adjacent cells, so a dimmed run that follows a dimmed
 * border never reopens dimming inside itself. `undefined` means the text is
 * not on screen at all. */
function dimmedAt(text: string, needle: string): boolean | undefined {
  const cells: { char: string; dim: boolean }[] = [];
  let dim = false;
  let cursor = 0;
  const sequences = new RegExp(`${ESCAPE}\\[([\\d;]*)m`, "g");
  const take = (piece: string) => {
    for (const char of piece) cells.push({ char, dim });
  };
  for (const match of text.matchAll(sequences)) {
    take(text.slice(cursor, match.index));
    cursor = (match.index as number) + match[0].length;
    for (const code of (match[1] as string).split(";")) {
      if (code === "" || code === "0" || code === "22") dim = false;
      else if (code === "2") dim = true;
    }
  }
  take(text.slice(cursor));
  const at = cells
    .map((cell) => cell.char)
    .join("")
    .indexOf(needle);
  return at < 0 ? undefined : (cells[at] as { dim: boolean }).dim;
}

/** Whether the frame on screen shows this row as its cursor. Reading a frame
 * that has not been written yet throws, and a test waiting for one is asking
 * exactly that question, so the throw is an answer rather than a failure. */
function showsActiveRow(
  stderr: CapturedOutput,
  expected: string,
  anchor = SELECT_MESSAGE,
): boolean {
  try {
    return activeRow(stderr, anchor) === expected;
  } catch {
    return false;
  }
}

/** The one row the frame on screen renders as the cursor: the active option of
 * the column being driven, which is the rightmost column and so the bar
 * starting furthest across. */
function activeRow(stderr: CapturedOutput, anchor = SELECT_MESSAGE): string {
  const runs = [...barRuns(lastFrame(stderr, anchor))].sort(
    (one, other) => one.column - other.column,
  );
  expect(runs.length).toBeGreaterThan(0);
  const label = (runs.at(-1) as { text: string }).text.trimEnd();
  return label.endsWith(` ${EXPAND_MARKER}`)
    ? label.slice(0, -2).trimEnd()
    : label;
}

/** These tests still say `true`, `false`, and `"auto"` where a request now
 * says when the filter is shown. Filtering itself is never off, so `false` and
 * `"auto"` are both the default — shown once something has been typed — and
 * `true` is a caller asking for it from the start. */
function filterMode(
  setting: boolean | "auto" | undefined,
): "typed" | "always" | undefined {
  if (setting === undefined) return undefined;
  return setting === true ? "always" : "typed";
}

/** Labels are numbered from `01`, so no label is a substring of another and
 * an assertion that one row is absent means it. */
function listed(count: number): readonly SelectOption<number>[] {
  return Array.from({ length: count }, (_, index) => ({
    label: `Option ${String(index + 1).padStart(2, "0")}`,
    value: index + 1,
  }));
}

/** A terminal double of a chosen height, for the dialogs whose behavior depends
 * on how many rows they have to work with. */
function terminalOfRows(rows: number): CapturedOutput {
  const stderr = new CapturedOutput();
  stderr.rows = rows;
  return stderr;
}

/** A terminal double of a chosen width, for the frames whose width follows it
 * and the labels it makes too long to render whole. */
function terminalOfColumns(columns: number): CapturedOutput {
  const stderr = new CapturedOutput();
  stderr.columns = columns;
  return stderr;
}

/** One step a running dialog takes: a chunk written to its input, or something
 * done to the terminal it renders on — a resize, reading the frame that is on
 * screen while the dialog is still open, or timing a keystroke the step writes
 * itself, which is what an animation has to be measured against. */
type DialogStep =
  | string
  | ((stderr: CapturedOutput, stdin: TerminalInput) => void | Promise<void>);

async function runSelection<T>(
  options: readonly SelectOption<T>[],
  input: string | readonly DialogStep[],
  filter?: boolean | "auto",
  stderr: CapturedOutput = new CapturedOutput(),
  message: string = SELECT_MESSAGE,
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
        const mode = filterMode(filter);
        result = await dialogs.select({
          message,
          options,
          ...(mode === undefined ? {} : { filter: mode }),
        });
      }),
    ],
    commandContext,
  );
  await until(() => stdin.rawModes.includes(true));
  for (const step of typeof input === "string" ? [input] : input) {
    if (typeof step === "string") stdin.write(step);
    else await step(stderr, stdin);
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
  input: readonly DialogStep[],
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
    for (const step of input) {
      if (typeof step === "string") stdin.write(step);
      else await step(stderr, stdin);
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
    expect(activeRow(result.stderr)).toBe("Alpha");
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
      // The typed character narrows nothing away — every label carries it —
      // so the list the arrows then move over is the whole list. Typing
      // always filters now, so there is no length at which it does nothing.
      ["a", "[A", "[B", "[B", "[B", "[A", "\r"],
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
    expect(activeRow(result.stderr)).toBe("Two");
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

  test("narrows to the terms typed, at any list length", async () => {
    for (const options of [nine, eight]) {
      const result = await runSelection(options, ["alp", CARRIAGE_RETURN]);

      expect(result.value).toBe("alpha");
      expect(result.values).toEqual({});
      const frame = stripped(lastFrame(result.stderr));
      expect(frame).toContain("› alp");
      expect(activeRow(result.stderr)).toBe("Alpha");
      expect(frame).toContain("Alphabet");
      expect(frame.indexOf("Alpha")).toBeLessThan(frame.indexOf("Alphabet"));
      expect(frame).not.toContain("Beta");
      expect(frame).not.toContain("Gamma");
    }
  });

  test("stays off screen until something is typed into it", async () => {
    // Filtering is always live, so there is no list length and no setting at
    // which typing does nothing. What the reader has not asked for is the
    // filter taking up an edge before they have typed anything.
    const untouched = await runSelection(eight, [CARRIAGE_RETURN]);
    expect(untouched.value).toBe("alpha");
    const frame = stripped(lastFrame(untouched.stderr));
    expect(frame).not.toContain("›");
    expect(frame).toContain("Gamma");

    const typed = await runSelection(eight, ["gam", CARRIAGE_RETURN]);
    expect(typed.value).toBe("gamma");
    expect(stripped(lastFrame(typed.stderr))).toContain("› gam");
  });

  test("shows itself from the start when the caller asks", async () => {
    const asked = await runSelection(
      named("Alpha", "Beta", "Gamma"),
      [
        async (stderr) => {
          // On screen before a single key has reached it.
          await until(() => stripped(stderr.text()).includes("›"));
        },
        "bet",
        CARRIAGE_RETURN,
      ],
      true,
    );
    expect(asked.value).toBe("beta");
    const frame = stripped(lastFrame(asked.stderr));
    expect(frame).toContain("› bet");
    expect(activeRow(asked.stderr)).toBe("Beta");
    expect(frame).not.toContain("Alpha");
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
    const frame = stripped(lastFrame(result.stderr));
    expect(activeRow(result.stderr)).toBe("release branch");
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
    const frame = stripped(lastFrame(widened.stderr));
    expect(activeRow(widened.stderr)).toBe("Alpha");
    expect(frame).toContain("Beta");
    expect(frame).toContain("Gamma");
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
    const frame = stripped(lastFrame(result.stderr));
    expect(frame).toContain("› zzz");
    expect(activeRow(result.stderr)).toBe("Other…");
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
    const frame = stripped(lastFrame(cancelled.stderr));
    expect(frame).toContain("› zzz");
    expect(frame).toContain("no match");
    expect(frame).not.toContain("Alpha");
    // Nothing is visible, so nothing is active and no row carries the bar.
    expect(bars(lastFrame(cancelled.stderr))).toEqual([]);

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
    expect(stripped(lastFrame(recovered.stderr))).not.toContain("no match");
    expect(activeRow(recovered.stderr)).toBe("Alpha");
  });

  test("navigates the visible list and clamps at its last entry", async () => {
    const result = await runSelection(
      named("Alpha", "Beta", "Alpaca", "Gamma", "Alpine"),
      ["alp", DOWN, DOWN, DOWN, CARRIAGE_RETURN],
      true,
    );

    expect(result.value).toBe("alpine");
    const frame = stripped(lastFrame(result.stderr));
    expect(frame).toContain("Alpha");
    expect(frame).toContain("Alpaca");
    expect(activeRow(result.stderr)).toBe("Alpine");
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
      expect(stripped(lastFrame(result.stderr))).toContain("› alp");
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
    const frame = stripped(lastFrame(result.stderr));
    expect(frame).toContain("› cus");
    expect(frame).not.toContain("cusabc");
    expect(frame).not.toContain("Known");
  });
});

describe("select viewport and extended navigation", () => {
  const HOME = `${ESCAPE}[H`;
  const END = `${ESCAPE}[F`;
  const PAGE_UP = `${ESCAPE}[5~`;
  const PAGE_DOWN = `${ESCAPE}[6~`;

  /** Thirty options of which the fifteen odd positions carry `Alpha`, so a
   * filter leaves a list still longer than the window. */
  const mixed: readonly SelectOption<number>[] = Array.from(
    { length: 30 },
    (_, index) => ({
      label: `${index % 2 === 0 ? "Beta" : "Alpha"} ${String(index).padStart(2, "0")}`,
      value: index,
    }),
  );

  /** The height at which a choosing select is down to its last option row: one
   * more than the chrome it draws, plus the row that keeps it strictly shorter
   * than the terminal. */
  const SHORT_TERMINAL = selectChromeHeight + 2;

  /** The same for a select that has gone on to collect a field, whose second
   * panel costs three more rows than the hint line it replaces. */
  const SHORT_COLLECTING_TERMINAL = collectingChromeHeight + 2;

  /** The frame a thirty-option select leaves in a terminal that short: the
   * panel, one option row, and the hints. The filter and the count of
   * everything hidden are set into the edges the panel was drawing anyway, so
   * neither costs it one of the rows it has so few of. */
  const shortTerminalFrame = [
    "╔═ Pick one ══════╗",
    "║ Option 01       ║",
    "╚═══════════ ▼ 29 ╝",
    " ↑↓ move · Enter select · type to filter · Esc cancel",
  ];

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
    const frame = stripped(lastFrame(result.stderr));
    expect(activeRow(result.stderr)).toBe("Option 01");
    expect(frame).toContain("Option 10");
    expect(frame).not.toContain("Option 11");
    expect(frame).toContain("▼ 20");
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
    const frame = stripped(lastFrame(result.stderr));
    expect(frame).toContain("▲ 1");
    expect(frame).toContain("Option 02");
    expect(activeRow(result.stderr)).toBe("Option 11");
    expect(frame).toContain("▼ 19");
    expect(frame).not.toContain("Option 01");
    expect(frame).not.toContain("Option 12");
  });

  test("shrinks in a short terminal and stays shorter than it", async () => {
    const result = await runSelection(
      listed(30),
      [CARRIAGE_RETURN],
      undefined,
      terminalOfRows(SHORT_TERMINAL),
    );

    expect(result.value).toBe(1);
    expect(frameRows(result.stderr)).toEqual(shortTerminalFrame);
    expect(frameRows(result.stderr).length).toBeLessThan(SHORT_TERMINAL);
  });

  /** One row above the chrome is the height at which one option row would make
   * the worst-case frame exactly as tall as the terminal, which is what Ink
   * reads as full-screen and answers by clearing the terminal on unmount. The
   * window gives up its last row there, and the dialog still navigates and
   * settles on a choice it no longer draws. */
  test("draws no option row in a terminal one row above the chrome", async () => {
    let open: readonly string[] = [];
    const result = await runSelection(
      listed(30),
      [
        PAGE_DOWN,
        DOWN,
        async (stderr) => {
          // Ink batches its writes, so the first frame is not on screen the
          // instant the chunks before it are written.
          await until(() => stderr.text().includes("▼ 30"));
          open = frameRows(stderr);
        },
        CARRIAGE_RETURN,
      ],
      undefined,
      // Pinned as a literal rather than as the chrome constant plus one: a
      // bound written in terms of the number under test moves with it, and a
      // constant that grew would keep passing here instead of failing.
      terminalOfRows(4),
    );

    expect(result.value).toBe(2);
    expect(open).toEqual([
      "╔═ Pick one ══════╗",
      "╚═══════════ ▼ 30 ╝",
      " ↑↓ move · Enter select · type to filter · Esc cancel",
    ]);
    expect(open.length).toBeLessThan(4);
  });

  test("re-derives the window after the terminal is resized", async () => {
    const result = await runSelection(
      listed(30),
      [
        (stderr) => {
          stderr.rows = SHORT_TERMINAL;
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

  /**
   * A terminal too short to draw the window does not cost the window its place
   * in the list. Scroll so it holds a start of its own, leave the cursor bar in
   * the middle of it, shrink the terminal until no option row fits at all, and
   * grow it back: the window must reopen where the user left it. Collapsing it
   * used to throw the remembered start away along with the drawn one, so the
   * window came back at the edge the active option drags it to from the top of
   * the list — four rows short of where it was, with the whole list shifted
   * under a cursor bar the user never moved.
   */
  test("reopens a collapsed window where it was, not at the active option", async () => {
    let collapsed: readonly string[] = [];
    let reopened: readonly string[] = [];
    const result = await runSelection(
      listed(30),
      [
        END,
        UP,
        UP,
        UP,
        UP,
        async (stderr) => {
          // The window has to have reached a start of its own on screen before
          // the terminal shrinks; that start is what the collapse must keep.
          await until(() => stderr.text().includes("▲ 20"));
          // Four rows is where a choosing select gives up its last option
          // row. Written as a literal rather than off the chrome constant, so a
          // chrome that grows fails here instead of moving the boundary this
          // test collapses at and passing against a case it never meant.
          stderr.rows = 4;
          stderr.emit("resize");
        },
        async (stderr) => {
          await until(() => stderr.text().includes("▼ 30"));
          collapsed = frameRows(stderr);
          stderr.rows = 40;
          stderr.emit("resize");
        },
        async (stderr) => {
          // The collapsed frame is the only one short enough to have no option
          // row in it, so growing past it is the signal, whatever the window
          // then does with its start.
          await until(() => frameRows(stderr).length > collapsed.length);
          reopened = frameRows(stderr);
        },
        CARRIAGE_RETURN,
      ],
      undefined,
      terminalOfRows(40),
    );

    expect(result.value).toBe(26);
    // Nothing sits above rows that are not there, so the collapsed frame still
    // counts the whole list as hidden below rather than splitting it.
    expect(collapsed).toEqual([
      "╔═ Pick one ══════╗",
      "╚═══════════ ▼ 30 ╝",
      " ↑↓ move · Enter select · type to filter · Esc cancel",
    ]);
    expect(reopened).toEqual([
      "╔═ Pick one  ▲ 20 ╗",
      "║ Option 21       ║",
      "║ Option 22       ║",
      "║ Option 23       ║",
      "║ Option 24       ║",
      "║ Option 25       ║",
      "║ Option 26       ║",
      "║ Option 27       ║",
      "║ Option 28       ║",
      "║ Option 29       ║",
      "║ Option 30       ║",
      "╚═════════════════╝",
      " ↑↓ move · Enter select · type to filter · Esc cancel",
    ]);
    expect(activeRow(result.stderr)).toBe("Option 26");
  });

  test("jumps to the last and the first visible option", async () => {
    const end = await runSelection(
      listed(30),
      [END, CARRIAGE_RETURN],
      undefined,
      terminalOfRows(40),
    );
    expect(end.value).toBe(30);
    const endFrame = stripped(lastFrame(end.stderr));
    expect(endFrame).toContain("▲ 20");
    expect(activeRow(end.stderr)).toBe("Option 30");
    expect(endFrame).not.toContain("▼");

    const home = await runSelection(
      listed(30),
      [END, HOME, CARRIAGE_RETURN],
      undefined,
      terminalOfRows(40),
    );
    expect(home.value).toBe(1);
    expect(activeRow(home.stderr)).toBe("Option 01");
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
      // A literal for the same reason: twelve rows is eight option rows, and
      // a chrome constant that grew must fail this page rather than shrink it.
      terminalOfRows(12),
    );

    expect(result.value).toBe(9);
  });

  test("pages by the same window whether or not a sub-dialog is open", async () => {
    const options: readonly SelectOption<number>[] = [
      ...listed(29),
      {
        label: "Category",
        value: 30,
        dialog: { message: "Nested", options: listed(30) },
      },
    ];
    // Columns sit beside each other rather than over each other, so opening
    // one costs the terminal no rows: twelve rows leave eight option rows in
    // the nested column exactly as they do flat, and one page from its first
    // option lands on its ninth option's value.
    const result = await runSelection(
      options,
      [END, RIGHT, PAGE_DOWN, CARRIAGE_RETURN],
      false,
      terminalOfRows(12),
    );
    expect(result.value).toBe(9);
  });
  test("keeps a deep column browser inside a short, narrow terminal", async () => {
    const deep: readonly SelectOption<number>[] = [
      { label: "Known", value: 0 },
      {
        label: "Category",
        value: 1,
        dialog: {
          message: "Middle",
          options: [
            { label: "First", value: 2 },
            {
              label: "Sub",
              value: 3,
              dialog: {
                message: "Deeper",
                options: [
                  { label: "Leaf", value: 4 },
                  {
                    label: "Down",
                    value: 5,
                    dialog: {
                      message: "Deepest",
                      options: [{ label: "End", value: 6 }],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ];
    const terminalRows = 10;
    const columns = 30;
    const stderr = terminalOfRows(terminalRows);
    stderr.columns = columns;
    const result = await runSelection(
      deep,
      [DOWN, RIGHT, DOWN, RIGHT, DOWN, RIGHT, CARRIAGE_RETURN],
      false,
      stderr,
    );
    expect(result.value).toBe(6);
    // Anchored on the frame's corner rather than the root's message: the
    // browser has collapsed the leftmost columns to fit, and its title names
    // only the columns still on screen.
    const rows = frameRows(result.stderr, PANEL);
    expect(rows.length).toBeLessThan(terminalRows);
    for (const row of rows) {
      expect(row.length).toBeLessThanOrEqual(columns);
    }
    expect(activeRow(result.stderr, PANEL)).toBe("End");
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
      terminalOfRows(SHORT_COLLECTING_TERMINAL),
    );

    expect(result.value).toBe(0);
    expect(result.values).toEqual({ branch: "abc" });
    // Every chrome row the collecting constant counts, on screen at once: the
    // select's two edges, the field's own panel, and the hints. The window
    // gave a row back to make room for that second panel, and the count of
    // what it hides is set into the edge rather than costing another.
    expect(collecting).toEqual([
      "╔═ Pick one  ▲ 29 ╗",
      "║ Other…          ║",
      "╚═════════════════╝",
      "┌─ Branch name ─┐",
      "│ abc█          │",
      "└───────────────┘",
      " Enter submit · Esc cancel",
    ]);
    expect(collecting).toHaveLength(7);
    expect(collecting.length).toBeLessThan(SHORT_COLLECTING_TERMINAL);
  });

  /**
   * A text leaf draws the same entry panel a collected field does and costs the
   * frame the same rows, so it has to be budgeted the same way. Budgeting it as
   * if nothing were under the browser sized the window for the four option rows
   * an eight-row terminal affords a choosing select, and then drew those four
   * rows, the panel's two edges, and the entry's four: ten rows in an eight-row
   * terminal, which is the height at which Ink reads the output as full-screen
   * and clears the terminal on the way out.
   */
  test("leaves room for a text leaf's entry in a short terminal", async () => {
    const terminalRows = 8;
    let open: readonly string[] = [];
    const result = await runSelection(
      [
        ...listed(29),
        {
          label: "Tagged",
          value: 0,
          dialog: { type: "text", name: "tag", message: "Which tag?" },
        },
      ],
      [
        END,
        RIGHT,
        async (stderr) => {
          await until(() => stripped(stderr.text()).includes("Which tag?"));
          // The push is synchronous but the entry subscribes on its mount
          // effect; wait it out so the typed text is not swallowed before then.
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          open = frameRows(stderr, PANEL);
        },
        "v1",
        CARRIAGE_RETURN,
      ],
      undefined,
      terminalOfRows(terminalRows),
    );

    expect(result.value).toBe(0);
    expect(result.values).toEqual({ tag: "v1" });
    // The window gave its rows back to the leaf's panel exactly as it does for
    // a collected field, so the whole frame stays under the terminal's height.
    expect(open).toEqual([
      "╔═ Pick one  ▲ 29 ╗",
      "║ Tagged        ▸ ║",
      "╚═════════════════╝",
      "┌─ Which tag? ─┐",
      "│ █            │",
      "└──────────────┘",
      // A leaf's Escape pops back into the column that opened it, so its hint
      // names backing out rather than cancelling.
      " Enter submit · Esc back",
    ]);
    expect(open).toHaveLength(7);
    expect(open.length).toBeLessThan(terminalRows);
  });

  /**
   * A text leaf holds a level and a window slot of its own without being a
   * column, so the driven column is the level beneath it. Reading the top slot
   * instead windowed the scrolled column from the zero the leaf's slot was
   * pushed with, and wrote that back — so the place the reader had scrolled to
   * was gone for good rather than restored when the leaf closed.
   */
  test("keeps a scrolled column's window across a text leaf", async () => {
    const listing: readonly SelectOption<number>[] = listed(30).map(
      (option, index) =>
        index === 25
          ? {
              ...option,
              dialog: {
                type: "text" as const,
                name: "tag",
                message: "Which tag?",
              },
            }
          : option,
    );
    let scrolled: readonly string[] = [];
    let restored: readonly string[] = [];
    const result = await runSelection(
      listing,
      [
        END,
        UP,
        UP,
        UP,
        UP,
        async (stderr) => {
          await until(() => showsActiveRow(stderr, "Option 26", PANEL));
          scrolled = frameRows(stderr, PANEL);
        },
        RIGHT,
        async (stderr) => {
          await until(() => stripped(stderr.text()).includes("Which tag?"));
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        },
        ESCAPE,
        async (stderr) => {
          await until(
            () => !stripped(lastFrame(stderr, PANEL)).includes("Which tag?"),
          );
          restored = frameRows(stderr, PANEL);
        },
        UP,
        CARRIAGE_RETURN,
      ],
      false,
      terminalOfRows(40),
    );

    expect(result.value).toBe(25);
    // The window the reader scrolled to: the last ten options, with the active
    // one six rows down rather than at either edge, so a window re-derived from
    // the top would land somewhere else.
    expect(scrolled[1]).toContain("Option 21");
    expect(scrolled.at(-3)).toContain("Option 30");
    // Backing out of the leaf shows exactly the frame the column was left on.
    expect(restored).toEqual(scrolled);
  });

  /**
   * The columns share one band, so an entry panel appearing shrinks that band
   * for every column, the frozen ones included — otherwise a frozen column
   * keeping a taller window would take the panel over the terminal's height.
   * The shrink itself is right; persisting it is not. A frozen column cannot be
   * scrolled, so the only thing that ever moves its window is the band, and
   * writing that back drifted the column a row further down every time the band
   * shrank, with nothing to bring it back when the band grew again.
   */
  test("returns a frozen column to its own window once the band grows back", async () => {
    const listing: readonly SelectOption<number>[] = listed(40).map(
      (option, index) =>
        index === 30
          ? {
              ...option,
              dialog: {
                message: "Nested",
                options: [
                  {
                    label: "Named",
                    value: 0,
                    fields: [
                      {
                        type: "text" as const,
                        name: "branch",
                        message: "Branch name",
                      },
                    ],
                  },
                ],
              },
            }
          : option,
    );
    let scrolled: readonly string[] = [];
    let shrunk: readonly string[] = [];
    let restored: readonly string[] = [];
    const result = await runSelection(
      listing,
      [
        // Scrolled far enough down that the window has a start of its own, and
        // then back up so the active option sits below the middle of it: the
        // band shrinking from ten rows to seven is what pulls that option's
        // window down, and only an option low in the window is pulled.
        DOWN.repeat(32),
        UP.repeat(2),
        async (stderr) => {
          await until(() => showsActiveRow(stderr, "Option 31", PANEL));
          scrolled = frameRows(stderr, PANEL);
        },
        // Open the sub-dialog, which freezes the column behind it, and choose
        // the option whose field puts a second panel on screen.
        RIGHT,
        CARRIAGE_RETURN,
        async (stderr) => {
          await until(() => stripped(stderr.text()).includes("Branch name"));
          shrunk = frameRows(stderr, PANEL);
        },
        // Escape on a nested collection pops the level rather than cancelling,
        // which takes the second panel off screen and gives the band its rows
        // back.
        ESCAPE,
        async (stderr) => {
          await until(
            () => !stripped(lastFrame(stderr, PANEL)).includes("Branch name"),
          );
          restored = frameRows(stderr, PANEL);
        },
        UP,
        CARRIAGE_RETURN,
      ],
      false,
      terminalOfRows(14),
    );

    expect(result.value).toBe(30);
    expect(scrolled[1]).toContain("Option 24");
    expect(scrolled.at(-3)).toContain("Option 33");
    // The band did shrink, and the frozen column's window came down with it so
    // the panel stayed inside the terminal. The two frames are the same height
    // because the rows the band gave up are exactly the rows the field's own
    // panel took, which is the whole point of the shrink.
    const optionRows = (frame: readonly string[]) =>
      frame.filter((row) => row.includes("Option ")).length;
    expect(optionRows(shrunk)).toBeLessThan(optionRows(scrolled));
    expect(shrunk.length).toBeLessThan(14);
    expect(shrunk[1]).toContain("Option 25");
    // And it went back to where it was left, rather than keeping the row the
    // shrink moved it to.
    expect(restored).toEqual(scrolled);
  });

  /** The spec's own short-terminal scenario, end to end: thirty options in the
   * eight rows it names must still put an option row on screen with the active
   * option among them. Pinned in absolute rows rather than against the chrome
   * constant, so a constant that grows too large fails here instead of moving
   * the expectation with it. */
  test("renders an option row in the eight-row terminal the spec names", async () => {
    const result = await runSelection(
      listed(30),
      [CARRIAGE_RETURN],
      undefined,
      terminalOfRows(8),
    );

    expect(result.value).toBe(1);
    expect(frameRows(result.stderr).length).toBeLessThan(8);
    expect(activeRow(result.stderr)).toBe("Option 01");
    expect(stripped(lastFrame(result.stderr))).toContain("▼ 26");
  });

  /** A list a terminal comfortably fits must be drawn whole. Ten rows and three
   * options is the case an over-large chrome constant emptied outright. */
  test("draws a short list whole in a ten-row terminal", async () => {
    const result = await runSelection(
      [
        { label: "Alpha", value: 1 },
        { label: "Beta", value: 2 },
        { label: "Gamma", value: 3 },
      ],
      [CARRIAGE_RETURN],
      false,
      terminalOfRows(10),
    );

    expect(result.value).toBe(1);
    expect(frameRows(result.stderr)).toEqual([
      "╔═ Pick one ═╗",
      "║ Alpha      ║",
      "║ Beta       ║",
      "║ Gamma      ║",
      "╚════════════╝",
      " ↑↓ move · Enter select · type to filter · Esc cancel",
    ]);
    expect(activeRow(result.stderr)).toBe("Alpha");
  });

  /**
   * The chrome itself, not just the option rows, has to stay under the
   * terminal's height — Ink reads a frame as tall as the terminal as
   * full-screen and clears the terminal when it settles. The path that reaches
   * the worst case: scroll so the window has a start of its own, shrink the
   * terminal, then choose a user-provided option so the field's panel arrives
   * on top and collapses the window.
   */
  test("keeps the chrome under the terminal after a resize into collection", async () => {
    let scrolled: readonly string[] = [];
    let collecting: readonly string[] = [];
    const result = await runSelection(
      [
        ...listed(30),
        {
          label: "Other…",
          value: 0,
          fields: [{ type: "text", name: "branch", message: "Branch" }],
        },
      ],
      [
        END,
        async (stderr) => {
          await until(() => stderr.text().includes("Other…"));
          stderr.rows = 6;
          stderr.emit("resize");
        },
        async (stderr) => {
          await until(() => stderr.text().includes("▲ 29"));
          scrolled = frameRows(stderr);
        },
        CARRIAGE_RETURN,
        async (stderr) => {
          await until(() => stderr.text().includes("Branch"));
          collecting = frameRows(stderr);
        },
        CARRIAGE_RETURN,
      ],
      undefined,
      terminalOfRows(40),
    );

    expect(result.value).toBe(0);
    // The window carried a start of its own into the shortened terminal, so
    // both the scrolled frame and the collecting frame that follows it are
    // worst cases the chrome has to stay under.
    expect(scrolled.length).toBeLessThan(6);
    // Collection collapses the window, and no stale start survives it: nothing
    // is reported hidden above rows that are not there, so one indicator is
    // drawn rather than two and the frame stays under the terminal.
    expect(collecting).toEqual([
      "╔═ Pick one ══════╗",
      "╚═══════════ ▼ 31 ╝",
      "┌─ Branch ─┐",
      "│ █        │",
      "└──────────┘",
      " Enter submit · Esc cancel",
    ]);
    expect(collecting).toHaveLength(6);
    expect(collecting.length).toBeLessThan(6 + 1);
  });

  /**
   * The panel is sized from every visible option and from an indicator carrying
   * the largest count it can reach, so ordinary navigation never resizes it.
   * Measured over the current window instead, `▼ 10` narrowing to
   * `▼ 9` took a column off the frame on a single Down press.
   */
  test("keeps the panel's width while the window scrolls under it", async () => {
    let opened = "";
    let scrolled = "";
    const result = await runSelection(
      "abcdefghijklm".split("").map((label) => ({ label, value: label })),
      [
        async (stderr) => {
          await until(() => stderr.text().includes("▼ 10"));
          opened = frameRows(stderr, "Zx")[0] as string;
        },
        DOWN,
        DOWN,
        DOWN,
        async (stderr) => {
          await until(() => stderr.text().includes("▲ 1 "));
          scrolled = frameRows(stderr, "Zx")[0] as string;
        },
        CARRIAGE_RETURN,
      ],
      undefined,
      terminalOfRows(7),
      "Zx",
    );

    expect(result.value).toBe("d");
    expect(opened).toHaveLength(13);
    // The edge picks up the count of what is now above the window, and the
    // panel keeps the width it opened with: the room for that count was held
    // from the first frame.
    expect(scrolled).toHaveLength(opened.length);
    expect(scrolled).toContain("▲ 1");
  });

  /**
   * Sizing the panel from every visible option makes the number of widths
   * measured the length of the list rather than the height of the window, so
   * the maximum is taken in one pass instead of by spreading an array into
   * `Math.max` — an argument list that long throws `RangeError`. Four hundred
   * options is well short of that limit and would pass either way; what it
   * pins is that the running maximum still finds the one wide label, and finds
   * it two hundred rows below the window that is on screen.
   */
  test("sizes a long list from its widest option, window or not", async () => {
    const wide = "Widest label in a long list";
    const long = (widest: boolean): readonly SelectOption<number>[] =>
      Array.from({ length: 400 }, (_, index) => ({
        label:
          widest && index === 300
            ? wide
            : `Option ${String(index + 1).padStart(3, "0")}`,
        value: index + 1,
      }));

    const widened = await runSelection(
      long(true),
      [CARRIAGE_RETURN],
      undefined,
      terminalOfRows(40),
    );
    expect(widened.value).toBe(1);
    expect(activeRow(widened.stderr)).toBe("Option 001");
    // The wide label is two hundred rows below the ten on screen, so its width
    // can only have come from measuring the whole visible list: twenty-seven
    // columns of label inside four columns of border.
    expect(frameRows(widened.stderr)[0]).toHaveLength(wide.length + 4);

    // The same list without it falls back to the widest row it does have: a
    // ten-column label, plus the room the edges hold for the count of
    // everything off screen.
    const plain = await runSelection(
      long(false),
      [CARRIAGE_RETURN],
      undefined,
      terminalOfRows(40),
    );
    expect(plain.value).toBe(1);
    // Ten columns of label inside four of border, widened to hold ` ▼ 390 `
    // on an edge without crushing the title out of it.
    expect(frameRows(plain.stderr)[0]).toHaveLength(20);
  });

  /**
   * The whole frame, chrome included, has to stay strictly shorter than the
   * terminal. Measured on the rendered frame rather than on the arithmetic,
   * because the arithmetic bounds only the option rows. Six rows choosing and
   * nine collecting are the tightest terminals a filter-enabled select fits
   * under; below those its minimum frame of five and eight rows cannot, which
   * is recorded as an open question on change 0020.
   */
  test.each([6, 7, 8, 9, 10, 12, 16])(
    "renders a frame shorter than a terminal of %i rows",
    async (rows) => {
      const result = await runSelection(
        listed(30),
        [CARRIAGE_RETURN],
        undefined,
        terminalOfRows(rows),
      );

      expect(frameRows(result.stderr).length).toBeLessThan(rows);
    },
  );

  test.each([9, 10, 12, 16])(
    "renders a collecting frame shorter than a terminal of %i rows",
    async (rows) => {
      let collecting: readonly string[] = [];
      await runSelection(
        [
          ...listed(30),
          {
            label: "Other…",
            value: 0,
            fields: [{ type: "text", name: "branch", message: "Branch" }],
          },
        ],
        [
          END,
          CARRIAGE_RETURN,
          async (stderr) => {
            await until(() => stderr.text().includes("Branch"));
            collecting = frameRows(stderr);
          },
          CARRIAGE_RETURN,
        ],
        undefined,
        terminalOfRows(rows),
      );

      expect(collecting.length).toBeGreaterThan(0);
      expect(collecting.length).toBeLessThan(rows);
    },
  );

  test("windows the filtered list rather than the supplied one", async () => {
    const result = await runSelection(
      mixed,
      ["alpha", END, CARRIAGE_RETURN],
      undefined,
      terminalOfRows(40),
    );

    expect(result.value).toBe(29);
    const frame = stripped(lastFrame(result.stderr));
    expect(frame).toContain("› alpha");
    expect(frame).toContain("▲ 5");
    expect(frame).toContain("Alpha 11");
    expect(activeRow(result.stderr)).toBe("Alpha 29");
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
    // No frame the dialog ever drew put the bar on the option the Down arrow
    // would have moved to.
    expect(bars(result.stderr.text())).not.toContain("Known");
    expect(activeRow(result.stderr)).toBe("Custom");
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
    expect(stdin.listenerCount("data")).toBe(0);
  });
});

describe("sub-dialog columns", () => {
  /** The key these tests open a sub-dialog with. The right arrow opens under
   * either binding — it is the direction the columns run — so a test about
   * pushing, popping, or resolving says nothing about which key Enter is
   * bound to. The bindings themselves are covered on their own below. */
  const EXPAND = RIGHT;
  const TAB = "\t";
  /** The escape sequence a terminal sends for Shift+Tab. Ink's parse-keypress
   * resolves it to the very same `tab` key report as plain Tab (see
   * node_modules/ink/build/parse-keypress.js), which is the whole reason the
   * spec requires it to open too rather than reach the filter as text. */
  const SHIFT_TAB = `${ESCAPE}[Z`;
  const tag: TextField = {
    type: "text",
    name: "tag",
    message: "Which tag?",
  };

  function expandable(): readonly SelectOption<string>[] {
    return [
      { label: "Known", value: "known" },
      {
        label: "Category",
        value: "category",
        dialog: {
          message: "Pick an item",
          options: [
            { label: "First", value: "first" },
            { label: "Second", value: "second" },
          ],
        },
      },
    ];
  }

  test("names exactly the keys the row under the bar answers", async () => {
    // A plain row at the root: Enter takes it, and there is nothing open to
    // back out of.
    const plain = await runSelection(expandable(), [CARRIAGE_RETURN], false);
    expect(plain.value).toBe("known");
    expect(frameRows(plain.stderr).at(-1)).toBe(
      " ↑↓ move · Enter select · type to filter · Esc cancel",
    );

    let onLeadingRow: string | undefined;
    let insideColumn: string | undefined;
    const opened = await runSelection(
      expandable(),
      [
        DOWN,
        async (stderr) => {
          await until(() => showsActiveRow(stderr, "Category"));
          onLeadingRow = frameRows(stderr).at(-1);
        },
        EXPAND,
        async (stderr) => {
          await until(() => showsActiveRow(stderr, "First", PANEL));
          insideColumn = frameRows(stderr, PANEL).at(-1);
        },
        CARRIAGE_RETURN,
      ],
      false,
    );
    expect(opened.value).toBe("first");
    // A row that leads somewhere is opened rather than taken, so the line
    // names opening and stops naming selection.
    expect(onLeadingRow).toBe(
      " ↑↓ move · →/Enter open · type to filter · Esc cancel",
    );
    // Inside the opened column there is a column to its left to back out
    // into, and its own rows lead nowhere further. Escape backs out here as
    // the left arrow does, so the two are named together and nothing on the
    // line claims a key cancels the dialog.
    expect(insideColumn).toBe(
      " ↑↓ move · Enter select · ←/Esc back · type to filter",
    );
  });

  test("names backing out rather than cancelling once a column is open", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let result: SelectResult<string> | undefined;
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          result = await dialogs.select({
            message: SELECT_MESSAGE,
            options: expandable(),
            filter: "typed",
          });
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stdin.rawModes.includes(true));
    await until(() => showsActiveRow(stderr, "Known"));
    // At the leftmost column Escape really does cancel, so the line offers it.
    expect(frameRows(stderr).at(-1)).toBe(
      " ↑↓ move · Enter select · type to filter · Esc cancel",
    );
    stdin.write(DOWN);
    await until(() => showsActiveRow(stderr, "Category"));
    stdin.write(EXPAND);
    await until(() => showsActiveRow(stderr, "First", PANEL));
    const nested = frameRows(stderr, PANEL).at(-1) as string;
    // The claim the reader would have acted on: Escape does not cancel from
    // here, and the line must not say it does.
    expect(nested).not.toContain("Esc cancel");
    expect(nested).toContain("←/Esc back");
    // And it is the truth: Escape backs out into the column that opened this
    // one rather than settling the dialog.
    stdin.write(ESCAPE);
    await until(() => showsActiveRow(stderr, "Category"));
    expect(frameRows(stderr).at(-1)).toBe(
      " ↑↓ move · →/Enter open · type to filter · Esc cancel",
    );
    stdin.write(ESCAPE);
    expect(await running).toBe(0);
    expect(result).toBeUndefined();
  });

  test("names backing out rather than cancelling under a text leaf", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let settled = false;
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          await dialogs.select({
            message: SELECT_MESSAGE,
            options: [{ label: "Tagged", value: "tagged", dialog: tag }],
            filter: "typed",
          });
          settled = true;
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stdin.rawModes.includes(true));
    await until(() => showsActiveRow(stderr, "Tagged"));
    stdin.write(EXPAND);
    await until(() => stripped(stderr.text()).includes("Which tag?"));
    // The push is synchronous but the entry subscribes on its mount effect;
    // wait it out so the Escape below is answered by the entry that is on
    // screen rather than swallowed before it is listening.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    // The claim the reader would have acted on: a leaf is only ever pushed
    // over the select that opened it, so its Escape always backs out and
    // there is no depth at which it cancels the dialog.
    expect(frameRows(stderr, "Which tag?").at(-1)).toBe(
      " Enter submit · Esc back",
    );
    // And it is the truth: the entry goes, the column that opened it answers
    // keys again, and nothing has settled.
    stdin.write(ESCAPE);
    await until(
      () =>
        showsActiveRow(stderr, "Tagged", PANEL) &&
        !stripped(lastFrame(stderr, PANEL)).includes("Which tag?"),
    );
    expect(settled).toBe(false);
    stdin.write(ESCAPE);
    expect(await running).toBe(0);
  });

  test("names backing out rather than cancelling under a nested collected field", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let result: SelectResult<string> | undefined;
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          result = await dialogs.select({
            message: SELECT_MESSAGE,
            options: [
              {
                label: "Category",
                value: "category",
                dialog: {
                  message: "Pick an item",
                  options: [
                    {
                      label: "Custom",
                      value: "custom",
                      fields: [
                        {
                          type: "text",
                          name: "owner",
                          message: "Which account?",
                        },
                      ],
                    },
                  ],
                },
              },
              { label: "Plain", value: "plain" },
            ],
            filter: "typed",
          });
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stdin.rawModes.includes(true));
    await until(() => showsActiveRow(stderr, "Category"));
    stdin.write(EXPAND);
    await until(() => showsActiveRow(stderr, "Custom", PANEL));
    stdin.write(CARRIAGE_RETURN);
    await until(() => stripped(stderr.text()).includes("Which account?"));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    // A collection begun in an opened column is popped with that column, so
    // its field's Escape backs out here rather than cancelling.
    expect(frameRows(stderr, "Which account?").at(-1)).toBe(
      " Enter submit · Esc back",
    );
    stdin.write(ESCAPE);
    await until(
      () =>
        showsActiveRow(stderr, "Category", PANEL) &&
        !stripped(lastFrame(stderr, PANEL)).includes("Which account?"),
    );
    // The root is answering keys again rather than having settled: the plain
    // row proves it, since the expandable one would only reopen the column.
    stdin.write(DOWN);
    await until(() => showsActiveRow(stderr, "Plain"));
    stdin.write(CARRIAGE_RETURN);
    expect(await running).toBe(0);
    expect(result?.value).toBe("plain");
  });

  test("keeps naming cancelling where Escape really cancels", async () => {
    // The other side of the same rule, so the fix cannot over-apply: a field
    // collected at the leftmost column and a standalone input both have
    // nothing to back out into, and their Escape settles the dialog.
    let rootField: string | undefined;
    const collected = await runSelection(
      [
        {
          label: "Other…",
          value: "other",
          fields: [{ type: "text", name: "branch", message: "Branch name" }],
        },
      ],
      [
        CARRIAGE_RETURN,
        async (stderr) => {
          await until(() => stripped(stderr.text()).includes("Branch name"));
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          rootField = frameRows(stderr, "Branch name").at(-1);
        },
        ESCAPE,
      ],
      false,
    );
    expect(rootField).toBe(" Enter submit · Esc cancel");
    expect(collected.value).toBeUndefined();

    let standaloneHint: string | undefined;
    const standalone = await runEntry({ message: "Branch name" }, [
      async (stderr) => {
        await until(() => stripped(stderr.text()).includes("Branch name"));
        standaloneHint = frameRows(stderr, "Branch name").at(-1);
      },
      ESCAPE,
    ]);
    expect(standaloneHint).toBe(" Enter submit · Esc cancel");
    expect(standalone.value).toBeUndefined();
  });

  test("keeps naming moving and taking when the filter matches nothing", async () => {
    // Deliberate: the line names the keys of the mode the dialog is in, not
    // the ones that happen to do something on this keystroke. Dropping these
    // phrases the moment a filter matched nothing would reflow the line as
    // the reader typed, which is exactly the churn the filter and the
    // overflow counts were set into the frame's edges to stop.
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          await dialogs.select({
            message: SELECT_MESSAGE,
            options: expandable(),
            filter: "typed",
          });
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stdin.rawModes.includes(true));
    await until(() => showsActiveRow(stderr, "Known"));
    stdin.write("zzz");
    await until(() => stripped(stderr.text()).includes("no match"));
    expect(frameRows(stderr).at(-1)).toBe(
      " ↑↓ move · Enter select · type to filter · Esc cancel",
    );
    stdin.write(ESCAPE);
    expect(await running).toBe(0);
  });

  test("binds opening to Tab when the caller asks, leaving Enter to select", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let result: SelectResult<string> | undefined;
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          result = await dialogs.select({
            message: SELECT_MESSAGE,
            options: expandable(),
            filter: "typed",
            expand: "tab",
          });
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stdin.rawModes.includes(true));
    await until(() => stripped(stderr.text()).includes("Category"));
    stdin.write(DOWN);
    await until(() => showsActiveRow(stderr, "Category"));
    // The line names the binding the caller chose, and keeps naming selection
    // because Enter still takes the row it is on.
    expect(frameRows(stderr).at(-1)).toBe(
      " ↑↓ move · →/Tab open · Enter select · type to filter · Esc cancel",
    );
    stdin.write(TAB);
    await until(() => showsActiveRow(stderr, "First", PANEL));
    stdin.write(ESCAPE);
    await until(() => showsActiveRow(stderr, "Category"));
    // Enter takes the expandable option rather than opening it, which is the
    // whole point of the binding.
    stdin.write(CARRIAGE_RETURN);
    expect(await running).toBe(0);
    expect(result?.value).toBe("category");
  });

  test("opens on Shift+Tab under the Tab binding too, the same as plain Tab", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let result: SelectResult<string> | undefined;
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          result = await dialogs.select({
            message: SELECT_MESSAGE,
            options: expandable(),
            filter: "typed",
            expand: "tab",
          });
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stdin.rawModes.includes(true));
    await until(() => stripped(stderr.text()).includes("Category"));
    stdin.write(DOWN);
    await until(() => showsActiveRow(stderr, "Category"));
    // Driven with the real terminal sequence rather than a synthesised key
    // object, so this exercises the same parse-keypress mapping a live
    // terminal would produce.
    stdin.write(SHIFT_TAB);
    await until(() => showsActiveRow(stderr, "First", PANEL));
    stdin.write(ESCAPE);
    await until(() => showsActiveRow(stderr, "Category"));
    stdin.write(CARRIAGE_RETURN);
    expect(await running).toBe(0);
    expect(result?.value).toBe("category");
  });

  test("leaves Shift+Tab inert under the Enter binding, not reaching the filter as text", async () => {
    // Under the Enter binding, key.tab does not open — the branch in
    // select.ts requires expandKey === "tab" — so the only way this could
    // misbehave is falling through to the filter as typed text. That matters
    // specifically because the sequence starts with the same bytes several
    // other escape sequences do; the rule exists to rule out exactly that.
    const cancelled = await runSelection(
      expandable(),
      [
        DOWN,
        async (stderr) => {
          await until(() => showsActiveRow(stderr, "Category"));
        },
        SHIFT_TAB,
        async (stderr) => {
          expect(showsActiveRow(stderr, "Category")).toBe(true);
          expect(stripped(lastFrame(stderr))).not.toContain("›");
        },
        ESCAPE,
      ],
      false,
    );
    expect(cancelled.value).toBeUndefined();
  });

  test("types, opens, types, and takes without touching a single arrow", async () => {
    // The whole point of typing always filtering and Enter always opening:
    // narrowing a column to the row you want and pressing Enter is the same
    // gesture at every level, and the last Enter takes the plain row it lands
    // on. No arrow key is pressed anywhere in this walk.
    const result = await runSelection(
      [
        {
          label: "apps",
          value: "apps",
          dialog: {
            message: "Apps",
            options: [{ label: "web", value: "web" }],
          },
        },
        {
          label: "packages",
          value: "packages",
          dialog: {
            message: "Packages",
            options: [
              { label: "core", value: "core" },
              {
                label: "cli",
                value: "cli",
                dialog: {
                  message: "Scripts",
                  options: [
                    { label: "build", value: "cli:build" },
                    { label: "test", value: "cli:test" },
                  ],
                },
              },
            ],
          },
        },
      ],
      ["pack", CARRIAGE_RETURN, "cli", CARRIAGE_RETURN, CARRIAGE_RETURN],
    );
    expect(result.value).toBe("cli:build");
  });

  test("opens with Enter by default", async () => {
    const result = await runSelection(
      expandable(),
      [DOWN, CARRIAGE_RETURN, CARRIAGE_RETURN],
      false,
    );
    // The first Enter opens the column the marked row leads to rather than
    // resolving with its value; the second takes the plain row it lands on.
    expect(result.value).toBe("first");
  });

  test("treats the trigger as a no-op without a declaration", async () => {
    const result = await runSelection(
      [
        { label: "Known", value: "known" },
        { label: "Other", value: "other" },
      ],
      [EXPAND, CARRIAGE_RETURN],
      false,
    );
    expect(result.value).toBe("known");
    expect(result.values).toEqual({});
  });

  test("opens from a filtered list without consuming the key as filter text", async () => {
    const options: readonly SelectOption<string>[] = [
      { label: "Alpha", value: "alpha" },
      {
        label: "Alphabet",
        value: "alphabet",
        dialog: {
          message: "Nested",
          options: [{ label: "Only", value: "only" }],
        },
      },
    ];
    const result = await runSelection(
      options,
      ["alph", DOWN, EXPAND, CARRIAGE_RETURN],
      true,
    );
    expect(result.value).toBe("only");
    expect(result.values).toEqual({});
  });

  test("opens a nested select and resolves the whole stack with its value", async () => {
    const result = await runSelection(expandable(), [
      DOWN,
      EXPAND,
      DOWN,
      CARRIAGE_RETURN,
    ]);
    expect(result.value).toBe("second");
    expect(result.values).toEqual({});
  });

  test("pops one level on Escape and cancels only at the root", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let result: SelectResult<string> | undefined;
    let settled = false;
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          result = await dialogs.select({
            message: "Pick one",
            options: expandable(),
          });
          settled = true;
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stdin.rawModes.includes(true));
    await until(() => stripped(stderr.text()).includes("Category"));
    stdin.write(DOWN);
    await until(() => activeRow(stderr) === "Category");
    stdin.write(EXPAND);
    await until(() => stripped(stderr.text()).includes("Pick an item"));
    await until(() => {
      try {
        return activeRow(stderr, "Pick an item") === "First";
      } catch {
        return false;
      }
    });
    stdin.write(ESCAPE);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await until(() => {
      try {
        return (
          activeRow(stderr) === "Category" &&
          !stripped(lastFrame(stderr)).includes("Pick an item")
        );
      } catch {
        return false;
      }
    });
    expect(settled).toBe(false);
    stdin.write(ESCAPE);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(await running).toBe(0);
    expect(result).toBeUndefined();
  });

  test("cancels at the root with Ctrl-C and pops a level with Ctrl-C above it", async () => {
    const atRoot = await runSelection(expandable(), [CTRL_C]);
    expect(atRoot.value).toBeUndefined();

    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let result: SelectResult<string> | undefined = {
      value: "open",
      values: {},
    };
    let settled = false;
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          result = await dialogs.select({
            message: "Pick one",
            options: expandable(),
          });
          settled = true;
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stdin.rawModes.includes(true));
    await until(() => stripped(stderr.text()).includes("Category"));
    stdin.write(DOWN);
    await until(() => activeRow(stderr) === "Category");
    stdin.write(EXPAND);
    await until(() => stripped(stderr.text()).includes("Pick an item"));
    await until(() => {
      try {
        return activeRow(stderr, "Pick an item") === "First";
      } catch {
        return false;
      }
    });
    stdin.write(CTRL_C);
    await until(() => {
      try {
        return (
          activeRow(stderr) === "Category" &&
          !stripped(lastFrame(stderr)).includes("Pick an item")
        );
      } catch {
        return false;
      }
    });
    expect(settled).toBe(false);
    // An expandable row is opened rather than taken, so the choice that ends
    // the session is the plain one above it — which is also what proves the
    // root is answering keys again.
    stdin.write(UP);
    await until(() => showsActiveRow(stderr, "Known"));
    stdin.write(CARRIAGE_RETURN);
    expect(await running).toBe(0);
    expect(result?.value).toBe("known");
  });

  test("resolves a text leaf with the opening value and its submitted text", async () => {
    const result = await runSelection(
      [{ label: "Tagged", value: "tagged", dialog: tag }],
      [EXPAND, "nightly", CARRIAGE_RETURN],
      false,
    );
    expect(result.value).toBe("tagged");
    expect(result.values).toEqual({ tag: "nightly" });
  });

  test("pops a text leaf on Escape and cancels only at the root", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let result: SelectResult<string> | undefined = {
      value: "stale",
      values: {},
    };
    let settled = false;
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          result = await dialogs.select({
            message: "Pick one",
            options: [{ label: "Tagged", value: "tagged", dialog: tag }],
            filter: "typed",
          });
          settled = true;
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stdin.rawModes.includes(true));
    await until(() => stripped(stderr.text()).includes("Tagged"));
    stdin.write(EXPAND);
    await until(() => stripped(stderr.text()).includes("Which tag?"));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    stdin.write(ESCAPE);
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    await until(() => {
      try {
        return (
          activeRow(stderr) === "Tagged" &&
          !stripped(lastFrame(stderr)).includes("Which tag?")
        );
      } catch {
        return false;
      }
    });
    expect(settled).toBe(false);
    stdin.write(EXPAND);
    // The push is synchronous but the reopened entry subscribes on its mount
    // effect; wait it out so the typed text is not swallowed before then.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const reopened = stderr.text().length;
    stdin.write("nightly");
    await until(() => {
      const fresh = stderr.text().slice(reopened);
      return stripped(fresh).includes("nightly");
    });
    stdin.write(CARRIAGE_RETURN);
    expect(await running).toBe(0);
    expect(result).toEqual({ value: "tagged", values: { tag: "nightly" } });
  });

  test("merges values along the path with deeper submissions winning", async () => {
    const shallow: Record<string, string> = Object.assign(
      Object.create(null) as Record<string, string>,
      { name: "shallow" },
    );
    const merged = stackedValues(shallow, "name", "deep");
    expect(merged).toEqual({ name: "deep" });
    expect(Object.getOwnPropertyDescriptor(merged, "name")?.value).toBe("deep");
    expect(stackedValues(shallow, "other", "new")).toEqual({
      name: "shallow",
      other: "new",
    });
    // The base is left untouched and stays prototype-free, so an opaque
    // caller key lands as an own value rather than reaching Object.prototype.
    expect(shallow).toEqual({ name: "shallow" });
    const proto = stackedValues({}, "__proto__", "a");
    expect(Object.getOwnPropertyDescriptor(proto, "__proto__")?.value).toBe(
      "a",
    );

    // End to end, a nested completion carries the path's values: the nested
    // option's fields resolve with the whole stack's inputs, deeper winning.
    // The field entry subscribes on its mount effect, so the test waits for
    // its frame before typing rather than racing it.
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let carried: SelectResult<string> | undefined;
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          carried = await dialogs.select({
            message: "Pick one",
            options: [
              {
                label: "Category",
                value: "category",
                dialog: {
                  message: "Nested",
                  options: [
                    {
                      label: "Custom",
                      value: "custom",
                      fields: [
                        {
                          type: "text",
                          name: "owner",
                          message: "Which account?",
                        },
                      ],
                    },
                  ],
                },
              },
            ],
            filter: "typed",
          });
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stdin.rawModes.includes(true));
    await until(() => stripped(stderr.text()).includes("Category"));
    stdin.write(EXPAND);
    await until(() => stripped(stderr.text()).includes("Nested"));
    stdin.write(CARRIAGE_RETURN);
    await until(() => stripped(stderr.text()).includes("Which account?"));
    stdin.write("fx");
    await until(() => stripped(stderr.text()).includes("fx"));
    stdin.write(CARRIAGE_RETURN);
    expect(await running).toBe(0);
    expect(carried?.value).toBe("custom");
    expect(carried?.values).toEqual({ owner: "fx" });
  });

  test("carries inputs from two levels with deeper winning a repeated name", async () => {
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
                label: "Category",
                value: "category",
                fields: [
                  { type: "text", name: "owner", message: "Which account?" },
                ],
                dialog: {
                  message: "Nested",
                  options: [
                    {
                      label: "Custom",
                      value: "custom",
                      fields: [
                        {
                          type: "text",
                          name: "owner",
                          message: "Which account below?",
                        },
                      ],
                    },
                  ],
                },
              },
            ],
            filter: "typed",
          });
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stdin.rawModes.includes(true));
    await until(() => stripped(stderr.text()).includes("Category"));
    // Open the nested level first: the field collected there completes the
    // level, and the root's own collection must no longer be reachable.
    stdin.write(EXPAND);
    await until(() => stripped(stderr.text()).includes("Nested"));
    stdin.write(CARRIAGE_RETURN);
    await until(() => stripped(stderr.text()).includes("Which account below?"));
    stdin.write("deep");
    await until(() => stripped(stderr.text()).includes("deep"));
    stdin.write(CARRIAGE_RETURN);
    expect(await running).toBe(0);
    expect(result?.value).toBe("custom");
    expect(result?.values).toEqual({ owner: "deep" });
  });
  test("keeps the retained parent row as an inverted bar", async () => {
    const options: readonly SelectOption<string>[] = [
      { label: "Known", value: "known" },
      {
        label: "ParentActiveOptionIsLong",
        value: "category",
        dialog: {
          message: "Child",
          options: [
            { label: "x", value: "x" },
            { label: "y", value: "y" },
          ],
        },
      },
    ];
    const result = await runSelection(
      options,
      [DOWN, EXPAND, CARRIAGE_RETURN],
      false,
    );
    expect(result.value).toBe("x");
    // The column behind keeps the bar on the choice it was left on, drawn
    // exactly as the driven column's own is: the same inversion, nothing
    // shading it differently, because the choice that led here is a choice.
    const drawn = bars(lastFrame(result.stderr));
    expect(drawn.length).toBe(2);
    expect(drawn).toContain("x");
    expect(drawn).toContain("ParentActiveOptionIsLong");
  });

  test("keeps a covered level's other options on screen", async () => {
    const result = await runSelection(
      [
        { label: "PeeksOutFromUnderTheChild", value: "peeks" },
        {
          label: "ParentActiveOptionIsLong",
          value: "category",
          dialog: {
            message: "Child",
            options: [{ label: "x", value: "x" }],
          },
        },
      ],
      [DOWN, EXPAND, CARRIAGE_RETURN],
      false,
    );
    expect(result.value).toBe("x");
    // A level a sub-dialog was opened over is not reduced to its active row:
    // it keeps drawing the list it was showing, so what was chosen on the way
    // down stays readable beside what is being chosen now. The child covers
    // the columns it overlaps, and the rest of the row runs on past it.
    expect(stripped(lastFrame(result.stderr))).toContain("UnderTheChild");
  });

  test("pops a nested field collection instead of cancelling the session", async () => {
    const nestedStdin = new TerminalInput();
    const nestedStderr = new CapturedOutput();
    let nestedResult: SelectResult<string> | undefined;
    const nestedRunning = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          nestedResult = await dialogs.select({
            message: "Pick one",
            options: [
              {
                label: "Category",
                value: "category",
                dialog: {
                  message: "Nested",
                  options: [
                    {
                      label: "Custom",
                      value: "custom",
                      fields: [
                        {
                          type: "text",
                          name: "owner",
                          message: "Which account?",
                        },
                      ],
                    },
                  ],
                },
              },
              { label: "Plain", value: "plain" },
            ],
            filter: "typed",
          });
        }),
      ],
      context(nestedStdin, nestedStderr),
    );
    await until(() => nestedStdin.rawModes.includes(true));
    await until(() => stripped(nestedStderr.text()).includes("Category"));
    nestedStdin.write(EXPAND);
    await until(() => stripped(nestedStderr.text()).includes("Nested"));
    nestedStdin.write(CARRIAGE_RETURN);
    await until(() => stripped(nestedStderr.text()).includes("Which account?"));
    nestedStdin.write(ESCAPE);
    await until(() => {
      try {
        return (
          activeRow(nestedStderr) === "Category" &&
          !stripped(lastFrame(nestedStderr)).includes("Nested")
        );
      } catch {
        return false;
      }
    });
    // The root answers keys again, and the plain row proves it: the
    // expandable one would reopen the column the collection was abandoned in.
    nestedStdin.write(DOWN);
    await until(() => showsActiveRow(nestedStderr, "Plain"));
    nestedStdin.write(CARRIAGE_RETURN);
    expect(await nestedRunning).toBe(0);
    expect(nestedResult?.value).toBe("plain");
    expect(nestedResult?.values).toEqual({});
  });

  test("keeps the parent filter and active option across push and pop", async () => {
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
              { label: "Alpha", value: "alpha" },
              {
                label: "Alphabet",
                value: "alphabet",
                dialog: {
                  message: "Nested",
                  options: [{ label: "Only", value: "only" }],
                },
              },
            ],
            filter: "always",
          });
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stdin.rawModes.includes(true));
    await until(() => stripped(stderr.text()).includes("Alpha"));
    stdin.write("alph");
    await until(() => activeRow(stderr) === "Alpha");
    stdin.write(DOWN);
    await until(() => activeRow(stderr) === "Alphabet");
    stdin.write(EXPAND);
    await until(() => stripped(stderr.text()).includes("Nested"));
    // The nested level starts blank while the parent keeps its own text.
    await until(() => {
      try {
        return activeRow(stderr, "Nested") === "Only";
      } catch {
        return false;
      }
    });
    stdin.write(ESCAPE);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await until(() => {
      try {
        return (
          activeRow(stderr) === "Alphabet" &&
          !stripped(lastFrame(stderr)).includes("Nested")
        );
      } catch {
        return false;
      }
    });
    // Popping restores exactly what the parent showed before it opened.
    expect(stripped(lastFrame(stderr))).toContain("alph");
    // Backing out left the column live: it still filters, still moves, and
    // still takes a plain row. The expandable one would reopen instead.
    stdin.write(UP);
    await until(() => showsActiveRow(stderr, "Alpha"));
    stdin.write(CARRIAGE_RETURN);
    expect(await running).toBe(0);
    expect(result?.value).toBe("alpha");
    // The filter text never becomes part of the result.
    expect(result?.values).toEqual({});
  });

  test("draws a sub-dialog as the next column of the same panel", async () => {
    const options: readonly SelectOption<string>[] = [
      { label: "Known", value: "known" },
      {
        label: "ParentActiveOptionIsLong",
        value: "category",
        dialog: {
          message: "Child",
          options: [
            { label: "x", value: "x" },
            { label: "y", value: "y" },
          ],
        },
      },
    ];
    const result = await runSelection(
      options,
      [DOWN, EXPAND, CARRIAGE_RETURN],
      false,
    );
    expect(result.value).toBe("x");
    const rows = frameRows(result.stderr);
    // One frame, not two: the sub-dialog has no border, no offset and no
    // shadow of its own, because it is a column of the panel its parent is
    // already in. Every row of that panel therefore opens and closes with the
    // one frame's edges.
    const inside = rows.slice(1, -2);
    expect(inside.length).toBeGreaterThan(0);
    for (const row of inside) {
      expect(row.startsWith("║")).toBe(true);
      expect(row.endsWith("║")).toBe(true);
    }
    expect(rows.filter((row) => row.startsWith("╔"))).toHaveLength(1);
    // Both lists are on screen, side by side, separated by a divider — the
    // parent is not reduced to its active row and is not covered by the child.
    const frame = stripped(lastFrame(result.stderr));
    expect(frame).toContain("Known");
    expect(frame).toContain("ParentActiveOptionIsLong");
    expect(frame).toContain("x");
    expect(frame).toContain("│");
    // The title names the trail of columns rather than one level's message.
    expect(rows[0]).toContain("Pick one › Child");
  });

  test("marks the rows that lead somewhere and leaves the rest unmarked", async () => {
    const result = await runSelection(
      expandable(),
      [DOWN, EXPAND, CARRIAGE_RETURN],
      false,
    );
    expect(result.value).toBe("first");
    const rows = frameRows(result.stderr);
    const marked = rows.filter((row) => row.includes(EXPAND_MARKER));
    // Exactly the one option that declares a sub-dialog carries the marker,
    // and it sits on the right edge of its own column rather than after its
    // label, so the markers of a column line up on one edge.
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("Category");
    expect(rows.some((row) => row.includes("Known"))).toBe(true);
    expect(
      rows.some((row) => row.includes("Known") && row.includes(EXPAND_MARKER)),
    ).toBe(false);
  });

  test("backs out of a column with the left arrow and cancels only at the root", async () => {
    const stdin = new TerminalInput();
    const stderr = new CapturedOutput();
    let result: SelectResult<string> | undefined = {
      value: "stale",
      values: {},
    };
    let settled = false;
    const running = main(
      ["choose"],
      [
        dialogsPlugin,
        consumer(async (dialogs) => {
          result = await dialogs.select({
            message: SELECT_MESSAGE,
            options: expandable(),
            filter: "typed",
          });
          settled = true;
        }),
      ],
      context(stdin, stderr),
    );
    await until(() => stdin.rawModes.includes(true));
    await until(() => stripped(stderr.text()).includes("Category"));
    // At the root the arrow has nothing to back out of, and it is Escape
    // rather than an arrow that closes the dialog, so it does nothing.
    stdin.write(LEFT);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    stdin.write(DOWN);
    await until(() => showsActiveRow(stderr, "Category"));
    stdin.write(EXPAND);
    await until(() => showsActiveRow(stderr, "First", PANEL));
    stdin.write(LEFT);
    await until(
      () =>
        showsActiveRow(stderr, "Category") &&
        !stripped(lastFrame(stderr)).includes("Pick an item"),
    );
    expect(settled).toBe(false);
    stdin.write(ESCAPE);
    expect(await running).toBe(0);
    expect(result).toBeUndefined();
  });

  test("keeps the columns inside a narrow terminal", async () => {
    const columns = 24;
    const result = await runSelection(
      expandable(),
      [DOWN, EXPAND, CARRIAGE_RETURN],
      false,
      terminalOfColumns(columns),
    );
    expect(result.value).toBe("first");
    const rows = frameRows(result.stderr, PANEL);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.length).toBeLessThanOrEqual(columns);
    }
  });

  test("cuts the last column rather than dropping it", async () => {
    const columns = 20;
    const result = await runSelection(
      [
        {
          label: "Category",
          value: "category",
          dialog: {
            message: "Sub",
            options: [{ label: "AVeryLongLeafLabel", value: "leaf" }],
          },
        },
      ],
      [EXPAND, CARRIAGE_RETURN],
      false,
      terminalOfColumns(columns),
    );
    expect(result.value).toBe("leaf");
    const rows = frameRows(result.stderr, PANEL);
    for (const row of rows) {
      expect(row.length).toBeLessThanOrEqual(columns);
    }
    // Collapsing stops at one column, so the one being driven is truncated to
    // what is left rather than dropped off the screen with the rest.
    const frame = stripped(lastFrame(result.stderr, PANEL));
    expect(frame).toContain("AVeryLong");
    expect(frame).not.toContain("AVeryLongLeafLabel");
    expect(frame).toContain("…");
  });

  test("keeps the browser shorter than a short terminal", async () => {
    const terminalRows = 10;
    const result = await runSelection(
      expandable(),
      [DOWN, EXPAND, CARRIAGE_RETURN],
      false,
      terminalOfRows(terminalRows),
    );
    expect(result.value).toBe("first");
    expect(frameRows(result.stderr).length).toBeLessThan(terminalRows);
    expect(activeRow(result.stderr, "Pick an item")).toBe("First");
  });

  test("keeps the top option row on a three-level stack", async () => {
    const deep: readonly SelectOption<string>[] = [
      { label: "Known", value: "known" },
      {
        label: "Category",
        value: "category",
        dialog: {
          message: "Middle",
          options: [
            { label: "MFirst", value: "mfirst" },
            {
              label: "Sub",
              value: "sub",
              dialog: {
                message: "Deep",
                options: [
                  { label: "D1", value: "d1" },
                  { label: "D2", value: "d2" },
                ],
              },
            },
          ],
        },
      },
    ];
    const terminalRows = 12;
    const result = await runSelection(
      deep,
      [DOWN, EXPAND, DOWN, EXPAND, CARRIAGE_RETURN],
      false,
      terminalOfRows(terminalRows),
    );
    expect(result.value).toBe("d1");
    expect(activeRow(result.stderr, PANEL)).toBe("D1");
    expect(frameRows(result.stderr, PANEL).length).toBeLessThan(terminalRows);
    // Three columns in one panel, all three still showing their own lists:
    // going deeper adds a column to the right rather than a panel over the
    // one before it, so nothing that was chosen on the way in is covered.
    const frame = stripped(lastFrame(result.stderr, PANEL));
    expect(frame).toContain("Category");
    expect(frame).toContain("MFirst");
    expect(frame).toContain("Sub");
    expect(frame).toContain("D1");
    expect(frame).toContain("D2");
    // The title is the trail of the columns on screen.
    expect(frameRows(result.stderr, PANEL)[0]).toContain(
      "Pick one › Middle › Deep",
    );
  });

  test("rejects every invalid reachable sub-request before rendering", async () => {
    const emptyNested: readonly SelectOption<number>[] = [
      {
        label: "Category",
        value: 1,
        dialog: { message: "Empty", options: [] },
      },
    ];
    const emptyFields: readonly SelectOption<number>[] = [
      {
        label: "Known",
        value: 1,
        dialog: {
          message: "Nested",
          options: [{ label: "Leaf", value: 2, fields: [] }],
        },
      },
    ];
    const repeatedName: readonly SelectOption<number>[] = [
      {
        label: "Known",
        value: 1,
        dialog: {
          message: "Nested",
          options: [
            {
              label: "Leaf",
              value: 2,
              fields: [
                { type: "text", name: "owner", message: "Which account?" },
                {
                  type: "text",
                  name: "owner",
                  message: "Which account again?",
                },
              ],
            },
          ],
        },
      },
    ];
    for (const [options, message] of [
      [emptyNested, "A select dialog requires at least one option"],
      [
        emptyFields,
        "A user-provided select option requires at least one field",
      ],
      [repeatedName, 'A select option repeats the field name "owner"'],
    ] as const) {
      const rejected = await runRejected(options);
      expect(rejected.exitCode).toBe(0);
      expect(rejected.failure).toBeInstanceOf(Error);
      expect((rejected.failure as Error).message).toBe(message);
      expect(rejected.stderr.text()).toBe("");
      expect(rejected.stdin.rawModes).toEqual([]);
    }
  });

  test("renders a cyclic sub-dialog graph without overflowing", async () => {
    type Loose = {
      readonly label: string;
      readonly value: number;
      dialog?: { readonly message: string; readonly options: Loose[] };
    };
    const loop: Loose = { label: "Loop", value: 1 };
    const nested = { message: "Nested", options: [loop] };
    loop.dialog = nested;
    // The cycle guard skips the back-edge, so validation passes and the
    // dialog renders the reachable first visit instead of overflowing. The
    // loop is opened once, backed out of, and the plain row beside it taken:
    // an option that leads somewhere is opened rather than resolved, and this
    // one leads back to itself.
    const result = await runSelection(
      [loop as SelectOption<number>, { label: "Plain", value: 2 }],
      [EXPAND, LEFT, DOWN, CARRIAGE_RETURN],
      false,
    );
    expect(result.value).toBe(2);
    expect(result.values).toEqual({});
    expect(stripped(lastFrame(result.stderr))).toContain("Loop");
  });
});

describe("Norton Commander presentation", () => {
  /** The SGR codes a dialog is allowed to emit: dim on and off, inverse on and
   * off. Any other one would be a hue, which the palette does not have. */
  /** Every sequence a dialog is allowed to emit: dimming and inversion, on and
   * off. No color code belongs in the set, which is what "no hue" means — a
   * dialog names no color at all and leaves the terminal's own foreground and
   * background wherever it is not dimming or inverting them. */
  const GREYSCALE_CODES = new Set(["2", "22", "7", "27"]);

  const SGR = new RegExp(`${ESCAPE}\\[([\\d;]*)m`, "g");

  test("draws a select in a double frame titled with its message, hints beneath", async () => {
    const result = await runSelection(
      [
        { label: "Alpha", value: "alpha" },
        { label: "Beta", value: "beta" },
        { label: "Gamma", value: "gamma" },
      ],
      [DOWN, CARRIAGE_RETURN],
      false,
    );

    expect(result.value).toBe("beta");
    expect(frameRows(result.stderr)).toEqual([
      "╔═ Pick one ═╗",
      "║ Alpha      ║",
      "║ Beta       ║",
      "║ Gamma      ║",
      "╚════════════╝",
      " ↑↓ move · Enter select · type to filter · Esc cancel",
    ]);
    expect(activeRow(result.stderr)).toBe("Beta");
  });

  test("draws a standalone input in a single frame with the caret after the value", async () => {
    const result = await runEntry(
      { message: "Branch name", initialValue: "main" },
      [CARRIAGE_RETURN],
    );

    expect(result.value).toBe("main");
    expect(frameRows(result.stderr, "Branch name")).toEqual([
      "┌─ Branch name ─┐",
      "│ main█         │",
      "└───────────────┘",
      " Enter submit · Esc cancel",
    ]);
  });

  test("names the filter in the select hints exactly when it is enabled", async () => {
    const enabled = await runSelection(
      [{ label: "Alpha", value: "alpha" }],
      [CARRIAGE_RETURN],
      true,
    );
    const enabledRows = frameRows(enabled.stderr);
    expect(enabledRows.at(-1)).toBe(
      " ↑↓ move · Enter select · type to filter · Esc cancel",
    );

    const disabled = await runSelection(
      [{ label: "Alpha", value: "alpha" }],
      [CARRIAGE_RETURN],
      false,
    );
    expect(frameRows(disabled.stderr).at(-1)).toBe(
      " ↑↓ move · Enter select · type to filter · Esc cancel",
    );
  });

  test("truncates a long label and a long title at the end within the terminal", async () => {
    const label = "L".repeat(60);
    const message = "A question long enough that forty columns cannot hold it";
    const result = await runSelection(
      [{ label, value: "long" }],
      [CARRIAGE_RETURN],
      false,
      terminalOfColumns(40),
      message,
    );

    expect(result.value).toBe("long");
    const rows = frameRows(result.stderr, "A question long");
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(40);
    expect(rows[0]).toHaveLength(40);
    expect(rows[0]?.startsWith("╔═ A question long")).toBe(true);
    // The title is cut inside the spaces that pad it into the edge, so a cut
    // one still ends a column short of the corner rather than against it.
    expect(rows[0]?.endsWith("… ╗")).toBe(true);
    // One row, ending in the renderer's ellipsis, exactly as wide as the bar.
    const active = activeRow(result.stderr, "A question long");
    expect(active).toHaveLength(36);
    expect(active.endsWith("…")).toBe(true);
    expect(active.startsWith("LLL")).toBe(true);
  });

  test("truncates entered text and filter text at the start, keeping the caret", async () => {
    const entered = await runEntry(
      { message: "Value", initialValue: "e".repeat(60) },
      [CARRIAGE_RETURN],
      new TerminalInput(),
      terminalOfColumns(40),
    );
    const valueRow = frameRows(entered.stderr, "Value")[1] as string;
    expect(valueRow).toHaveLength(40);
    expect(valueRow.startsWith("│ …")).toBe(true);
    expect(valueRow.endsWith("e█ │")).toBe(true);

    const typed = "f".repeat(40);
    const filtered = await runSelection(
      [{ label: "Alpha", value: "alpha" }],
      [typed, ESCAPE],
      true,
      terminalOfColumns(40),
    );
    expect(filtered.value).toBeUndefined();
    // The filter is set into the panel's bottom edge, and what it cannot fit
    // it cuts from its head so the caret is never what goes.
    const rows = frameRows(filtered.stderr);
    const filterRow = rows.at(-2) as string;
    expect(filterRow).toHaveLength(40);
    expect(filterRow.startsWith("╚═…")).toBe(true);
    expect(filterRow.endsWith("f█ ╝")).toBe(true);
    // The prompt is the head of the run, so start truncation is what drops it.
    expect(filterRow).not.toContain("›");
  });

  test("sizes the panel in terminal columns, not in code units", async () => {
    // Eighteen ideographs are eighteen code units and thirty-six columns, so a
    // panel sized by the string's length would truncate a label the terminal
    // has ample room for.
    const label = "界".repeat(18);
    const result = await runSelection(
      [{ label, value: "wide" }],
      [CARRIAGE_RETURN],
      false,
    );

    expect(result.value).toBe("wide");
    const rows = frameRows(result.stderr);
    expect(rows[0]).toBe(`╔═ Pick one ${"═".repeat(27)}╗`);
    expect(activeRow(result.stderr)).toBe(label);
    expect(rows[1]).toBe(`║ ${label} ║`);
  });

  test("lays out for twenty columns in a terminal narrower than that", async () => {
    const result = await runSelection(
      [{ label: "N".repeat(30), value: "narrow" }],
      [CARRIAGE_RETURN],
      false,
      terminalOfColumns(10),
    );

    expect(result.value).toBe("narrow");
    // Twenty columns is the narrowest supported terminal, so the frame is laid
    // out for twenty rather than for the ten it was told about; how the
    // terminal wraps the result is not the dialog's business.
    for (const row of frameRows(result.stderr)) {
      expect(row.length).toBeLessThanOrEqual(20);
    }
    expect(frameRows(result.stderr)[0]).toHaveLength(20);
    expect(activeRow(result.stderr)).toHaveLength(16);
  });

  test("follows the terminal width when it changes under the dialog", async () => {
    let wide = "";
    let narrow = "";
    const result = await runSelection(
      [{ label: "W".repeat(30), value: "wide" }],
      [
        async (stderr) => {
          await until(() => stderr.text().includes("WWW"));
          wide = frameRows(stderr)[0] as string;
          stderr.columns = 24;
          stderr.emit("resize");
        },
        async (stderr) => {
          await until(() => frameRows(stderr)[0]?.length === 24);
          narrow = frameRows(stderr)[0] as string;
        },
        CARRIAGE_RETURN,
      ],
      false,
    );

    expect(result.value).toBe("wide");
    expect(wide).toHaveLength(34);
    expect(narrow).toHaveLength(24);
  });

  test("spans the cursor bar across the panel a wide title made", async () => {
    // The title is wider than any label, so the frame is wider than the
    // columns need. The room left over goes to the last column, which is what
    // keeps the bar spanning the panel rather than stopping short of it.
    const result = await runSelection(
      [
        { label: "up", value: "up" },
        { label: "down", value: "down" },
      ],
      [CARRIAGE_RETURN],
      false,
      new CapturedOutput(),
      "A considerably longer question than any of its answers",
    );
    expect(result.value).toBe("up");
    const rows = frameRows(result.stderr, PANEL);
    // Every row of the frame is the panel's width, and the bar fills the
    // content columns between its borders and padding.
    expect(barWidths(lastFrame(result.stderr, PANEL))).toEqual([
      (rows[0] as string).length - 4,
    ]);
  });

  test("dims the chrome, grounds the active option, and emits no hue", async () => {
    const result = await runSelection(
      Array.from({ length: 30 }, (_, index) => ({
        label: `Option ${String(index + 1).padStart(2, "0")}`,
        value: index + 1,
      })),
      [CARRIAGE_RETURN],
      true,
      terminalOfRows(40),
    );

    const frame = lastFrame(result.stderr);
    // The frame edges, the title, the filter prompt, the overflow count, and
    // the hint line, each dimmed. The title shares the top edge's dim run,
    // which is what "set into the frame" means: one dimmed row carrying border
    // and message together — and the same holds for the bottom edge, which
    // carries the filter and the count the same way.
    expect(dimmedAt(frame, "╔═ Pick one")).toBe(true);
    expect(dimmedAt(frame, "╚═")).toBe(true);
    expect(dimmedAt(frame, "›")).toBe(true);
    expect(dimmedAt(frame, "▼ 20")).toBe(true);
    expect(dimmedAt(frame, "↑↓ move")).toBe(true);
    expect(frame).toContain(
      `${DIM_OPEN}↑↓ move · Enter select · type to filter · Esc cancel${DIM_CLOSE}`,
    );
    // What has been typed into the filter is content rather than chrome, so it
    // is the one thing on either edge that is not dimmed.
    expect(dimmedAt(frame, "█")).toBe(false);
    // The active option is the one run on the bar's ground, and it is not
    // dimmed: the label keeps the foreground every other label has, so the
    // ground is the only thing marking it.
    expect(bars(frame)).toEqual(["Option 01"]);
    expect(dimmedAt(frame, "Option 01")).toBe(false);

    const codes = [...frame.matchAll(SGR)].map(([, code]) => code as string);
    expect(codes.length).toBeGreaterThan(0);
    expect([...new Set(codes)].sort()).toEqual(
      [...GREYSCALE_CODES].sort() as string[],
    );
  });

  test("draws no frame at all when a request is rejected before rendering", async () => {
    const rejected = [
      await runRejected([]),
      await runRejected([{ label: "One", value: 1, fields: [] }]),
      await runRejected([{ label: "One", value: 1 }], new TerminalInput(false)),
      await runRejected(
        [{ label: "One", value: 1 }],
        new TerminalInput(),
        new CapturedOutput(false),
      ),
    ];
    const redirected = await runEntry(
      { message: "Redirected" },
      [],
      new TerminalInput(false),
    );

    for (const { failure, stderr } of [...rejected, redirected]) {
      expect(failure).toBeInstanceOf(Error);
      expect(stderr.text()).toBe("");
    }
  });
});

describe("dialog animations", () => {
  const CARET = "█";

  /** The 250 milliseconds the spec gives a confirmed select to settle in. It is
   * the spec's own budget rather than the implementation's, so a flash that
   * grew past what the spec allows fails here. */
  const CONFIRM_BUDGET = 250;

  /** The renderer's render throttle at its default of thirty frames a second.
   * A flash interval under it would have its ticks coalesced rather than
   * delivered, which is the difference between a blink and a stall. */
  const RENDER_THROTTLE = Math.ceil(1000 / 30);

  /** The line the filter is typed into, which is the row the caret sits on:
   * the panel's bottom edge, which is where the filter is set so that turning
   * it on never moves an option row. */
  function filterRow(stderr: CapturedOutput): string {
    const rows = frameRows(stderr);
    return rows.at(rows.at(-1)?.startsWith(" ") === true ? -2 : -1) ?? "";
  }

  /** The module the renderer schedules its one shared animation timer from.
   * Timers are told apart by the frame that called `setTimeout`, so the
   * renderer's separate render-throttle timer — scheduled from its debounce
   * helper, fired once inside its throttle window, and none of this plugin's
   * business — is never mistaken for an animation. */
  const ANIMATION_SCHEDULER = "ink/build/components/App.js";

  /**
   * Every animation timer the renderer sets while a dialog runs, and which of
   * them are still neither cleared nor fired.
   *
   * The dialogs own no timer of their own: the animation subscription is the
   * renderer's, and the unmount the cleanup contract already performs is what
   * stops it. That is exactly what makes it worth asserting — a subscription
   * the unmount missed leaves a timer waking on its own behind a dialog that
   * has already settled.
   */
  function trackTimers(): {
    readonly live: () => number;
    readonly seen: () => number;
    readonly restore: () => void;
  } {
    type TimerId = ReturnType<typeof setTimeout>;
    const live = new Set<TimerId>();
    let seen = 0;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      // Frame zero is the error's own message and frame one is this wrapper,
      // so the caller is the frame after them.
      const caller = (new Error().stack ?? "").split("\n")[2] ?? "";
      const scheduled = caller.includes(ANIMATION_SCHEDULER);
      const id: TimerId = realSetTimeout(() => {
        live.delete(id);
        handler(...args);
      }, timeout);
      if (scheduled) {
        seen++;
        live.add(id);
      }
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id?: TimerId) => {
      if (id !== undefined) live.delete(id);
      realClearTimeout(id);
    }) as typeof clearTimeout;
    return {
      live: () => live.size,
      seen: () => seen,
      restore: () => {
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
      },
    };
  }

  test("keeps every animation inside the bounds the spec sets", () => {
    // The caret's blink, between 400 and 600 milliseconds.
    expect(animationInterval).toBeGreaterThanOrEqual(400);
    expect(animationInterval).toBeLessThanOrEqual(600);
    // The flash: long enough per phase that the renderer delivers its ticks
    // rather than coalescing them, and short enough overall to settle inside
    // the budget even when the last tick arrives late.
    expect(flashInterval).toBeGreaterThanOrEqual(RENDER_THROTTLE);
    expect(flashDuration).toBeGreaterThan(flashInterval);
    expect(flashDuration).toBeLessThan(CONFIRM_BUDGET);
  });

  test("blinks the caret on and off while a select waits for input", async () => {
    const phases: string[] = [];
    const result = await runSelection(
      [
        { label: "Alpha", value: "alpha" },
        { label: "Beta", value: "beta" },
      ],
      [
        async (stderr) => {
          // Ink batches its writes, so the first frame is not on screen the
          // instant raw mode is on.
          await until(() => stderr.text().includes("Alpha"));
          // The dialog opens with its caret on screen rather than a blink away
          // from it.
          await until(() => filterRow(stderr).includes(CARET), PHASE_BUDGET);
          phases.push("shown");
          await until(() => !filterRow(stderr).includes(CARET), PHASE_BUDGET);
          phases.push("hidden");
          await until(() => filterRow(stderr).includes(CARET), PHASE_BUDGET);
          phases.push("shown");
          // The row keeps the caret's cell either way, so the panel does not
          // resize on the blink's own timer.
          expect(filterRow(stderr)).toHaveLength(
            (frameRows(stderr)[0] as string).length,
          );
        },
        CARRIAGE_RETURN,
      ],
      true,
    );

    expect(phases).toEqual(["shown", "hidden", "shown"]);
    expect(result.value).toBe("alpha");
  });

  test("shows a keystroke and its caret on the render after it, mid-blink", async () => {
    let typed = "";
    const result = await runEntry({ message: "Branch" }, [
      async (stderr, stdin) => {
        await until(() => stderr.text().includes("Branch"));
        // Wait out the visible phase, so the keystroke lands while the caret
        // is hidden — the phase the spec's scenario names.
        await until(
          () => !stripped(lastFrame(stderr, "Branch")).includes(CARET),
          PHASE_BUDGET,
        );
        stdin.write("x");
        await until(() => stripped(lastFrame(stderr, "Branch")).includes("x"));
        typed = frameRows(stderr, "Branch")[1] as string;
      },
      CARRIAGE_RETURN,
    ]);

    // The very next render carries the typed character with the caret after
    // it: a keystroke is never answered by a row that looks like it lost one.
    expect(typed).toContain(`x${CARET}`);
    expect(result.value).toBe("x");
  });

  test("pulses the overflow indicator only while rows are hidden", async () => {
    const phases: string[] = [];
    const overflowing = await runSelection(
      listed(30),
      [
        async (stderr) => {
          await until(() => stderr.text().includes("▼ 20"));
          const indicator = () => dimmedAt(lastFrame(stderr), "▼ 20");
          await until(() => indicator() === true, PHASE_BUDGET);
          phases.push("dim");
          await until(() => indicator() === false, PHASE_BUDGET);
          phases.push("normal");
        },
        CARRIAGE_RETURN,
      ],
      false,
      terminalOfRows(40),
    );

    expect(phases).toEqual(["dim", "normal"]);
    expect(overflowing.value).toBe(1);

    // Nothing is hidden, so there is no indicator to pulse and no phase of the
    // dialog it could appear in.
    const whole = await runSelection(
      listed(3),
      [CARRIAGE_RETURN],
      false,
      terminalOfRows(40),
    );
    expect(whole.stderr.text()).not.toContain("▼");
    expect(whole.stderr.text()).not.toContain("▲");
  });

  test("flashes the confirmed bar, ignores Escape, and settles inside the budget", async () => {
    let elapsed = 0;
    let barsWhileFlashing: readonly string[] = [];
    const result = await runSelection(
      [
        { label: "Alpha", value: "alpha" },
        { label: "Beta", value: "beta" },
        { label: "Gamma", value: "gamma" },
      ],
      [
        DOWN,
        async (stderr, stdin) => {
          await until(() => stderr.text().includes("Gamma"));
          await until(() => bars(lastFrame(stderr))[0] === "Beta");
          const confirmedAt = performance.now();
          stdin.write(CARRIAGE_RETURN);
          // The bar blinks off on the flash's odd frames, which is the flash.
          await until(() => bars(lastFrame(stderr)).length === 0);
          barsWhileFlashing = bars(lastFrame(stderr));
          // "and then Escape 50 milliseconds later": still well inside the
          // flash, and the choice is already made.
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          stdin.write(ESCAPE);
          await until(() => stdin.rawModes.includes(false));
          elapsed = performance.now() - confirmedAt;
        },
      ],
      false,
    );

    expect(barsWhileFlashing).toEqual([]);
    // Escape changed nothing: the second option is still what settled.
    expect(result.value).toBe("beta");
    expect(result.values).toEqual({});
    // The flash ran its course, and the dialog settled inside the budget on
    // elapsed time rather than on a frame that may never be delivered.
    expect(elapsed).toBeGreaterThanOrEqual(flashDuration);
    expect(elapsed).toBeLessThan(CONFIRM_BUDGET);
    // The bar is back on the option that was taken by the time the dialog
    // leaves the screen.
    expect(activeRow(result.stderr)).toBe("Beta");
  });

  test("stops the filter's caret once the row stops taking input", async () => {
    let choosing = "";
    let collecting: readonly string[] = [];
    const result = await runSelection(
      [
        { label: "Known", value: "known" },
        {
          label: "Other…",
          value: "other",
          fields: [{ type: "text", name: "branch", message: "Branch name" }],
        },
      ],
      [
        DOWN,
        async (stderr) => {
          await until(() => stderr.text().includes("Other…"));
          await until(() => filterRow(stderr).includes(CARET), PHASE_BUDGET);
          choosing = filterRow(stderr);
        },
        CARRIAGE_RETURN,
        "abc",
        async (stderr) => {
          await until(() => stderr.text().includes("abc"));
          collecting = frameRows(stderr);
        },
        CARRIAGE_RETURN,
      ],
      true,
    );

    expect(result.value).toBe("other");
    expect(result.values).toEqual({ branch: "abc" });
    // While the filter still answers keystrokes it carries a caret.
    expect(choosing).toContain(CARET);
    // Once a field is collected the filter declines every edit, so its row
    // keeps its text and gives up its caret — one caret on screen, on the row
    // that is actually being typed into. Typing into the field resets the
    // shared phase, so a filter caret would otherwise blink in lockstep with
    // the field's on a row whose keystrokes are dropped.
    // The filter sits in the select panel's own bottom edge, under the list it
    // filters and above the field's panel.
    const filter = collecting.find((row) => row.includes("›")) as string;
    const field = collecting.at(-3) as string;
    expect(filter).toBeDefined();
    expect(filter).not.toContain(CARET);
    expect(field).toContain(`abc${CARET}`);
    // The cell the caret gave up is still there, so the panel kept its width.
    expect(filter).toHaveLength((collecting[0] as string).length);
  });

  test("settles at once when the terminal leaves no bar to flash", async () => {
    let elapsed = 0;
    const result = await runSelection(
      listed(30),
      [
        async (stderr, stdin) => {
          await until(() => stderr.text().includes("▼ 30"));
          // No option row fits, so no cursor bar is drawn.
          expect(bars(lastFrame(stderr))).toEqual([]);
          const confirmedAt = performance.now();
          stdin.write(CARRIAGE_RETURN);
          await until(() => stdin.rawModes.includes(false));
          elapsed = performance.now() - confirmedAt;
        },
      ],
      undefined,
      // One row short of what a choosing select needs for its first option
      // row, so the window collapses to nothing.
      terminalOfRows(4),
    );

    expect(result.value).toBe(1);
    // Flashing a bar that is not on screen would be dead time with every key
    // ignored, so the outcome settles without waiting one out.
    expect(elapsed).toBeLessThan(flashDuration);
  });

  test("writes nothing while a static select idles", async () => {
    let idle = "";
    let after = "";
    const result = await runSelection(
      [
        { label: "Alpha", value: "alpha" },
        { label: "Beta", value: "beta" },
        { label: "Gamma", value: "gamma" },
      ],
      [
        async (stderr) => {
          await until(() => stderr.text().includes("Gamma"));
          idle = stderr.text();
          // Two full blink phases: a dialog with a caret or an indicator on
          // screen would have rewritten its frame twice over by now.
          await new Promise<void>((resolve) =>
            setTimeout(resolve, animationInterval * 2),
          );
          after = stderr.text();
        },
        CARRIAGE_RETURN,
      ],
      false,
      terminalOfRows(40),
    );

    expect(after).toBe(idle);
    // Nothing on screen animates: no filter caret, and nothing hidden.
    expect(stripped(idle)).not.toContain(CARET);
    expect(result.value).toBe("alpha");
  });

  test("leaves no timer running once a dialog has unmounted", async () => {
    const probe = trackTimers();
    let seen = 0;
    /** Every exit path is checked against the timers its own dialog set, not
     * against the ones an earlier dialog set: a guard that only counted the
     * running total would be satisfied by the first case for all three. */
    const animated = () => {
      expect(probe.seen()).toBeGreaterThan(seen);
      seen = probe.seen();
      return probe.live();
    };
    try {
      // Completion, through the confirmation flash, so the flash's own timer
      // has to be gone as well as the caret's.
      const completed = await runSelection(
        [
          { label: "Alpha", value: "alpha" },
          { label: "Beta", value: "beta" },
        ],
        [CARRIAGE_RETURN],
        true,
      );
      expect(completed.value).toBe("alpha");
      expect(animated()).toBe(0);

      // Cancellation, from a select whose caret and indicator were both live.
      const cancelled = await runSelection(listed(30), [ESCAPE], true);
      expect(cancelled.value).toBeUndefined();
      expect(animated()).toBe(0);

      // Failure: a terminal that cannot be restored rejects the dialog after
      // it has rendered and animated.
      const stdin = new TerminalInput();
      stdin.failRawModeDisable = true;
      const failed = await runEntry(
        { message: "Teardown" },
        ["x", CARRIAGE_RETURN],
        stdin,
      );
      expect(failed.failure).toBeInstanceOf(Error);
      expect(animated()).toBe(0);
    } finally {
      probe.restore();
    }
  });
});
