import { describe, expect, test } from "bun:test";
import {
  type ColourEnvironment,
  coloursEnabled,
} from "../plugins/theme/colour.ts";

/**
 * Colour enablement is one fixed order over five inputs, so it is asserted as
 * a table over those inputs rather than through a rendered surface. A rendered
 * assertion could only ever reach the combinations a dialog happens to
 * produce, and the combinations that matter are exactly the conflicting pairs
 * the order exists to settle.
 */

/** One row of the table: the five inputs as plain data, so the table reads as a
 * table — three of them are environment variables, so they arrive together in
 * `env`. The TTY-ness is wrapped in the thunk `coloursEnabled` asks through
 * where the row is run. */
type Case = {
  readonly name: string;
  readonly inputs: {
    readonly env: Record<string, string | undefined>;
    readonly isTTY?: boolean | undefined;
    readonly request?: boolean | undefined;
  };
  readonly enabled: boolean;
};

/** A terminal with nothing set, which is the case every other row varies. */
const terminal = { env: {}, isTTY: true } as const;

const cases: readonly Case[] = [
  // 5. The stream, which decides last and only where nothing above it did.
  {
    name: "a terminal with a bare environment",
    inputs: terminal,
    enabled: true,
  },
  {
    name: "a redirected stream",
    inputs: { env: {}, isTTY: false },
    enabled: false,
  },
  {
    name: "a stream declaring no TTY-ness",
    inputs: { env: {} },
    enabled: false,
  },
  {
    name: "a stream whose isTTY is explicitly undefined",
    inputs: { env: {}, isTTY: undefined },
    enabled: false,
  },

  // 4. TERM, which beats the stream in both directions.
  {
    name: "TERM=dumb on a terminal",
    inputs: { env: { TERM: "dumb" }, isTTY: true },
    enabled: false,
  },
  {
    name: "a TERM that is not dumb",
    inputs: { env: { TERM: "xterm-256color" }, isTTY: true },
    enabled: true,
  },
  {
    name: "TERM=dumb off a terminal",
    inputs: { env: { TERM: "dumb" }, isTTY: false },
    enabled: false,
  },

  // 3. FORCE_COLOR, which decides in both directions and beats everything
  // below it — which is what makes it a way of forcing colour rather than a
  // hint.
  {
    name: "FORCE_COLOR=1 off a terminal",
    inputs: { env: { FORCE_COLOR: "1" }, isTTY: false },
    enabled: true,
  },
  {
    name: "FORCE_COLOR=1 against a stream saying nothing",
    inputs: { env: { FORCE_COLOR: "1" } },
    enabled: true,
  },
  {
    name: "FORCE_COLOR=1 against TERM=dumb",
    inputs: { env: { FORCE_COLOR: "1", TERM: "dumb" }, isTTY: true },
    enabled: true,
  },
  {
    name: "FORCE_COLOR=0 on a terminal",
    inputs: { env: { FORCE_COLOR: "0" }, isTTY: true },
    enabled: false,
  },
  {
    name: "FORCE_COLOR=false on a terminal",
    inputs: { env: { FORCE_COLOR: "false" }, isTTY: true },
    enabled: false,
  },
  {
    name: "FORCE_COLOR=true off a terminal",
    inputs: { env: { FORCE_COLOR: "true" }, isTTY: false },
    enabled: true,
  },
  {
    name: "FORCE_COLOR=2 off a terminal",
    inputs: { env: { FORCE_COLOR: "2" }, isTTY: false },
    enabled: true,
  },
  // Blank and whitespace decide nothing, so the stream below still answers.
  {
    name: "an empty FORCE_COLOR on a terminal",
    inputs: { env: { FORCE_COLOR: "" }, isTTY: true },
    enabled: true,
  },
  {
    name: "an empty FORCE_COLOR off a terminal",
    inputs: { env: { FORCE_COLOR: "" }, isTTY: false },
    enabled: false,
  },
  {
    name: "a whitespace FORCE_COLOR on a terminal",
    inputs: { env: { FORCE_COLOR: "   " }, isTTY: true },
    enabled: true,
  },
  {
    name: "a whitespace FORCE_COLOR off a terminal",
    inputs: { env: { FORCE_COLOR: " \t " }, isTTY: false },
    enabled: false,
  },
  {
    name: "a whitespace FORCE_COLOR against TERM=dumb",
    inputs: { env: { FORCE_COLOR: " ", TERM: "dumb" }, isTTY: true },
    enabled: false,
  },

  // 2. NO_COLOR, which beats FORCE_COLOR and everything below it.
  {
    name: "NO_COLOR set to an empty string on a terminal",
    inputs: { env: { NO_COLOR: "" }, isTTY: true },
    enabled: false,
  },
  {
    name: "NO_COLOR set to a value on a terminal",
    inputs: { env: { NO_COLOR: "1" }, isTTY: true },
    enabled: false,
  },
  {
    name: "NO_COLOR against FORCE_COLOR=1",
    inputs: { env: { NO_COLOR: "", FORCE_COLOR: "1" }, isTTY: true },
    enabled: false,
  },
  {
    name: "NO_COLOR against FORCE_COLOR=1 off a terminal",
    inputs: { env: { NO_COLOR: "1", FORCE_COLOR: "1" }, isTTY: false },
    enabled: false,
  },
  // An entry whose value is `undefined` is an unset variable, not a set one.
  {
    name: "an undefined NO_COLOR on a terminal",
    inputs: { env: { NO_COLOR: undefined }, isTTY: true },
    enabled: true,
  },

  // 1. The caller's own request, which beats every environment input.
  {
    name: "a request for colour against NO_COLOR",
    inputs: { env: { NO_COLOR: "" }, isTTY: true, request: true },
    enabled: true,
  },
  {
    name: "a request for colour against FORCE_COLOR=0",
    inputs: { env: { FORCE_COLOR: "0" }, isTTY: true, request: true },
    enabled: true,
  },
  {
    name: "a request for colour against TERM=dumb",
    inputs: { env: { TERM: "dumb" }, isTTY: true, request: true },
    enabled: true,
  },
  {
    name: "a request for colour against a redirected stream",
    inputs: { env: {}, isTTY: false, request: true },
    enabled: true,
  },
  {
    name: "a request against every environment input at once",
    inputs: {
      env: { NO_COLOR: "", FORCE_COLOR: "0", TERM: "dumb" },
      isTTY: false,
      request: true,
    },
    enabled: true,
  },
  {
    name: "a request for no colour against FORCE_COLOR=1",
    inputs: { env: { FORCE_COLOR: "1" }, isTTY: true, request: false },
    enabled: false,
  },
  {
    name: "a request for no colour on a bare terminal",
    inputs: { env: {}, isTTY: true, request: false },
    enabled: false,
  },
  // An omitted request and an `undefined` one are the same thing: no request
  // was made, so the inputs below it answer.
  {
    name: "an undefined request on a terminal",
    inputs: { env: {}, isTTY: true, request: undefined },
    enabled: true,
  },
  {
    name: "an undefined request against NO_COLOR",
    inputs: { env: { NO_COLOR: "" }, isTTY: true, request: undefined },
    enabled: false,
  },
];

