import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { animationInterval } from "../plugins/dialogs/animation.ts";
import dialogsPlugin from "../plugins/dialogs/index.ts";
import themePlugin from "../plugins/theme/index.ts";
import { defaultTheme, themeVariables } from "../plugins/theme/variables.ts";
import { main } from "../src/cli.ts";
import type { CommandContext, PluginDefinition } from "../src/plugin.ts";
import { captureContext } from "./helpers.ts";

/** The local structural contract a consumer of the theme capability declares
 * for itself, exactly as the dialogs plugin does: the capability is internal,
 * so nothing about theming is imported across a plugin boundary. */
type Appearance = {
  readonly dim?: boolean;
  readonly bold?: boolean;
  readonly inverse?: boolean;
  readonly hue?: string;
};

type ThemeVariable = keyof typeof defaultTheme;

type Theme = {
  appearance(variable: ThemeVariable): Appearance;
};

type Theming = {
  theme(
    stream: { readonly isTTY?: boolean },
    options?: { readonly colour?: boolean },
  ): Theme;
};

type ThemeOverride = Partial<Record<ThemeVariable, Appearance>>;

/** A terminal, so colour enablement never decides against a test that is not
 * about colour. */
const terminal = { isTTY: true } as const;

/** A plugin contributing one override under the key overrides belong to. */
function overriding(
  name: string,
  override: ThemeOverride,
  fail = false,
): PluginDefinition {
  return {
    identity: { name },
    load:
      () =>
      ({ register }) => {
        register<ThemeOverride>("theme-override", override);
        if (fail) throw new Error(`${name} failed`);
      },
  };
}

/**
 * The theming capability as a command sees it, with the given plugins composed
 * after the theme plugin unless they are listed before it.
 *
 * The read happens inside a command action rather than during the consumer's
 * own initialization, which is the only place it can see every provider: the
 * registry shows a plugin only what committed before it.
 */
async function obtainTheming(
  plugins: readonly PluginDefinition[] = [],
  env: Record<string, string | undefined> = {},
): Promise<{ readonly theming: Theming; readonly failures: string }> {
  let theming: Theming | undefined;
  let count = -1;
  const consumer: PluginDefinition = {
    identity: { name: "surface" },
    load:
      () =>
      ({ command, registrations }) => {
        command((namespace) =>
          namespace.action(() => {
            const registered = registrations<Theming>("theme");
            count = registered.length;
            theming = registered[0];
          }),
        );
      },
  };
  const context = captureContext(env);
  expect(
    await main(["surface"], [themePlugin, ...plugins, consumer], context),
  ).toBe(0);
  expect(count).toBe(1);
  if (!theming) throw new Error("The theme capability was not registered");
  return { theming, failures: context.stderrText() };
}

/** A command context whose streams claim to be terminals, so the dialogs
 * plugin's interactive-stream check passes and its theme read is what fails. */
function interactiveContext(): CommandContext {
  const stream = { isTTY: true, write: () => true };
  return {
    cwd: "/work",
    env: {},
    stdin: stream as unknown as NodeJS.ReadStream,
    stdout: stream as unknown as NodeJS.WriteStream,
    stderr: stream as unknown as NodeJS.WriteStream,
    plugin: { name: "test" },
  };
}

/** The failure a dialog raises when the theme it needs is not composed exactly
 * once, driven through a real command rather than through the helper, so the
 * count in the message is the count the registry actually held. */
async function dialogFailure(
  providers: readonly PluginDefinition[],
): Promise<unknown> {
  let failure: unknown;
  const consumer: PluginDefinition = {
    identity: { name: "choose" },
    load:
      () =>
      ({ command, registrations }) => {
        command((namespace) =>
          namespace.action(async () => {
            const [dialogs] = registrations<{
              select(request: {
                readonly message: string;
                readonly options: readonly { readonly label: string }[];
              }): Promise<unknown>;
            }>("dialogs");
            if (!dialogs) throw new Error("dialogs capability missing");
            try {
              await dialogs.select({
                message: "Pick one",
                options: [{ label: "Alpha" }],
              });
            } catch (error) {
              failure = error;
            }
          }),
        );
      },
  };
  expect(
    await main(
      ["choose"],
      [...providers, dialogsPlugin, consumer],
      interactiveContext(),
    ),
  ).toBe(0);
  return failure;
}

/** A terminal the dialogs plugin will accept as standard input. Ink drives it
 * through raw mode and the process reference, so both have to answer. */
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

