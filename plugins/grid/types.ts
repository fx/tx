import type { ThemeVariable } from "./theme.ts";

/**
 * The local structural contract the bundled grid provider and its bundled
 * consumers share. It deliberately lives beside the provider rather than in
 * `@fx/tx/plugin`: the capability is internal, so core carries no grid
 * vocabulary and nothing here is a public export.
 */

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
 * backing out returns to the row list rather than selecting the row. */
export type GridSelection<T, A> = {
  readonly value: T;
  readonly action?: A;
};

/** The value registered under `grid`: cells printed once, or driven. A grid is
 * one or the other in a call, never both. */
export type Grid = {
  print(request: GridRequest): void;
  select<T, A>(
    request: GridSelectRequest<T, A>,
  ): Promise<GridSelection<T, A> | undefined>;
};