describe("colour enablement", () => {
  for (const { name, inputs, enabled } of cases) {
    test(`${enabled ? "emits" : "withholds"} hues for ${name}`, () => {
      const { env, isTTY, request } = inputs;
      expect(coloursEnabled({ env, isTTY: () => isTTY, request })).toBe(
        enabled,
      );
    });
  }

  /** The order is total: every one of the seventy-two combinations of the five
   * inputs — three requests, two NO_COLORs, three FORCE_COLORs, two TERMs, and
   * two streams — has an answer, and the answer is the highest input that
   * decided. Asserted independently of the table above so a row edited into
   * agreement with an implementation still has to agree with the order. */
  test("answers every combination with its highest decider", () => {
    const requests = [undefined, true, false] as const;
    const noColours = [undefined, ""] as const;
    const forced = [undefined, "1", "0"] as const;
    const terms = [undefined, "dumb"] as const;
    const streams = [true, false] as const;

    for (const request of requests) {
      for (const noColour of noColours) {
        for (const force of forced) {
          for (const term of terms) {
            for (const isTTY of streams) {
              const env: Record<string, string | undefined> = {
                ...(noColour === undefined ? {} : { NO_COLOR: noColour }),
                ...(force === undefined ? {} : { FORCE_COLOR: force }),
                ...(term === undefined ? {} : { TERM: term }),
              };
              const expected =
                request !== undefined
                  ? request
                  : noColour !== undefined
                    ? false
                    : force !== undefined
                      ? force !== "0"
                      : term === "dumb"
                        ? false
                        : isTTY;
              expect(coloursEnabled({ env, isTTY: () => isTTY, request })).toBe(
                expected,
              );
            }
          }
        }
      }
    }
  });
});

