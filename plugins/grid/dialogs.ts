/**
 * The dialogs contract as the grid plugin sees it.
 *
 * It is a local structural type rather than an import from the dialogs plugin,
 * for the reason the theming contract beside it states: the capability is
 * internal, so core carries no dialog vocabulary, and two bundled plugins may
 * not share a module graph. The grid reaches this one through the registry,
 * exactly as it reaches the theme.
 *
 * Only the part the grid uses is described. A dialog collects fields, opens a
 * text leaf, and answers a set of keys the grid neither declares nor rebinds,
 * so none of that appears here: what a request may hold is the dialogs
 * specification's to state, and a consumer restates only what it sends.
 */

/** An option displayed as the row of cells a column aligns into fields, which
 * is what a grid's rows become. It may open a sub-dialog: the column of
 * actions that row declared. */
export type CellOption<T> = {
  readonly cells: readonly string[];
  readonly value: T;
  readonly dialog?: SelectRequest<T>;
};

/** An option displayed as one label, which is what an action becomes. An
 * action leads nowhere further, so it declares no sub-dialog. */
export type LabelOption<T> = {
  readonly label: string;
  readonly value: T;
};

/** One choice, displayed either as a label or as a row of cells. The two are
 * alternatives rather than one field of two shapes, and a column holds one
 * kind throughout — which is why the rows and the actions are separate
 * columns rather than one list of both. */
export type SelectOption<T> = CellOption<T> | LabelOption<T>;

export type SelectRequest<T> = {
  readonly message: string;
  readonly options: readonly SelectOption<T>[];
  readonly headers?: readonly string[];
};

/** What a dialog resolves with: the completing option's value, and the inputs
 * collected on the way to it. The grid declares no fields, so the record it
 * gets back is always empty and it reads only the value. */
export type SelectResult<T> = {
  readonly value: T;
  readonly values: Readonly<Record<string, string>>;
};

/** The capability registered under `dialogs`. */
export type Dialogs = {
  select<T>(request: SelectRequest<T>): Promise<SelectResult<T> | undefined>;
};

/**
 * The one dialogs capability, or a failure naming how many were found.
 *
 * There is deliberately no fallback, for the reason the theme lookup beside it
 * states and this one shares: a grid that fell back would have to own
 * movement, filtering, a viewport, and a terminal session, which is the
 * duplication composing over dialogs exists to remove. Falling back to
 * printing would be worse still — a consumer that asked a question would get
 * output and no answer.
 */
export function requireDialogsCapability(
  registrations: <T>(key: string) => readonly T[],
): Dialogs {
  const dialogs = registrations<Dialogs>("dialogs");
  if (dialogs.length !== 1) {
    throw new Error(
      `Expected exactly one dialogs capability, but found ${dialogs.length}`,
    );
  }
  return dialogs[0] as Dialogs;
}