/** A terminal that keeps everything written to it, so a test can read the
 * styling sequences the renderer emitted. */
class CapturedOutput extends PassThrough {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
  #written = "";

  constructor() {
    super();
    this.on("data", (chunk) => {
      this.#written += String(chunk);
    });
  }

  text(): string {
    return this.#written;
  }
}

const ESCAPE = String.fromCharCode(27);
/** The sequences a bold run and a red run open with, built from the escape
 * character rather than written literally so the source carries no control
 * character. */
const BOLD_OPEN = `${ESCAPE}[1m`;
const RED_OPEN = `${ESCAPE}[31m`;

/** Long enough for a dialog to open and put its first frame on screen under a
 * loaded runner, written in the constant the dialogs animate on so it can never
 * come to race them. */
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

/**
 * The bytes a real select dialog wrote to its standard error, with the given
 * plugins composed after the theme plugin.
 *
 * This is the only assertion that the theme reaches the screen. Every other
 * test here reads the capability directly, and the dialogs suite proves the
 * default renders what it always did — but a `createFrame` that ignored the
 * theme entirely would satisfy both. Driving one override through the renderer
 * is what rules that out.
 */
async function renderedSelect(
  plugins: readonly PluginDefinition[],
  env: Record<string, string | undefined> = {},
): Promise<string> {
  const stdin = new TerminalInput();
  const stderr = new CapturedOutput();
  const consumer: PluginDefinition = {
    identity: { name: "choose" },
    load:
      () =>
      ({ command, registrations }) => {
        command((namespace) =>
          namespace.action(async () => {
            const [dialogs] = registrations<{
              select(request: {
                readonly message: string;
                readonly options: readonly { readonly label: string }[];
              }): Promise<unknown>;
            }>("dialogs");
            if (!dialogs) throw new Error("dialogs capability missing");
            await dialogs.select({
              message: "Pick one",
              options: [{ label: "Alpha" }],
            });
          }),
        );
      },
  };
  const running = main(
    ["choose"],
    [themePlugin, ...plugins, dialogsPlugin, consumer],
    {
      cwd: "/work",
      env,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: new CapturedOutput() as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    },
  );
  await until(() => stdin.rawModes.includes(true));
  stdin.write("\r");
  expect(await running).toBe(0);
  return stderr.text();
}