/**
 * The order is not only about which input answers: the specification requires
 * the first decider to settle the question "with the rest unread", so an input
 * below it must not be consulted at all.
 *
 * A table of plain data cannot catch a regression there — every value is
 * readable, so reading one costs nothing and shows nothing. These cases make
 * the lower inputs refuse to be read, which turns an eager read into a thrown
 * error rather than a silent one.
 */
describe("the order leaves every input below its decider unread", () => {
  /** An environment that throws rather than answer for the variables a higher
   * input has already settled. */
  function refusing(
    env: Record<string, string | undefined>,
    ...forbidden: readonly string[]
  ): ColourEnvironment {
    return new Proxy(env, {
      get(target, name) {
        if (typeof name === "string" && forbidden.includes(name)) {
          throw new Error(`${name} was read after the question was settled`);
        }
        return Reflect.get(target, name);
      },
    });
  }

  /** A stream that refuses to say whether it is a terminal, which every case
   * here has already been answered above. */
  const unreadableStream = (): boolean | undefined => {
    throw new Error("the stream was read after the question was settled");
  };

  test("reads nothing below the caller's own request", () => {
    const env = refusing(
      { NO_COLOR: "", FORCE_COLOR: "0", TERM: "dumb" },
      "NO_COLOR",
      "FORCE_COLOR",
      "TERM",
    );

    expect(
      coloursEnabled({ env, isTTY: unreadableStream, request: true }),
    ).toBe(true);
    expect(
      coloursEnabled({ env, isTTY: unreadableStream, request: false }),
    ).toBe(false);
  });

  test("reads nothing below NO_COLOR", () => {
    expect(
      coloursEnabled({
        env: refusing(
          { NO_COLOR: "", FORCE_COLOR: "1", TERM: "dumb" },
          "FORCE_COLOR",
          "TERM",
        ),
        isTTY: unreadableStream,
      }),
    ).toBe(false);
  });

  test("reads nothing below a FORCE_COLOR that decides", () => {
    expect(
      coloursEnabled({
        env: refusing({ FORCE_COLOR: "1", TERM: "dumb" }, "TERM"),
        isTTY: unreadableStream,
      }),
    ).toBe(true);
    expect(
      coloursEnabled({
        env: refusing({ FORCE_COLOR: "0", TERM: "dumb" }, "TERM"),
        isTTY: unreadableStream,
      }),
    ).toBe(false);
  });

  test("reads nothing below TERM=dumb", () => {
    expect(
      coloursEnabled({ env: { TERM: "dumb" }, isTTY: unreadableStream }),
    ).toBe(false);
  });

  /** The other half of the same claim: an input that decides nothing must
   * still let the one below it be read. */
  test("reads on down where an input decides nothing", () => {
    expect(
      coloursEnabled({ env: { FORCE_COLOR: "  " }, isTTY: () => true }),
    ).toBe(true);
  });
});
