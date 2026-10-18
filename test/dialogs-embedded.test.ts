import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type {
  Dialogs,
  InputProps,
  SelectOption,
  SelectProps,
  SelectRequest,
  SelectResult,
} from "@fx/tx/dialogs";
import { animationInterval } from "../plugins/dialogs/animation.ts";
import dialogsPlugin from "../plugins/dialogs/index.ts";
import themePlugin from "../plugins/theme/index.ts";
import { main } from "../src/cli.ts";
import type { CoreDependencies, PluginDefinition } from "../src/plugin.ts";
import { coreDependencies } from "../src/plugins.ts";

/**
 * The embedded dialogs, driven the way a host plugin drives them: a plugin
 * whose command reads `@fx/tx/dialogs` while it runs, renders an interface of
 * its own through the `ink.render` it was injected with, and places the
 * dialog's components inside it. The host owns that render session and the
 * terminal it draws on; the command's own streams are captured separately, so
 * a component that wrote anywhere but through its host's session would show
 * up there.
 */

const ESCAPE = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const CARRIAGE_RETURN = "\r";
const DOWN = `${ESCAPE}[B`;
const RIGHT = `${ESCAPE}[C`;

/** The caret drawn after text under entry. */
const CARET = "█";

/** The host's own terminal: what its render session reads keys from. */
class HostInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  rawModeChanges = 0;

  setRawMode(enabled: boolean): this {
    this.isRaw = enabled;
    this.rawModeChanges++;
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

/** The host's own terminal: what its render session draws on. */
class HostOutput extends PassThrough {
  readonly isTTY = true;
  columns = 120;
  rows = 40;
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

/** A command stream nothing is meant to reach. */
class Untouched extends PassThrough {
  readonly isTTY = true;
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

/** What a host holds while its command runs. */
type Host = {
  readonly dialogs: Dialogs;
  readonly react: CoreDependencies["react"];
  readonly ink: CoreDependencies["ink"];
};

/** What the injected React's `createElement` returns, which is what a host
 * casts a component's `unknown` to. */
type Rendered = ReturnType<CoreDependencies["react"]["createElement"]>;

/** The cast the plugin guide shows a host making once, where it calls
 * `createElement`: the contract types the component as returning `unknown`
 * so it names no React type, and the host, which holds the injected React,
 * says what that is. */
function selectComponent<T>(
  dialogs: Dialogs,
): (props: SelectProps<T>) => Rendered {
  return dialogs.Select as (props: SelectProps<T>) => Rendered;
}

function inputComponent(dialogs: Dialogs): (props: InputProps) => Rendered {
  return dialogs.Input as (props: InputProps) => Rendered;
}

/**
 * Runs `scenario` inside a host plugin's command, with the dialogs and the
 * injected React and Ink in hand, and answers what the command's own streams
 * received. A failed expectation inside the scenario is carried out and thrown
 * again here rather than left to become an exit code.
 */
async function hosted(scenario: (host: Host) => Promise<void>): Promise<{
  readonly exitCode: number;
  readonly commandOutput: string;
}> {
  const stdout = new Untouched();
  const stderr = new Untouched();
  let failure: { readonly reason: unknown } | undefined;
  const host: PluginDefinition = {
    identity: { name: "host" },
    load:
      () =>
      ({ command, dependencies, registrations }) => {
        command((namespace) =>
          namespace.action(async () => {
            const [dialogs] = registrations<Dialogs>("@fx/tx/dialogs");
            if (!dialogs) throw new Error("dialogs capability missing");
            try {
              await scenario({
                dialogs,
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

/** A host session on a terminal of its own, rendering `View`. */
function session(
  { react, ink }: Host,
  View: () => Rendered,
  output = new HostOutput(),
) {
  const input = new HostInput();
  const renderer = ink.render(react.createElement(View), {
    stdout: output as unknown as NodeJS.WriteStream,
    stdin: input as unknown as NodeJS.ReadStream,
    stderr: output as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
  });
  let exited = false;
  const exit = renderer.waitUntilExit().then(
    () => {
      exited = true;
    },
    (reason: unknown) => {
      exited = true;
      throw reason;
    },
  );
  return {
    input,
    output,
    renderer,
    exit,
    exited: () => exited,
    /** Writes one chunk and lets the session answer it. */
    async press(chunk: string): Promise<void> {
      input.write(chunk);
      await pause(5);
    },
    async close(): Promise<void> {
      renderer.unmount();
      await exit;
    },
  };
}

/** A host widget answering keys of its own, as a host's interface does
 * whichever of its panels has focus. It is what keeps the session reading its
 * input while every dialog in it is inactive, and it records what reached it. */
function hostKeys({ react, ink }: Host, seen: string[]): Rendered {
  const Keys = () => {
    ink.useInput((input) => {
      seen.push(input);
    });
    return null;
  };
  return react.createElement(Keys);
}

/** A host component whose state the test sets from outside, the way the
 * host's own widgets would set it from inside. */
function controlled<S>(
  { react }: Host,
  initial: S,
  render: (state: S) => Rendered,
): { readonly View: () => Rendered; set(next: S): void } {
  let update: ((next: S) => void) | undefined;
  return {
    View: () => {
      const [state, setState] = react.useState(initial);
      update = setState;
      return render(state);
    },
    set(next: S) {
      (update as (next: S) => void)(next);
    },
  };
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** Generous for the same reason the function form's own tests are: none of
 * what this waits behind is an animation. */
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

const CONTROL_SEQUENCE = new RegExp(`${ESCAPE}\\[[\\d;?]*[a-zA-Z]`, "g");
const CURSOR_SEQUENCE = new RegExp(`${ESCAPE}\\[[\\d;?]*[A-Za-ln-z]`, "g");

function stripped(text: string): string {
  return text.replace(CONTROL_SEQUENCE, "");
}

/** The frame the session left on screen, from the start of the row carrying
 * `anchor`'s last occurrence: Ink rewrites its whole output on every render,
 * and every frame these tests read opens with that row. */
function lastFrame(output: HostOutput, anchor: string): string {
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

function frameRows(output: HostOutput, anchor: string): readonly string[] {
  const rows = stripped(lastFrame(output, anchor)).split("\n");
  while (rows.at(-1) === "") rows.pop();
  return rows;
}

/** The text of every inverted run in `frame`: the cursor bars. */
function bars(frame: string): readonly string[] {
  const runs: string[] = [];
  const sequences = new RegExp(`${ESCAPE}\\[([\\d;]*)m`, "g");
  for (const line of frame.split("\n")) {
    let inverse = false;
    let carried: string | undefined;
    let cursor = 0;
    const take = (piece: string) => {
      if (inverse && piece !== "") carried = (carried ?? "") + piece;
    };
    const close = () => {
      if (carried !== undefined) runs.push(carried.trim());
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

/** The one cursor bar on screen in a single-column select. */
function activeRow(output: HostOutput, anchor: string): string | undefined {
  try {
    return bars(lastFrame(output, anchor)).at(-1);
  } catch {
    return undefined;
  }
}

function labelled(...labels: readonly string[]): SelectOption<number>[] {
  return labels.map((label, index) => ({ label, value: index + 1 }));
}

function listed(count: number): SelectOption<number>[] {
  return Array.from({ length: count }, (_, index) => ({
    label: `Option ${String(index + 1).padStart(2, "0")}`,
    value: index + 1,
  }));
}

/** Every call a component made back to its host, in order. */
function recorder<R>() {
  const calls: (
    | { readonly type: "submit"; readonly result: R }
    | { readonly type: "cancel" }
  )[] = [];
  return {
    calls,
    onSubmit: (result: R) => calls.push({ type: "submit", result }),
    onCancel: () => calls.push({ type: "cancel" }),
  };
}

describe("embedded dialog components", () => {
  test("every read of the capability yields the same components", async () => {
    let first: Dialogs | undefined;
    let second: Dialogs | undefined;
    const reader: PluginDefinition = {
      identity: { name: "reader" },
      load:
        () =>
        ({ command, registrations }) => {
          command((namespace) =>
            namespace.action(() => {
              [first] = registrations<Dialogs>("@fx/tx/dialogs");
              [second] = registrations<Dialogs>("@fx/tx/dialogs");
            }),
          );
        },
    };
    expect(
      await main(["reader"], [themePlugin, dialogsPlugin, reader], {
        cwd: "/work",
        env: {},
        stdin: new HostInput() as unknown as NodeJS.ReadStream,
        stdout: new Untouched() as unknown as NodeJS.WriteStream,
        stderr: new Untouched() as unknown as NodeJS.WriteStream,
      }),
    ).toBe(0);
    expect(typeof first?.Select).toBe("function");
    expect(typeof first?.Input).toBe("function");
    expect(second?.Select).toBe(first?.Select as Dialogs["Select"]);
    expect(second?.Input).toBe(first?.Input as Dialogs["Input"]);
  });

  test("a host embeds a select and is called back once with the choice", async () => {
    const { exitCode, commandOutput } = await hosted(async (host) => {
      const Select = selectComponent<number>(host.dialogs);
      const calls = recorder<SelectResult<number>>();
      const View = () =>
        host.react.createElement(
          host.ink.Box,
          { flexDirection: "column" },
          host.react.createElement(host.ink.Text, null, "Host header"),
          host.react.createElement(Select, {
            request: {
              message: "Pick one",
              options: labelled("Alpha", "Beta", "Gamma"),
            },
            width: 40,
            height: 8,
            isActive: true,
            ...calls,
          }),
        );
      const terminal = session(host, View);
      await until(() => activeRow(terminal.output, "Host header") === "Alpha");
      await terminal.press(DOWN);
      await until(() => activeRow(terminal.output, "Host header") === "Beta");
      const before = terminal.output.text().length;
      await terminal.press(CARRIAGE_RETURN);
      await until(() => calls.calls.length > 0);
      // The bar flashed between the Enter and the call: some frame drawn in
      // between shows the taken row without its inversion.
      const flashed = terminal.output
        .text()
        .slice(before)
        .split("Host header")
        .slice(1);
      expect(flashed.some((frame) => !bars(frame).includes("Beta"))).toBe(true);
      expect(activeRow(terminal.output, "Host header")).toBe("Beta");
      await pause(animationInterval);
      expect(calls.calls).toHaveLength(1);
      const [call] = calls.calls;
      expect(call?.type).toBe("submit");
      const result = (call as { result: SelectResult<number> }).result;
      expect(result.value).toBe(2);
      expect({ ...result.values }).toEqual({});
      // The host's session is the host's: the dialog settling ends nothing.
      expect(terminal.exited()).toBe(false);
      expect(frameRows(terminal.output, "Host header")[1]).toContain(
        "Pick one",
      );
      await terminal.close();
    });
    expect(exitCode).toBe(0);
    expect(commandOutput).toBe("");
  });

  test("a height bounds the window as a terminal one row taller would", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<number>(host.dialogs);
      const terminal = session(host, () =>
        host.react.createElement(Select, {
          request: { message: "Pick one", options: listed(30) },
          width: 60,
          height: 9,
          isActive: true,
          ...recorder<SelectResult<number>>(),
        }),
      );
      await until(() => activeRow(terminal.output, "Pick one") === "Option 01");
      const rows = frameRows(terminal.output, "Pick one");
      // Nine rows in all: two edges, six option rows, and the hint line —
      // the window `select` shows in a terminal of ten rows.
      expect(rows).toHaveLength(9);
      expect(rows.filter((row) => row.includes("Option "))).toHaveLength(6);
      expect(rows.at(-2)).toContain("▼ 24");
      await terminal.close();
    });
  });

  test("a height affording no option row still navigates and submits", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<number>(host.dialogs);
      const calls = recorder<SelectResult<number>>();
      const terminal = session(host, () =>
        host.react.createElement(Select, {
          request: {
            message: "Pick one",
            options: labelled("Alpha", "Beta", "Gamma"),
          },
          width: 60,
          height: 3,
          isActive: true,
          ...calls,
        }),
      );
      await until(() => terminal.output.text().includes("Pick one"));
      const rows = frameRows(terminal.output, "Pick one");
      expect(rows).toHaveLength(3);
      expect(rows.join("\n")).not.toContain("Alpha");
      await terminal.press(DOWN);
      await terminal.press(CARRIAGE_RETURN);
      await until(() => calls.calls.length > 0);
      expect(calls.calls).toHaveLength(1);
      expect(calls.calls[0]).toMatchObject({
        type: "submit",
        result: { value: 2 },
      });
      await terminal.close();
    });
  });

  test("a width bounds the frame whatever the terminal is", async () => {
    await hosted(async (host) => {
      const Input = inputComponent(host.dialogs);
      const message = `Describe ${"the change ".repeat(5)}`.slice(0, 60);
      expect(message).toHaveLength(60);
      const output = new HostOutput();
      output.columns = 120;
      const terminal = session(
        host,
        () =>
          host.react.createElement(Input, {
            request: { message },
            width: 30,
            isActive: true,
            ...recorder<string>(),
          }),
        output,
      );
      await until(() => terminal.output.text().includes("┌"));
      const rows = frameRows(terminal.output, "┌");
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(30);
      expect(rows[0]).toContain("…");
      await terminal.close();
    });
  });

  test("only the active component takes keys, and an inactive one draws no caret", async () => {
    await hosted(async (host) => {
      const Input = inputComponent(host.dialogs);
      const first = recorder<string>();
      const second = recorder<string>();
      const terminal = session(host, () =>
        host.react.createElement(
          host.ink.Box,
          { flexDirection: "column" },
          host.react.createElement(Input, {
            request: { message: "First" },
            width: 40,
            isActive: true,
            ...first,
          }),
          host.react.createElement(Input, {
            request: { message: "Second", initialValue: "idle" },
            width: 40,
            isActive: false,
            ...second,
          }),
        ),
      );
      await until(() => terminal.output.text().includes("Second"));
      await terminal.press("x");
      await until(() => stripped(terminal.output.text()).includes(`x${CARET}`));
      // A second of nothing: the first input's caret blinks, the second's
      // never appears on any frame.
      await pause(animationInterval * 2);
      const all = stripped(terminal.output.text());
      expect(all).not.toContain(`idle${CARET}`);
      expect(all).not.toContain("idlex");
      expect(all).not.toContain("xidle");
      const rows = frameRows(terminal.output, "First");
      expect(rows.some((row) => row.includes("idle"))).toBe(true);
      expect(rows.some((row) => /│ x[█ ]/.test(row))).toBe(true);
      expect(first.calls).toEqual([]);
      expect(second.calls).toEqual([]);
      await terminal.close();
    });
  });

  test("an inactive select runs no timer, even with an indicator to pulse", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<number>(host.dialogs);
      const terminal = session(host, () =>
        host.react.createElement(Select, {
          request: {
            message: "Pick one",
            options: listed(30),
            filter: "always",
          },
          width: 60,
          height: 9,
          isActive: false,
          ...recorder<SelectResult<number>>(),
        }),
      );
      await until(() => terminal.output.text().includes("Pick one"));
      await pause(animationInterval / 5);
      const settled = terminal.output.text().length;
      await pause(animationInterval * 2);
      expect(terminal.output.text().length).toBe(settled);
      // No caret in the filter, whose cell is still held blank.
      expect(stripped(lastFrame(terminal.output, "Pick one"))).not.toContain(
        CARET,
      );
      expect(stripped(lastFrame(terminal.output, "Pick one"))).toContain("› ");
      await terminal.close();
    });
  });

  test("moving focus moves nothing, and the first key after it is answered", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<number>(host.dialogs);
      const calls = recorder<SelectResult<number>>();
      const seen: string[] = [];
      const focus = controlled(host, false, (isActive) =>
        host.react.createElement(
          host.ink.Box,
          { flexDirection: "column" },
          hostKeys(host, seen),
          host.react.createElement(host.ink.Text, null, "Host header"),
          host.react.createElement(Select, {
            request: {
              message: "Pick one",
              options: labelled("Alpha", "Beta", "Gamma"),
            },
            width: 40,
            height: 8,
            isActive,
            ...calls,
          }),
          host.react.createElement(host.ink.Text, null, "Host footer"),
        ),
      );
      const terminal = session(host, focus.View);
      await until(() => activeRow(terminal.output, "Host header") === "Alpha");
      const inactive = frameRows(terminal.output, "Host header");
      // Inactive, a key reaches the host's session and nothing in the select.
      await terminal.press("q");
      await until(() => seen.includes("q"));
      await terminal.press(DOWN);
      await pause(animationInterval / 5);
      expect(activeRow(terminal.output, "Host header")).toBe("Alpha");
      // Focus arriving draws nothing new: the renderer writes only a frame
      // that differs, and an active select at rest draws what it drew
      // inactive.
      focus.set(true);
      await pause(animationInterval / 5);
      expect(frameRows(terminal.output, "Host header")).toEqual(inactive);
      await terminal.press(DOWN);
      await until(() => activeRow(terminal.output, "Host header") === "Beta");
      const active = frameRows(terminal.output, "Host header");
      expect(active).toHaveLength(inactive.length);
      expect(active.at(-1)).toBe("Host footer");
      expect(calls.calls).toEqual([]);
      await terminal.close();
    });
  });

  test("a re-render with a new width keeps the filter and the active option", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<number>(host.dialogs);
      const calls = recorder<SelectResult<number>>();
      const sized = controlled(host, 60, (width) =>
        host.react.createElement(Select, {
          request: {
            message: "Pick one",
            options: labelled(
              "Alpha release candidate with a long label",
              "Beta",
              "Alfalfa sprouts from a long-winded label",
              "Gamma",
            ),
          },
          width,
          height: 12,
          isActive: true,
          // Fresh callbacks on every render, which must not cost the
          // component anything.
          onSubmit: (result: SelectResult<number>) => calls.onSubmit(result),
          onCancel: () => calls.onCancel(),
        }),
      );
      const terminal = session(host, sized.View);
      await until(() => terminal.output.text().includes("Pick one"));
      await terminal.press("a");
      await terminal.press("l");
      await terminal.press(DOWN);
      await until(() =>
        (activeRow(terminal.output, "Pick one") ?? "").startsWith("Alfalfa"),
      );
      const wide = frameRows(terminal.output, "Pick one");
      expect(Math.max(...wide.map((row) => row.length))).toBeGreaterThan(40);
      const length = terminal.output.text().length;
      sized.set(30);
      await until(() => terminal.output.text().length > length);
      await until(() => {
        const rows = frameRows(terminal.output, "Pick one");
        return Math.max(...rows.map((row) => row.length)) <= 30;
      });
      const narrow = frameRows(terminal.output, "Pick one");
      expect(narrow.join("\n")).toContain("› al");
      expect(activeRow(terminal.output, "Pick one")).toStartWith("Alfalfa");
      expect(narrow.join("\n")).not.toContain("Beta");
      await terminal.press(CARRIAGE_RETURN);
      await until(() => calls.calls.length > 0);
      expect(calls.calls[0]).toMatchObject({
        type: "submit",
        result: { value: 3 },
      });
      await terminal.close();
    });
  });

  test("an invalid request fails the host's render before drawing anything", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<number>(host.dialogs);
      const request: SelectRequest<number> = { message: "Empty", options: [] };
      let rejection: unknown;
      try {
        await host.dialogs.select(request);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      const terminal = session(host, () =>
        host.react.createElement(Select, {
          request,
          width: 40,
          height: 8,
          isActive: true,
          ...recorder<SelectResult<number>>(),
        }),
      );
      let failure: unknown;
      try {
        await terminal.exit;
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe((rejection as Error).message);
      expect(terminal.output.text()).not.toContain("╔");
      expect(stripped(terminal.output.text())).not.toContain("Empty ═");
    });
  });

  test("a finished input takes no more keys and keeps its last frame", async () => {
    await hosted(async (host) => {
      const Input = inputComponent(host.dialogs);
      const calls = recorder<string>();
      const terminal = session(host, () =>
        host.react.createElement(Input, {
          request: { message: "Name" },
          width: 40,
          isActive: true,
          onSubmit: (value: string) => calls.onSubmit(value),
          onCancel: () => calls.onCancel(),
        }),
      );
      await until(() => terminal.output.text().includes("Name"));
      await terminal.press("ab");
      await terminal.press(CARRIAGE_RETURN);
      await until(() => calls.calls.length > 0);
      await terminal.press("cd");
      await terminal.press("ef");
      await terminal.press(CARRIAGE_RETURN);
      await terminal.press(ESCAPE);
      await terminal.press(CTRL_C);
      await pause(animationInterval / 5);
      expect(calls.calls).toEqual([{ type: "submit", result: "ab" }]);
      const all = stripped(terminal.output.text());
      expect(all).not.toContain("abc");
      expect(all).not.toContain("abe");
      expect(frameRows(terminal.output, "Name").join("\n")).toContain("ab");
      // Its last frame stays put: the caret stopped blinking with it.
      const settled = terminal.output.text().length;
      await pause(animationInterval * 2);
      expect(terminal.output.text().length).toBe(settled);
      expect(terminal.exited()).toBe(false);
      await terminal.close();
    });
  });

  test("a finished select takes no more keys, however often its host renders", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<number>(host.dialogs);
      const calls = recorder<SelectResult<number>>();
      const renders = controlled(host, 0, (count) =>
        host.react.createElement(
          host.ink.Box,
          { flexDirection: "column" },
          host.react.createElement(host.ink.Text, null, `Render ${count}`),
          host.react.createElement(Select, {
            request: {
              message: "Pick one",
              options: labelled("Alpha", "Beta"),
            },
            width: 40,
            height: 8,
            isActive: true,
            onSubmit: (result: SelectResult<number>) => calls.onSubmit(result),
            onCancel: () => calls.onCancel(),
          }),
        ),
      );
      const terminal = session(host, renders.View);
      await until(() => activeRow(terminal.output, "Render 0") === "Alpha");
      await terminal.press(CARRIAGE_RETURN);
      await until(() => calls.calls.length > 0);
      for (let count = 1; count <= 3; count++) {
        renders.set(count);
        await until(() => terminal.output.text().includes(`Render ${count}`));
      }
      await terminal.press(DOWN);
      await terminal.press(ESCAPE);
      await pause(animationInterval / 5);
      expect(calls.calls).toEqual([
        { type: "submit", result: { value: 1, values: {}, selected: [1] } },
      ]);
      expect(activeRow(terminal.output, "Render 3")).toBe("Alpha");
      await terminal.close();
    });
  });

  test("Escape closes an opened column, then cancels at the root", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<string>(host.dialogs);
      const calls = recorder<SelectResult<string>>();
      const terminal = session(host, () =>
        host.react.createElement(Select, {
          request: {
            message: "Pick one",
            options: [
              {
                label: "Fruit",
                value: "fruit",
                dialog: {
                  message: "Which fruit",
                  options: [{ label: "Apple", value: "apple" }],
                },
              },
            ],
          },
          width: 60,
          height: 10,
          isActive: true,
          ...calls,
        }),
      );
      await until(() => terminal.output.text().includes("Fruit"));
      await terminal.press(RIGHT);
      await until(() => terminal.output.text().includes("Which fruit"));
      await terminal.press(ESCAPE);
      await until(() =>
        stripped(lastFrame(terminal.output, "Pick one")).includes("Esc cancel"),
      );
      expect(calls.calls).toEqual([]);
      await terminal.press(ESCAPE);
      await until(() => calls.calls.length > 0);
      await pause(animationInterval / 5);
      expect(calls.calls).toEqual([{ type: "cancel" }]);
      await terminal.close();
    });
  });

  test("Ctrl-C a host's session delivers cancels as the function form does", async () => {
    await hosted(async (host) => {
      const Input = inputComponent(host.dialogs);
      const calls = recorder<string>();
      const terminal = session(host, () =>
        host.react.createElement(Input, {
          request: { message: "Name", initialValue: "kept" },
          width: 40,
          isActive: true,
          ...calls,
        }),
      );
      await until(() => terminal.output.text().includes("Name"));
      await terminal.press(CTRL_C);
      await until(() => calls.calls.length > 0);
      expect(calls.calls).toEqual([{ type: "cancel" }]);
      await terminal.close();
    });
  });

  test("focus returning with a field open keeps Escape backing out of its column", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<string>(host.dialogs);
      const calls = recorder<SelectResult<string>>();
      const focus = controlled(host, true, (isActive) =>
        host.react.createElement(Select, {
          request: {
            message: "Pick one",
            options: [
              {
                label: "Fruit",
                value: "fruit",
                dialog: {
                  message: "Which fruit",
                  options: [
                    {
                      label: "Other",
                      value: "other",
                      fields: [{ type: "text", name: "kind", message: "Kind" }],
                    },
                  ],
                },
              },
            ],
          },
          width: 60,
          height: 14,
          isActive,
          ...calls,
        }),
      );
      const terminal = session(host, focus.View);
      await until(() => terminal.output.text().includes("Fruit"));
      await terminal.press(RIGHT);
      await until(() => terminal.output.text().includes("Which fruit"));
      await terminal.press(CARRIAGE_RETURN);
      await until(() => terminal.output.text().includes("Kind"));
      focus.set(false);
      await pause(animationInterval / 5);
      // Inactive, the field draws no caret.
      expect(stripped(lastFrame(terminal.output, "Pick one"))).not.toContain(
        CARET,
      );
      focus.set(true);
      await pause(animationInterval / 5);
      await terminal.press(ESCAPE);
      await until(() =>
        stripped(lastFrame(terminal.output, "Pick one")).includes("Esc cancel"),
      );
      expect(calls.calls).toEqual([]);
      await terminal.press(RIGHT);
      await until(() =>
        stripped(lastFrame(terminal.output, "Pick one")).includes(
          "Which fruit",
        ),
      );
      await terminal.press(CARRIAGE_RETURN);
      await terminal.press("pear");
      await terminal.press(CARRIAGE_RETURN);
      await until(() => calls.calls.length > 0);
      expect(calls.calls).toHaveLength(1);
      expect(calls.calls[0]).toMatchObject({
        type: "submit",
        result: { value: "other", values: { kind: "pear" } },
      });
      await terminal.close();
    });
  });

  test("the function forms still reject a missing request before taking the terminal", async () => {
    const stdin = new HostInput();
    const stderr = new Untouched();
    const failures: unknown[] = [];
    const caller: PluginDefinition = {
      identity: { name: "caller" },
      load:
        () =>
        ({ command, registrations }) => {
          command((namespace) =>
            namespace.action(async () => {
              const [dialogs] = registrations<Dialogs>("@fx/tx/dialogs");
              // An untyped consumer passing nothing at all.
              const untyped = dialogs as unknown as {
                input(request?: unknown): Promise<unknown>;
                select(request?: unknown): Promise<unknown>;
              };
              for (const ask of [untyped.input, untyped.select]) {
                try {
                  await ask.call(untyped);
                } catch (error) {
                  failures.push(error);
                }
              }
            }),
          );
        },
    };
    expect(
      await main(["caller"], [themePlugin, dialogsPlugin, caller], {
        cwd: "/work",
        env: {},
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: new Untouched() as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      }),
    ).toBe(0);
    expect(failures).toHaveLength(2);
    for (const failure of failures) expect(failure).toBeInstanceOf(TypeError);
    expect(stdin.rawModeChanges).toBe(0);
    expect(stderr.text()).toBe("");
  });

  test("a cancelled select keeps its last frame rather than blinking on", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<number>(host.dialogs);
      const calls = recorder<SelectResult<number>>();
      const terminal = session(host, () =>
        host.react.createElement(Select, {
          request: {
            message: "Pick one",
            options: listed(30),
            filter: "always",
          },
          width: 60,
          height: 9,
          isActive: true,
          ...calls,
        }),
      );
      await until(() => terminal.output.text().includes("Pick one"));
      await terminal.press(ESCAPE);
      await until(() => calls.calls.length > 0);
      await pause(animationInterval / 5);
      const settled = terminal.output.text().length;
      await pause(animationInterval * 2);
      expect(terminal.output.text().length).toBe(settled);
      expect(calls.calls).toEqual([{ type: "cancel" }]);
      expect(terminal.exited()).toBe(false);
      await terminal.close();
    });
  });
});