describe("bundled theme provider", () => {
  test("registers one namespace-free capability", async () => {
    expect(Object.isFrozen(themePlugin)).toBe(true);
    expect(Object.isFrozen(themePlugin.identity)).toBe(true);

    const context = captureContext();
    expect(await main(["--help"], [themePlugin], context)).toBe(0);
    expect(context.stdoutText()).not.toContain("theme");
  });

  test("resolves the greyscale default for every variable", async () => {
    const { theming } = await obtainTheming();
    const theme = theming.theme(terminal);

    expect(themeVariables).toEqual([
      "chrome",
      "content",
      "cursor",
      "marker",
      "muted",
      "strong",
      "positive",
      "caution",
      "danger",
    ]);
    for (const variable of themeVariables) {
      expect(theme.appearance(variable)).toEqual(defaultTheme[variable]);
    }
    expect(theme.appearance("chrome")).toEqual({ dim: true });
    expect(theme.appearance("content")).toEqual({});
    expect(theme.appearance("cursor")).toEqual({ inverse: true });
    expect(theme.appearance("strong")).toEqual({ bold: true });
  });

  test("names no hue anywhere in the default theme", async () => {
    const { theming } = await obtainTheming();
    const theme = theming.theme(terminal, { colour: true });

    for (const variable of themeVariables) {
      expect(theme.appearance(variable).hue).toBeUndefined();
    }
  });

  test("leaves every unspecified variable alone under a partial override", async () => {
    const { theming } = await obtainTheming([
      overriding("states", { danger: { hue: "red" } }),
    ]);
    const theme = theming.theme(terminal);

    expect(theme.appearance("danger")).toEqual({ hue: "red" });
    for (const variable of themeVariables) {
      if (variable === "danger") continue;
      expect(theme.appearance(variable)).toEqual(defaultTheme[variable]);
    }
  });

  test("applies an override contributed after the theme plugin", async () => {
    const { theming } = await obtainTheming([
      overriding("later", { chrome: { hue: "blue" } }),
    ]);

    expect(theming.theme(terminal).appearance("chrome")).toEqual({
      hue: "blue",
    });
  });

  test("lets the last override of a variable win, in commit order", async () => {
    const { theming } = await obtainTheming([
      overriding("first", { chrome: { hue: "blue" }, cursor: { bold: true } }),
      overriding("second", { chrome: { hue: "green" } }),
    ]);
    const theme = theming.theme(terminal);

    expect(theme.appearance("chrome")).toEqual({ hue: "green" });
    expect(theme.appearance("cursor")).toEqual({ bold: true });
  });

  /** An override replaces a variable's appearance rather than merging into it,
   * because an absent field means the attribute is not applied rather than
   * inherited — so an override is able to turn the default's dim off. */
  test("replaces a variable's appearance rather than merging into it", async () => {
    const { theming } = await obtainTheming([
      overriding("plain", { chrome: {} }),
    ]);

    expect(theming.theme(terminal).appearance("chrome")).toEqual({});
  });

  test("drops the override of a plugin that failed initialization", async () => {
    const { theming, failures } = await obtainTheming([
      overriding("broken", { chrome: { hue: "red" } }, true),
      overriding("healthy", { danger: { hue: "yellow" } }),
    ]);
    const theme = theming.theme(terminal);

    expect(failures).toContain("Error loading plugin broken: broken failed");
    expect(theme.appearance("chrome")).toEqual(defaultTheme.chrome);
    expect(theme.appearance("danger")).toEqual({ hue: "yellow" });
  });

  test("keeps dim, bold, and inverse when it withholds a hue", async () => {
    const { theming } = await obtainTheming(
      [overriding("loud", { strong: { bold: true, dim: true, hue: "cyan" } })],
      { NO_COLOR: "" },
    );

    expect(theming.theme(terminal).appearance("strong")).toEqual({
      bold: true,
      dim: true,
    });
  });

  test("resolves colour against the stream it is handed, not the process", async () => {
    const { theming } = await obtainTheming([
      overriding("states", { danger: { hue: "red" } }),
    ]);

    expect(theming.theme({ isTTY: true }).appearance("danger")).toEqual({
      hue: "red",
    });
    expect(theming.theme({ isTTY: false }).appearance("danger")).toEqual({});
    expect(theming.theme({}).appearance("danger")).toEqual({});
  });

  test("lets the caller's own request settle colour", async () => {
    const { theming } = await obtainTheming(
      [overriding("states", { danger: { hue: "red" } })],
      { NO_COLOR: "" },
    );

    expect(
      theming.theme(terminal, { colour: true }).appearance("danger"),
    ).toEqual({ hue: "red" });
    expect(
      theming.theme({ isTTY: false }, { colour: true }).appearance("danger"),
    ).toEqual({ hue: "red" });
    expect(
      theming.theme(terminal, { colour: false }).appearance("danger"),
    ).toEqual({});
  });
});

describe("a themed surface on screen", () => {
  /** The frame is chrome, so an override of `chrome` has to reach the bytes the
   * renderer wrote. The default theme names no bold anywhere, which is what
   * makes its absence without the override the other half of the assertion. */
  test("draws a surface with the overridden appearance", async () => {
    expect(await renderedSelect([])).not.toContain(BOLD_OPEN);
    expect(
      await renderedSelect([
        overriding("bolder", { chrome: { dim: true, bold: true } }),
      ]),
    ).toContain(BOLD_OPEN);
  });

  /** Colour enablement reaches the screen through the same path, and it is the
   * theme that withholds the hue rather than the renderer: dim and bold still
   * arrive, so the frame keeps its structure when it loses its colour. */
  test("withholds an overridden hue where hues are disabled", async () => {
    const loud = [
      overriding("loud", { chrome: { dim: true, bold: true, hue: "red" } }),
    ];

    const coloured = await renderedSelect(loud);
    expect(coloured).toContain(RED_OPEN);
    expect(coloured).toContain(BOLD_OPEN);

    const plain = await renderedSelect(loud, { NO_COLOR: "" });
    expect(plain).not.toContain(RED_OPEN);
    expect(plain).toContain(BOLD_OPEN);
  });
});

describe("a surface requiring the theme capability", () => {
  test("fails naming the count when no theme provider is composed", async () => {
    expect(await dialogFailure([])).toEqual(
      new Error("Expected exactly one theme capability, but found 0"),
    );
  });

  test("fails naming the count when two theme providers are composed", async () => {
    const second: PluginDefinition = {
      identity: { name: "second-theme" },
      load: () => async (api) => {
        await (await themePlugin.load())(api);
      },
    };

    expect(await dialogFailure([themePlugin, second])).toEqual(
      new Error("Expected exactly one theme capability, but found 2"),
    );
  });
});
