import { describe, expect, test } from "bun:test";
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
