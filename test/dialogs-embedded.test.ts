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
const PAGE_DOWN = `${ESCAPE}[6~`;

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
 * host's own widgets would set it from inside. `committed` answers the state
 * the last committed render was made with: the host is the root, and a
 * parent's effects run after its children's, so once it reports a state every
 * input subscription that state turned on already exists. */
function controlled<S>(
  { react }: Host,
  initial: S,
  render: (state: S) => Rendered,
): {
  readonly View: () => Rendered;
  set(next: S): void;
  committed(): S;
} {
  let update: ((next: S) => void) | undefined;
  let committed = initial;
  return {
    View: () => {
      const [state, setState] = react.useState(initial);
      update = setState;
      react.useEffect(() => {
        committed = state;
      }, [state]);
      return render(state);
    },
    set(next: S) {
      (update as (next: S) => void)(next);
    },
    committed: () => committed,
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
      // A fixed pause alone is a race: on a loaded runner the activated
      // render may not have committed, and a key pressed before the select's
      // input subscription exists is dropped. The pause after it still gives
      // a differing frame the time to be written.
      await until(() => focus.committed());
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

  test("a component drawn over the host's own rows covers exactly the cells each row draws", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<number>(host.dialogs);
      const Input = inputComponent(host.dialogs);
      const covered = "X".repeat(70);
      // Ten rows of the host's own text, with the two components drawn back
      // over them: a select of six rows over the first six, an input of four
      // over the rest. The select's hint line is wider than its frame; the
      // input's frame is wider than its hint line.
      const View = () =>
        host.react.createElement(
          host.ink.Box,
          { flexDirection: "column" },
          host.react.createElement(host.ink.Text, null, "Host header"),
          ...Array.from({ length: 10 }, (_, at) =>
            host.react.createElement(
              host.ink.Text,
              { key: `covered-${at}` },
              covered,
            ),
          ),
          host.react.createElement(
            host.ink.Box,
            { flexDirection: "column", marginTop: -10 },
            host.react.createElement(Select, {
              request: { message: "Pick", options: labelled("A", "B", "C") },
              width: 70,
              height: 6,
              isActive: true,
              ...recorder<SelectResult<number>>(),
            }),
            host.react.createElement(Input, {
              request: { message: "Name the branch this work lands on" },
              width: 70,
              isActive: false,
              ...recorder<string>(),
            }),
          ),
        );
      const terminal = session(host, View);
      await until(() => terminal.output.text().includes("Esc cancel"));
      const rows = frameRows(terminal.output, "Host header");
      expect(rows).toHaveLength(11);

      const selectHint = "↑↓ move · Enter select · type to filter · Esc cancel";
      const selectHintWidth = Bun.stringWidth(selectHint) + 1;
      expect(rows[1]?.startsWith("╔═ Pick ═")).toBe(true);
      const selectFrame = rows[1]?.indexOf("X") ?? -1;
      expect(selectFrame).toBeLessThan(selectHintWidth);
      // Every frame row ends at the closing border, the host's text showing
      // straight after it rather than under blank cells out to the hint.
      for (const row of rows.slice(1, 6)) {
        expect(row.indexOf("X")).toBe(selectFrame);
        expect("╗║╝").toContain(row[selectFrame - 1] as string);
      }
      // The hint line covers its leading column and its own characters, and
      // the host's text resumes at once after the last of them.
      expect(rows[6]).toBe(` ${selectHint}${"X".repeat(70 - selectHintWidth)}`);

      const inputHint = "Enter submit · Esc cancel";
      const inputHintWidth = Bun.stringWidth(inputHint) + 1;
      expect(
        rows[7]?.startsWith("┌─ Name the branch this work lands on ─"),
      ).toBe(true);
      const inputFrame = rows[7]?.indexOf("X") ?? -1;
      expect(inputFrame).toBeGreaterThan(inputHintWidth);
      for (const row of rows.slice(7, 10)) {
        expect(row.indexOf("X")).toBe(inputFrame);
        expect("┐│┘").toContain(row[inputFrame - 1] as string);
      }
      // Under a frame wider than it, the hint line still stops at its last
      // character, and its leading column is covered rather than left.
      expect(rows[10]).toBe(` ${inputHint}${"X".repeat(70 - inputHintWidth)}`);
      await terminal.close();
    });
  });

  /** A select whose one option collects a text field, drawn over seven rows
   * of the host's own text — the select's edges and its option, then the
   * entry's edges, its value row, and its hint line where one is drawn — with
   * the field already open. */
  async function collectedOver(
    host: Host,
    message: string,
    field: string,
    keyHints = true,
  ): Promise<readonly string[]> {
    const Select = selectComponent<number>(host.dialogs);
    const covered = "X".repeat(70);
    const View = () =>
      host.react.createElement(
        host.ink.Box,
        { flexDirection: "column" },
        host.react.createElement(host.ink.Text, null, "Host header"),
        ...Array.from({ length: 7 }, (_, at) =>
          host.react.createElement(
            host.ink.Text,
            { key: `covered-${at}` },
            covered,
          ),
        ),
        host.react.createElement(
          host.ink.Box,
          { flexDirection: "column", marginTop: -7, height: 7 },
          host.react.createElement(Select, {
            request: {
              message,
              options: [
                {
                  label: "Own",
                  value: 1,
                  fields: [{ type: "text", name: "owner", message: field }],
                },
              ],
            },
            width: 70,
            height: 8,
            isActive: true,
            keyHints,
            ...recorder<SelectResult<number>>(),
          }),
        ),
      );
    const terminal = session(host, View);
    await until(() => activeRow(terminal.output, "Host header") === "Own");
    await terminal.press(CARRIAGE_RETURN);
    await until(() => terminal.output.text().includes(`┌─ ${field} ─`));
    const rows = frameRows(terminal.output, "Host header");
    await terminal.close();
    return rows;
  }

  test("an entry under a select paints only its own rows", async () => {
    const entryKeys = "Enter submit · Esc cancel";
    const entryKeysWidth = Bun.stringWidth(entryKeys) + 1;
    await hosted(async (host) => {
      // An entry wider than the select's frame: the select's rows end at its
      // own border, and the entry's at its, further right.
      const rows = await collectedOver(
        host,
        "Pick",
        "Name the owner of this choice",
      );
      expect(rows).toHaveLength(8);
      expect(rows[1]?.startsWith("╔═ Pick ═")).toBe(true);
      expect(rows[4]?.startsWith("┌─ Name the owner of this choice ─")).toBe(
        true,
      );
      const selectFrame = rows[1]?.indexOf("X") ?? -1;
      const entryFrame = rows[4]?.indexOf("X") ?? -1;
      expect(selectFrame).toBeLessThan(entryFrame);
      expect(entryFrame).toBeGreaterThan(entryKeysWidth);
      for (const row of rows.slice(1, 4)) {
        expect(row.indexOf("X")).toBe(selectFrame);
        expect("╗║╝").toContain(row[selectFrame - 1] as string);
      }
      for (const row of rows.slice(4, 7)) {
        expect(row.indexOf("X")).toBe(entryFrame);
        expect("┐│┘").toContain(row[entryFrame - 1] as string);
      }
      expect(rows[7]).toBe(` ${entryKeys}${"X".repeat(70 - entryKeysWidth)}`);
    });
    await hosted(async (host) => {
      // A select's frame wider than the entry: the entry's rows end at its own
      // border and hint line, with the host's text beside them under the
      // wider frame.
      const rows = await collectedOver(
        host,
        "Pick the option that applies here",
        "Owner",
      );
      expect(rows).toHaveLength(8);
      expect(
        rows[1]?.startsWith("╔═ Pick the option that applies here ═"),
      ).toBe(true);
      expect(rows[4]?.startsWith("┌─ Owner ─")).toBe(true);
      const selectFrame = rows[1]?.indexOf("X") ?? -1;
      const entryFrame = rows[4]?.indexOf("X") ?? -1;
      expect(entryFrame).toBeLessThan(entryKeysWidth);
      expect(entryKeysWidth).toBeLessThan(selectFrame);
      for (const row of rows.slice(1, 4)) {
        expect(row.indexOf("X")).toBe(selectFrame);
        expect("╗║╝").toContain(row[selectFrame - 1] as string);
      }
      for (const row of rows.slice(4, 7)) {
        expect(row.indexOf("X")).toBe(entryFrame);
        expect("┐│┘").toContain(row[entryFrame - 1] as string);
      }
      expect(rows[7]).toBe(` ${entryKeys}${"X".repeat(70 - entryKeysWidth)}`);
    });
  });

  test("a select without key hints gives the hint line's row to its options", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<number>(host.dialogs);
      const terminal = session(host, () =>
        host.react.createElement(Select, {
          request: { message: "Pick one", options: listed(30) },
          width: 60,
          height: 9,
          isActive: true,
          keyHints: false,
          ...recorder<SelectResult<number>>(),
        }),
      );
      await until(() => activeRow(terminal.output, "Pick one") === "Option 01");
      const rows = frameRows(terminal.output, "Pick one");
      // Nine rows in all: two edges and seven option rows, the row a hint
      // line would have taken given to the window.
      expect(rows).toHaveLength(9);
      expect(rows.filter((row) => row.includes("Option "))).toHaveLength(7);
      expect(rows.at(-1)).toContain("▼ 23");
      for (const row of rows) {
        expect(row).not.toContain("move");
        expect(row).not.toContain("Esc cancel");
      }
      // Page Down moves by the window it draws, which is seven rows tall.
      await terminal.press(PAGE_DOWN);
      await until(() => activeRow(terminal.output, "Pick one") === "Option 08");
      await terminal.close();
    });
  });

  test("a component without key hints is laid out in its frame's width alone", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<number>(host.dialogs);
      const selectHint = "↑↓ move · Enter select · type to filter · Esc cancel";
      const besideMarker = async (keyHints: boolean | undefined) => {
        // The host's marker follows the select in a row, so it starts at the
        // first column past the width the select is laid out in.
        const terminal = session(host, () =>
          host.react.createElement(
            host.ink.Box,
            { flexDirection: "row" },
            host.react.createElement(Select, {
              request: { message: "Pick", options: labelled("A", "B") },
              width: 70,
              height: 8,
              isActive: true,
              ...(keyHints === undefined ? {} : { keyHints }),
              ...recorder<SelectResult<number>>(),
            }),
            host.react.createElement(host.ink.Text, null, "@"),
          ),
        );
        await until(() => activeRow(terminal.output, "╔═ Pick") === "A");
        const [top] = frameRows(terminal.output, "╔═ Pick");
        await terminal.close();
        return top as string;
      };
      const hidden = await besideMarker(false);
      expect(hidden.indexOf("@")).toBe(hidden.indexOf("╗") + 1);
      const shown = await besideMarker(undefined);
      expect(shown.indexOf("╗") + 1).toBeLessThan(Bun.stringWidth(selectHint));
      expect(shown.indexOf("@")).toBe(Bun.stringWidth(selectHint) + 1);
    });
  });

  test("components without key hints hide the host's rows only under their frames", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<number>(host.dialogs);
      const Input = inputComponent(host.dialogs);
      const covered = "X".repeat(70);
      // Ten rows of the host's own text: a select of five rows over the
      // first five, one row the host leaves to itself, an input of three
      // rows, and the host's last row under that. The overlay is held to the
      // ten rows it is drawn over, so the host's last row stays in its layout.
      const View = () =>
        host.react.createElement(
          host.ink.Box,
          { flexDirection: "column" },
          host.react.createElement(host.ink.Text, null, "Host header"),
          ...Array.from({ length: 10 }, (_, at) =>
            host.react.createElement(
              host.ink.Text,
              { key: `covered-${at}` },
              covered,
            ),
          ),
          host.react.createElement(
            host.ink.Box,
            { flexDirection: "column", marginTop: -10, height: 10 },
            host.react.createElement(Select, {
              request: { message: "Pick", options: labelled("A", "B", "C") },
              width: 70,
              height: 6,
              isActive: true,
              keyHints: false,
              ...recorder<SelectResult<number>>(),
            }),
            host.react.createElement(host.ink.Box, { height: 1 }),
            host.react.createElement(Input, {
              request: { message: "Name the branch" },
              width: 70,
              isActive: false,
              keyHints: false,
              ...recorder<string>(),
            }),
          ),
        );
      const terminal = session(host, View);
      await until(() => activeRow(terminal.output, "Host header") === "A");
      await until(() =>
        terminal.output.text().includes("┌─ Name the branch ─"),
      );
      const rows = frameRows(terminal.output, "Host header");
      expect(rows).toHaveLength(11);
      expect(rows[1]?.startsWith("╔═ Pick ═")).toBe(true);
      expect(rows[7]?.startsWith("┌─ Name the branch ─")).toBe(true);
      const selectFrame = rows[1]?.indexOf("X") ?? -1;
      for (const row of rows.slice(1, 6)) {
        expect(row.indexOf("X")).toBe(selectFrame);
        expect("╗║╝").toContain(row[selectFrame - 1] as string);
        expect(row.slice(selectFrame)).toBe("X".repeat(70 - selectFrame));
      }
      const inputFrame = rows[7]?.indexOf("X") ?? -1;
      for (const row of rows.slice(7, 10)) {
        expect(row.indexOf("X")).toBe(inputFrame);
        expect("┐│┘").toContain(row[inputFrame - 1] as string);
        expect(row.slice(inputFrame)).toBe("X".repeat(70 - inputFrame));
      }
      // Under each bottom edge the host's own row is untouched: no hint line
      // was drawn there to hide it.
      expect(rows[6]).toBe(covered);
      expect(rows[10]).toBe(covered);
      await terminal.close();
    });
  });

  test("an entry collected without key hints draws no hint line of its own", async () => {
    await hosted(async (host) => {
      const rows = await collectedOver(host, "Pick", "Owner", false);
      // The select's three rows and the entry's three: the host's last row is
      // left to it.
      expect(rows).toHaveLength(8);
      expect(rows[4]?.startsWith("┌─ Owner ─")).toBe(true);
      expect(rows.some((row) => row.includes("Enter submit"))).toBe(false);
      expect(rows.some((row) => row.includes("Esc"))).toBe(false);
      expect(rows[7]).toBe("X".repeat(70));
    });
    /** The option rows a select of `height` rows shows while a field is
     * collected under it. */
    const collectingWindow = async (host: Host, keyHints: boolean) => {
      const Select = selectComponent<number>(host.dialogs);
      const height = 12;
      const terminal = session(host, () =>
        host.react.createElement(Select, {
          request: {
            message: "Pick one",
            options: [
              {
                label: "Own",
                value: 0,
                fields: [{ type: "text", name: "owner", message: "Owner" }],
              },
              ...listed(30),
            ],
          },
          width: 60,
          height,
          isActive: true,
          keyHints,
          ...recorder<SelectResult<number>>(),
        }),
      );
      await until(() => activeRow(terminal.output, "Pick one") === "Own");
      await terminal.press(CARRIAGE_RETURN);
      await until(() => terminal.output.text().includes("┌─ Owner ─"));
      const rows = frameRows(terminal.output, "Pick one");
      await terminal.close();
      expect(rows).toHaveLength(height);
      expect(rows.some((row) => row.includes("Enter submit"))).toBe(keyHints);
      // Every row between the select's edges is an option row.
      return rows.filter((row) => row.startsWith("║")).length;
    };
    await hosted(async (host) => {
      // The entry's hint line is the row handed back: twelve rows hold six
      // options with it and seven without.
      expect(await collectingWindow(host, true)).toBe(12 - 6);
      expect(await collectingWindow(host, false)).toBe(12 - 5);
    });
  });

  test("a text leaf opened without key hints draws no hint line of its own", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<number>(host.dialogs);
      const calls = recorder<SelectResult<number>>();
      const terminal = session(host, () =>
        host.react.createElement(Select, {
          request: {
            message: "Pick one",
            options: [
              {
                label: "Rename",
                value: 1,
                dialog: { type: "text", name: "name", message: "New name" },
              },
            ],
          },
          width: 60,
          height: 10,
          isActive: true,
          keyHints: false,
          ...calls,
        }),
      );
      await until(
        () =>
          activeRow(terminal.output, "Pick one")?.startsWith("Rename") === true,
      );
      await terminal.press(RIGHT);
      await until(() => terminal.output.text().includes("┌─ New name ─"));
      const rows = frameRows(terminal.output, "Pick one");
      // The select's three rows and the leaf's three, the leaf's bottom edge
      // last.
      expect(rows).toHaveLength(6);
      expect(rows[3]?.startsWith("┌─ New name ─")).toBe(true);
      expect(rows.at(-1)?.startsWith("└")).toBe(true);
      expect(rows.some((row) => row.includes("Esc back"))).toBe(false);
      expect(rows.some((row) => row.includes("Enter submit"))).toBe(false);
      await terminal.close();
    });
  });

  test("keyHints true draws exactly what leaving it out draws", async () => {
    await hosted(async (host) => {
      const Select = selectComponent<number>(host.dialogs);
      const Input = inputComponent(host.dialogs);
      const drawn = async (keyHints: true | undefined) => {
        const terminal = session(host, () =>
          host.react.createElement(
            host.ink.Box,
            { flexDirection: "column" },
            host.react.createElement(host.ink.Text, null, "Host header"),
            host.react.createElement(Select, {
              request: { message: "Pick one", options: listed(30) },
              width: 60,
              height: 9,
              isActive: false,
              ...(keyHints === undefined ? {} : { keyHints }),
              ...recorder<SelectResult<number>>(),
            }),
            host.react.createElement(Input, {
              request: { message: "Name" },
              width: 60,
              isActive: false,
              ...(keyHints === undefined ? {} : { keyHints }),
              ...recorder<string>(),
            }),
          ),
        );
        await until(() => terminal.output.text().includes("Enter submit"));
        const rows = frameRows(terminal.output, "Host header");
        await terminal.close();
        return rows;
      };
      const explicit = await drawn(true);
      expect(explicit).toHaveLength(1 + 9 + 4);
      expect(explicit).toEqual(await drawn(undefined));
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
      // Waited for rather than paused for: a fixed pause is a race, because
      // a key pressed before the activated render commits is dropped.
      await until(() => focus.committed());
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
