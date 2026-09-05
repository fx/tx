/**
 * Whether hues reach a surface, decided once for everything `tx` draws.
 *
 * Pure on purpose: an injected environment, the TTY-ness of the stream being
 * drawn to, and whatever the invoking command asked for. No globals, no
 * `process`, and no stream — the resolution is a table over five inputs, and a
 * table is testable directly rather than through a rendered frame.
 */

/** The environment the decision reads, injected rather than reached for. */
export type ColourEnvironment = Readonly<Record<string, string | undefined>>;

export type ColourInputs = {
  readonly env: ColourEnvironment;
  /**
   * The TTY-ness of the stream being drawn to, asked for rather than handed
   * over. It is the lowest input, so it is asked for only where nothing above
   * it decided — which is what keeps "the rest unread" true of the stream as
   * well as of the environment.
   *
   * Absent is not a TTY: a stream that says nothing about itself is the
   * redirected case, and reading it as unknown would emit different bytes.
   */
  readonly isTTY: () => boolean | undefined;
  /** What the invoking command asked for, where it asked at all. Absent means
   * no request was made rather than a request for no colour. */
  readonly request?: boolean | undefined;
};

/**
 * The five inputs in one fixed order, first decider winning and the rest left
 * unread. Stating it as an order rather than as a set of conditions is what
 * gives every conflicting pair an answer: `NO_COLOR` beats `FORCE_COLOR`, and
 * `FORCE_COLOR=1` beats both `TERM=dumb` and a redirected stream, which is
 * what makes it a way of forcing colour rather than a hint.
 *
 * Every input is read at the step that consults it rather than gathered up
 * front, so an input below the one that decided is not read at all.
 */
export function coloursEnabled({ env, isTTY, request }: ColourInputs): boolean {
  /** One environment variable by name. Named rather than reached into with a
   * literal because the environment is an index signature. */
  const environment = (name: string): string | undefined => env[name];
  // 1. The caller's own request, which is the most specific statement of
  // intent there is. Only exactly `true` or exactly `false` counts as one; an
  // omitted option and an `undefined` field are passed over.
  if (typeof request === "boolean") return request;
  // 2. `NO_COLOR` present with any value, an empty one included.
  if (environment("NO_COLOR") !== undefined) return false;
  // 3. `FORCE_COLOR`, which decides in both directions. Absent, empty, or
  // whitespace decides nothing rather than deciding no.
  const forced = environment("FORCE_COLOR")?.trim();
  if (forced !== undefined && forced !== "") {
    return forced !== "0" && forced !== "false";
  }
  // 4. A terminal that says it can render nothing.
  if (environment("TERM") === "dumb") return false;
  // 5. The stream itself. Nothing below this decides, so a stream that is a
  // terminal falls through to hues being enabled.
  return isTTY() === true;
}
