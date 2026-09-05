import type { CoreDependencies } from "@fx/tx/plugin";
import type { FilterMode } from "./filter.ts";

/** The local structural contract the bundled dialogs provider and its bundled
 * consumers share. It deliberately lives beside the provider rather than in
 * `@fx/tx/plugin`: the capability is internal, so core carries no dialog
 * vocabulary and nothing here is a public export. */

export type TextField = {
  readonly type: "text";
  readonly name: string;
  readonly message: string;
  readonly initialValue?: string;
};

/** Everything an option carries whatever its display text is: what it means to
 * the caller, what it collects, and where it leads. */
type OptionBase<T> = {
  readonly value: T;
  readonly fields?: readonly TextField[];
  /** A sub-dialog this option opens: a nested select drawn as the next column
   * of the same panel, or one text field collected as a leaf. An option that
   * declares one is marked in the list and opens rather than resolves;
   * absence leaves the option a plain choice. */
  readonly dialog?: SelectRequest<T> | TextField;
};

/** An option displayed as one string, measured against one scalar width. */
type LabelOption<T> = OptionBase<T> & {
  readonly label: string;
  readonly cells?: undefined;
};

/** An option displayed as a row of cells aligned into the fields its column
 * shares, measured against a vector of field widths. */
type CellOption<T> = OptionBase<T> & {
  readonly cells: readonly string[];
  readonly label?: undefined;
};

/**
 * One choice, displayed either as a label or as a row of cells.
 *
 * The two are alternatives rather than one field of two shapes, so the
 * discrimination is stated once here rather than at every read of `label` —
 * including the reads in `filter.ts` and `select.ts` that have nothing to do
 * with cells. The union says "exactly one" to a caller the compiler reaches;
 * the request validation says the same thing to one it does not, and it is the
 * validation that also settles what a whole column may hold, which no shape of
 * a single option can express.
 */
export type SelectOption<T> = LabelOption<T> | CellOption<T>;

export type SelectRequest<T> = {
  readonly message: string;
  readonly options: readonly SelectOption<T>[];
  /** Names for the fields of this column's cells, drawn once at the top of its
   * band. Per column, like the filter setting and unlike the `expand` binding:
   * each column is its own request, so a column browser whose levels list
   * different things names each level's fields where that level is declared.
   * An empty list means the column declares none, exactly as omitting it
   * does. */
  readonly headers?: readonly string[];
  /** When this level's filter is on screen. Filtering is never off — typing
   * always narrows the list — so this decides only whether the filter shows
   * before anything has been typed. Defaults to `"typed"`. */
  readonly filter?: FilterMode;
  /** Which key opens an option's sub-dialog. `enter` is the default: the key
   * that takes a plain option opens one that leads somewhere, and an option
   * that leads somewhere is never submitted by it. `tab` moves opening to Tab
   * and leaves Enter submitting at every level, for a caller whose expandable
   * options are choices in their own right. The arrows open and back out under
   * either binding. Read from the root request only — one dialog answers one
   * set of keys however deep the reader goes. */
  readonly expand?: "enter" | "tab";
};

export type SelectResult<T> = {
  readonly value: T;
  readonly values: Readonly<Record<string, string>>;
};

export type InputRequest = {
  readonly message: string;
  readonly initialValue?: string;
};

export type Dialogs = {
  input(request: InputRequest): Promise<string | undefined>;
  select<T>(request: SelectRequest<T>): Promise<SelectResult<T> | undefined>;
};

export type Outcome<T> =
  | { readonly type: "completed"; readonly value: T }
  | { readonly type: "cancelled" };

export type DialogElement = ReturnType<
  CoreDependencies["react"]["createElement"]
>;

export type DialogView = () => DialogElement;
