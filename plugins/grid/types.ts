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

/** The value registered under `grid`. Selecting a row is the other half of the
 * capability and is not implemented here. */
export type Grid = {
  print(request: GridRequest): void;
};
