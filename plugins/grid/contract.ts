/**
 * The published grid contract: everything a plugin needs to type the value it
 * reads from the `@fx/tx/grid` registry key, and nothing else.
 *
 * It is published at that same specifier, so the string a consumer passes to
 * the read and the string it imports this file from are one string rather than
 * two that have to be kept agreeing. A consumer that imported this instead of
 * restating it learns about a contract that moved when it builds rather than
 * when its command reaches for a member that is no longer there.
 *
 * It declares types alone — type-only imports, no statements, nothing that
 * survives compilation — which is what lets it be published under a `types`
 * condition with no runtime condition beside it. The capability's value comes
 * from the registry and must keep coming from there: nothing here prints,
 * measures, or knows a renderer.
 *
 * The theme vocabulary arrives through `@fx/tx/theme` rather than through a
 * relative path into the theme plugin. A relative import is the escape the
 * boundary test exists to forbid, because it would put two bundled plugins in
 * one runtime module graph; the published path shares no graph at all, since
 * it is erased. It is the mechanism `@fx/tx/plugin` already uses between the
 * same two directories, and it means a variable renamed in one place is
 * renamed everywhere a cell can name one. The props every embeddable component
 * taking keys shares arrive through `@fx/tx/dialogs` for the same reason, so a
 * host learns them once and the selecting grid cannot drift from the select it
 * is drawn as.
 */

import type { EmbeddedProps } from "@fx/tx/dialogs";
import type { ThemeVariable } from "@fx/tx/theme";

/** One cell of a grid. `variable` and `align` describe a *printed* cell; the
 * selecting half of the capability drops both, so a consumer should not expect
 * either to survive into a selectable row. */
export type Cell = {
  readonly text: string;
  /** The role the cell's text is drawn as. Absent names `content`, the role a
   * surface's own text has, rather than leaving the appearance open — which is
   * what makes the bare-string shorthand and a cell declaring `content` render
   * identically. */
  readonly variable?: ThemeVariable;
  /** Which edge the cell is padded at within its column. Absent means `start`,
   * the same as declaring it. */
  readonly align?: "start" | "end";
};

/** A row's cells. A bare string means exactly the cell that string would make
 * with no variable and no alignment, so the two forms differ in notation alone
 * and a row may mix them freely. */
export type Row = readonly (Cell | string)[];

/** The stream printed output is written to. Only its width and its TTY-ness
 * are read; the grid never reaches for the process's own streams, and it never
 * requires an interactive one. */
export type OutputStream = {
  write(chunk: string): unknown;
  readonly columns?: number;
  readonly isTTY?: boolean;
};

export type GridRequest = {
  readonly stream: OutputStream;
  /** Absent means `table`: it is the shape a caller who said nothing meant,
   * and the only one that needs no width. */
  readonly layout?: "table" | "flow";
  /** Drawn once above the rows and emphasized relative to them. An empty list
   * means no headers, exactly as omitting it does. A flow ignores them. */
  readonly headers?: readonly string[];
  readonly rows: readonly Row[];
  /** Printed where the rows would have been when there are none. Absent means
   * nothing is printed there: the message is the consumer's to word, so a grid
   * whose rows can never be empty is not obliged to invent one. */
  readonly empty?: string;
  /** Drawn once beneath the rows, de-emphasized and separated from them by a
   * blank line. */
  readonly summary?: string;
};

/** One thing a consumer offers to do with a row. `value` is what the grid
 * reports back; what it means — a command, a route, a mode — belongs to the
 * consumer that declared it, and the grid never runs, spawns, or interprets
 * it. */
export type GridAction<A> = {
  readonly label: string;
  readonly value: A;
};

/** One selectable row: the cells it shows, the value that identifies it, and
 * the actions it offers.
 *
 * The value is declared on the row rather than in a list parallel to the rows,
 * so a row the caller cannot identify is unrepresentable rather than
 * rejectable. The actions are declared per row for the same reason and one
 * more: two rows may offer different ones, and a row may offer none beside one
 * that does. An empty list means the row declares none, exactly as omitting it
 * does. */
