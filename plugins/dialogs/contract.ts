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
 *
 * The capability's `Select` and `Input` are components a host renders in its
 * own render session, and they are typed here without naming React: each is a
 * function of its props returning `unknown`. React's element type is exactly
 * the rendering detail kept out above, so a host holding the injected React
 * casts a component once where it calls `createElement` rather than this file
 * importing the type that would let it skip the cast.
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
  /** Whether this option opens ticked. Accepted only in a column declaring
   * `multiple`: `true` anywhere else is rejected before anything is drawn,
   * while `false` means exactly what omitting it means. */
  readonly selected?: boolean;
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
  /** Whether the reader may tick several of this column's options with Space
   * and take them together. Per column, like `headers` and `filter`: a nested
   * sub-dialog request decides its own column, and an omitted setting leaves
   * the column single-choice. */
  readonly multiple?: boolean;
};

/** What a completed dialog carries: the completing option's value, every
 * field value collected on the way to it keyed by field name, and the values
 * taken.
 *
 * A path that collected nothing resolves an empty record. `selected` holds the
 * ticked options of every column open at completion, left to right and in
 * supplied order within a column; only when none of them holds a tick is it
 * the completing option's value alone, so a dialog declaring no `multiple`
 * column always resolves it as `[value]`. It is a field of its own rather than
 * a reuse of `values`, which already means the text collected along the
 * path. */
export type SelectResult<T> = {
  readonly value: T;
  readonly values: Readonly<Record<string, string>>;
  readonly selected: readonly T[];
};

export type InputRequest = {
  readonly message: string;
  readonly initialValue?: string;
};

/**
 * The props every embeddable component that takes keys shares, here and in the
 * grid's selecting component, so a host learns them once. `R` is what the
 * function form resolves with on completion.
 *
 * The host owns placement and focus: the component draws in the columns it is
 * given rather than the terminal's, and answers keys only while it is active.
 * It is one-shot — once it has called either callback it ignores every key
 * until its host unmounts it, and a host wanting another answer mounts another
 * component.
 */
export type EmbeddedProps<R> = {
  /** The terminal columns the component may draw in. Below twenty it lays
   * itself out as if given twenty. */
  readonly width: number;
  /** Whether the component answers keys. An inactive component draws exactly
   * what it would draw active, in the same rows, but no caret, and runs no
   * animation. */
  readonly isActive: boolean;
  /** Called once, with exactly what the function form resolves with. */
  readonly onSubmit: (result: R) => void;
  /** Called once, where the function form resolves with `undefined`. */
  readonly onCancel: () => void;
};

/** What a host renders `Select` with. The request is the one the component
 * was mounted with: a host presenting a different question mounts a new
 * component, keyed differently, rather than passing a new request. */
export type SelectProps<T> = EmbeddedProps<SelectResult<T>> & {
  readonly request: SelectRequest<T>;
  /** The terminal rows the select may draw in, its edges, hint line, and any
   * entry panel beneath its frame included. The window gives up option rows
   * first, and none at all where `height` cannot afford one. */
  readonly height: number;
};

/** What a host renders `Input` with. It takes no height: an input is always
 * its frame's three rows and its hint line. */
export type InputProps = EmbeddedProps<string> & {
  readonly request: InputRequest;
};

/**
 * The value registered under `@fx/tx/dialogs`: one line of text collected, or
 * one choice taken from a column browser, together with whatever the reader
 * ticked in its `multiple` columns. Both answer `undefined` when the reader
 * cancels, which is a completed dialog rather than a failure.
 *
 * `Input` and `Select` are the same two dialogs as components, for a plugin
 * that already draws its own interface and cannot hand the terminal to a
 * second render session. `input` and `select` are those components mounted in
 * a session of the provider's own. Every read of the capability yields the
 * same two component functions, so a host rendering one again keeps its state.
 */
export type Dialogs = {
  input(request: InputRequest): Promise<string | undefined>;
  select<T>(request: SelectRequest<T>): Promise<SelectResult<T> | undefined>;
  /** Rendered by a host with the injected React inside its own render
   * session; `unknown` keeps React's element type out of this contract. */
  readonly Input: (props: InputProps) => unknown;
  /** Rendered by a host with the injected React inside its own render
   * session; `unknown` keeps React's element type out of this contract. A
   * request the function form would reject throws on first render, before
   * anything is drawn. */
  readonly Select: <T>(props: SelectProps<T>) => unknown;
};
