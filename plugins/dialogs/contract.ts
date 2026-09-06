/**
 * The published dialogs contract: everything a plugin needs to type the value
 * it reads from the `@fx/tx/dialogs` registry key, and nothing else.
 *
 * It is published at that same specifier, so the string a consumer passes to
 * the read and the string it imports this file from are one string rather than
 * two that have to be kept agreeing. A consumer that imported this instead of
 * restating it learns about a contract that moved when it builds rather than
 * when its command reaches for a member that is no longer there.
 *
 * It declares types alone — no imports, no statements, nothing that survives
 * compilation — which is what lets it be published under a `types` condition
 * with no runtime condition beside it. That is also what decides where the
 * line through `types.ts` was drawn: this is a subset of that file rather than
 * the file. `DialogElement` and the view type over it stay behind, because
 * they are defined in terms of `CoreDependencies["react"]["createElement"]` —
 * a rendering detail nobody who calls `select` or `input` ever sees, whose
 * publication would put React's element type in a consumer's build and make an
 * internal rendering decision a breaking change. `FilterMode` came the other
 * way, out of the matcher module it was declared in, because a caller sets it
 * on a request and none of the matcher code behind it is a consumer's to
 * compile.
 *
 * Publishing the vocabulary does not publish a dialog: a consumer that can
 * name a request and a result still cannot draw one without the capability.
 * Nothing here reads a stream, renders, or knows a terminal.
 */

/**
 * When a column shows its filter.
 *
 * Filtering itself is never off — a printable character always narrows the
 * list, at every level and whatever the list's length — so what this decides
 * is only whether the filter is on screen before anything has been typed into
 * it.
 */
export type FilterMode = "typed" | "always";

/** One value collected from the reader as free text. */
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
 * including the reads in the provider's own filter and select modules that
 * have nothing to do with cells. The union says "exactly one" to a caller the
 * compiler reaches; the request validation says the same thing to one it does
 * not, and it is the validation that also settles what a whole column may
 * hold, which no shape of a single option can express.
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

/** What a completed dialog carries: the completing option's value, and every
 * field value collected on the way to it, keyed by field name. A path that
 * collected nothing resolves an empty record. */
export type SelectResult<T> = {
  readonly value: T;
  readonly values: Readonly<Record<string, string>>;
};

export type InputRequest = {
  readonly message: string;
  readonly initialValue?: string;
};

/**
 * The value registered under `@fx/tx/dialogs`: one line of text collected, or
 * one choice taken from a column browser. Both answer `undefined` when the
 * reader cancels, which is a completed dialog rather than a failure.
 */
export type Dialogs = {
  input(request: InputRequest): Promise<string | undefined>;
  select<T>(request: SelectRequest<T>): Promise<SelectResult<T> | undefined>;
};