export type GridSelectRow<T, A> = {
  readonly cells: Row;
  readonly value: T;
  readonly actions?: readonly GridAction<A>[];
};

/** A grid presented for selection. It carries no stream: a dialog reads and
 * draws through the streams the dialogs capability was injected with, and the
 * terminal-handover guarantee depends on it being those streams and no
 * others. */
export type GridSelectRequest<T, A> = {
  readonly message: string;
  /** Names for the fields the rows align into, drawn once above them. An empty
   * list means no headers, exactly as omitting it does. */
  readonly headers?: readonly string[];
  readonly rows: readonly GridSelectRow<T, A>[];
};

/** What a selection carries: the chosen row's value, and the chosen action's
 * where the row declared any. An absent `action` means the chosen row offered
 * none — it is never what backing out of an actions column produces, because
 * backing out returns to the row list rather than selecting the row.
 *
 * Absent means the key is not there, so a consumer tells the two apart with
 * `"action" in chosen` rather than `chosen.action === undefined`: an action's
 * value is the consumer's own, so `undefined` is a value it may legitimately
 * give one. */
export type GridSelection<T, A> = {
  readonly value: T;
  readonly action?: A;
};

/** What a host hands the embeddable `Grid`: the request it would print, and
 * the columns it may lay out in.
 *
 * The request is nested under `request`, as every embeddable component takes
 * its request, and omits `stream` rather than forbidding it: the component
 * writes to no stream and reads nothing from one, so a host holding a request
 * it would print may pass it unchanged. `width` is the only width a flow lays
 * out against, and the terminal's is never read. There is no key handling, so
 * there is no `height`, `isActive`, `onSubmit`, or `onCancel`. */
export type GridProps = {
  readonly request: Omit<GridRequest, "stream">;
  readonly width: number;
};

/** What a host hands the embeddable `SelectGrid`: the selecting request it
 * would pass to `select`, the props every embeddable component taking keys
 * shares, and the rows it may draw in.
 *
 * `onSubmit` receives exactly the selection `select` resolves with, and
 * `onCancel` is called where `select` resolves with nothing. The request is the
 * one the component was mounted with: a host presenting different rows mounts
 * a new component, keyed differently, rather than passing a new request. */
export type SelectGridProps<T, A> = EmbeddedProps<GridSelection<T, A>> & {
  readonly request: GridSelectRequest<T, A>;
  /** The terminal rows the grid may draw in, as the select it is drawn as
   * reads them. */
  readonly height: number;
};

/** The value registered under `@fx/tx/grid`: cells printed once, or driven. A
 * grid is one or the other in a call, never both. */
export type Grid = {
  print(request: GridRequest): void;
  select<T, A>(
    request: GridSelectRequest<T, A>,
  ): Promise<GridSelection<T, A> | undefined>;
  /** The printed grid as a component a host renders inside a session it
   * owns, with the React and Ink `tx` injected into it. It hands that session
   * exactly the lines `print` would write to a stream reporting `width`
   * columns, themed for the standard-error stream `tx` injected, and writes
   * nothing itself. Typed as returning `unknown` so this contract names no
   * React type: a host casts it where it passes it to `createElement`. The
   * same value on every read of the capability. */
  readonly Grid: (props: GridProps) => unknown;
  /** The driven grid as a component a host renders inside a session it owns:
   * the request `select` would present, drawn as the dialogs' embeddable
   * `Select` in the host's `width` and `height` and answering keys only while
   * `isActive`. It writes to no stream and needs no interactive one. It reads
   * the dialogs capability when it mounts, and fails that render when it finds
   * other than exactly one provider. Typed as returning `unknown` for the
   * reason `Grid` is; the same value on every read of the capability. */
  readonly SelectGrid: <T, A>(props: SelectGridProps<T, A>) => unknown;
};
