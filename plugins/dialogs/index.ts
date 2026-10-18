const streams: typeof import("node:stream") = require("node:stream");

import type {
  CommandContext,
  CoreDependencies,
  Plugin,
  PluginDefinition,
  PluginIdentity,
} from "@fx/tx/plugin";
import { animationInterval, onPhase } from "./animation.ts";
import type {
  Dialogs,
  InputProps,
  InputRequest,
  SelectOption,
  SelectProps,
  SelectRequest,
  SelectResult,
} from "./contract.ts";
import { createEntry } from "./entry.ts";
import { createFrame } from "./frame.ts";
import { createSelectView } from "./select.ts";
import { requireThemeCapability } from "./theme.ts";
import type { DialogView, Outcome } from "./types.ts";

type Failure =
  | { readonly present: false }
  | { readonly present: true; readonly reason: unknown };

class FailureTracker {
  readonly #failed = Promise.withResolvers<unknown>();
  readonly promise = this.#failed.promise;
  failure: Failure = { present: false };

  fail(reason: unknown): void {
    if (this.failure.present) return;
    this.failure = { present: true, reason };
    this.#failed.resolve(reason);
  }
}

class InputAdapter extends streams.PassThrough {
  readonly isTTY = true;
  readonly failures: FailureTracker;
  readonly #source: NodeJS.ReadStream;
  readonly #forward: (chunk: string | Buffer) => boolean;
  readonly #captureError: (error: unknown) => void;
  readonly #sourceWasFlowing: boolean;
  readonly #sourceWasRaw: boolean;
  readonly #sourceWasReferenced: boolean;
  #forwarding = true;
  #ownedReferences = 0;
  #rawModeMayBeEnabled = false;

  constructor(source: NodeJS.ReadStream, failures: FailureTracker) {
    super();
    this.#source = source;
    this.failures = failures;
    this.#sourceWasFlowing = source.readableFlowing === true;
    this.#sourceWasRaw = source.isRaw === true;
    const referenceSource = source as NodeJS.ReadStream & {
      hasRef?: () => boolean;
      _handle?: { hasRef?: () => boolean };
    };
    this.#sourceWasReferenced =
      referenceSource.hasRef?.call(source) === true ||
      referenceSource._handle?.hasRef?.() === true;
    this.#forward = this.write.bind(this);
    this.#captureError = failures.fail.bind(failures);
    source.on("data", this.#forward);
    source.on("error", this.#captureError);
    source.resume();
  }

  setRawMode(enabled: boolean): this {
    if (enabled) {
      if (this.#sourceWasRaw) return this;
      this.#rawModeMayBeEnabled = true;
      try {
        this.#source.setRawMode(true);
      } catch (error) {
        this.failures.fail(error);
        throw error;
      }
    } else {
      this.#disableRawMode();
    }
    return this;
  }

  ref(): this {
    if (this.#sourceWasReferenced) return this;
    try {
      this.#source.ref();
      this.#ownedReferences++;
    } catch (error) {
      this.failures.fail(error);
      throw error;
    }
    return this;
  }

  unref(): this {
    this.#releaseReference();
    return this;
  }

  stopForwarding(): void {
    if (!this.#forwarding) return;
    this.#forwarding = false;
    this.#source.removeListener("data", this.#forward);
    this.#source.removeListener("error", this.#captureError);
    if (!this.#sourceWasFlowing) this.#source.pause();
  }

  cleanup(): void {
    this.stopForwarding();
    for (let attempt = 0; this.#rawModeMayBeEnabled && attempt < 2; attempt++) {
      this.#disableRawMode();
    }
    let consecutiveUnrefFailures = 0;
    while (this.#ownedReferences > 0 && consecutiveUnrefFailures < 3) {
      const before = this.#ownedReferences;
      this.unref();
      consecutiveUnrefFailures =
        this.#ownedReferences < before ? 0 : consecutiveUnrefFailures + 1;
    }
    this.destroy();
  }

  #disableRawMode(): void {
    if (!this.#rawModeMayBeEnabled) return;
    try {
      this.#source.setRawMode(false);
      this.#rawModeMayBeEnabled = false;
    } catch (error) {
      this.failures.fail(error);
    }
  }

  #releaseReference(): void {
    if (this.#ownedReferences === 0) return;
    try {
      this.#source.unref();
      this.#ownedReferences--;
    } catch (error) {
      this.failures.fail(error);
    }
  }
}

class OutputAdapter extends streams.Writable {
  readonly failures: FailureTracker;
  readonly #source: NodeJS.WriteStream;
  readonly #captureError: (error: unknown) => void;
  readonly #forwardResize: () => boolean;

  constructor(source: NodeJS.WriteStream, failures: FailureTracker) {
    super();
    this.#source = source;
    this.failures = failures;
    this.#captureError = failures.fail.bind(failures);
    this.#forwardResize = this.emit.bind(this, "resize");
    source.on("error", this.#captureError);
    source.on("resize", this.#forwardResize);
  }

  get isTTY(): boolean | undefined {
    return this.#source.isTTY;
  }

  get columns(): number | undefined {
    return this.#source.columns;
  }

  get rows(): number | undefined {
    return this.#source.rows;
  }

  async flush(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.write("", () => resolve());
    });
  }

  cleanup(): void {
    this.#source.removeListener("error", this.#captureError);
    this.#source.removeListener("resize", this.#forwardResize);
    this.destroy();
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    let completed = false;
    const complete = (error?: Error | null) => {
      if (completed) return;
      completed = true;
      if (error) this.failures.fail(error);
      callback();
    };
    try {
      this.#source.write(chunk, encoding, complete);
    } catch (error) {
      this.failures.fail(error);
      complete();
    }
  }
}

function recordFailure(current: Failure, candidate: Failure): Failure {
  return current.present ? current : candidate;
}

/** Rejects before any terminal state changes, so a redirected invocation never
 * has to be restored. */
function requireInteractiveStreams(
  context: CommandContext,
  description: string,
): void {
  if (!context.stdin.isTTY || !context.stderr.isTTY) {
    throw new Error(
      `${description} requires interactive input and error streams`,
    );
  }
}

/** Rejects every reachable options list that could never be chosen, before
 * any terminal state changes: an empty list at any depth asks for nothing.
 * Every level of the stack renders inside the one session, so every depth is
 * reachable and every depth is validated alongside the existing rejections.
 * A `seen` set stops on a repeated list: a cyclic request graph is a caller
 * bug, and a second visit would recurse until the stack overflows instead of
 * rejecting or rendering. Only the cycle back-edge is skipped; every
 * first visit is still validated.
 */
function requireNonEmptyOptions<T>(
  options: readonly SelectOption<T>[],
  seen: Set<readonly SelectOption<T>[]> = new Set(),
): void {
  if (seen.has(options)) return;
  seen.add(options);
  if (options.length === 0) {
    throw new Error("A select dialog requires at least one option");
  }
  for (const { dialog } of options) {
    if (dialog !== undefined && "options" in dialog) {
      requireNonEmptyOptions(dialog.options, seen);
    }
  }
}
/** Rejects a declaration that could never be collected, before any terminal
 * state changes: an option marked user-provided by an empty field list asks for
 * nothing, and a repeated name would let one field overwrite another's value.
 * Names only have to be unique within the option declaring them, because only
 * one option is ever collected. Every reachable sub-dialog is validated, so a
 * declaration no path walks to can still never render. A `seen` set stops on
 * a repeated list for the same cycle reason as above.
 */
function requireCollectableFields<T>(
  options: readonly SelectOption<T>[],
  seen: Set<readonly SelectOption<T>[]> = new Set(),
): void {
  if (seen.has(options)) return;
  seen.add(options);
  for (const { fields } of options) {
    if (!fields) continue;
    if (fields.length === 0) {
      throw new Error(
        "A user-provided select option requires at least one field",
      );
    }
    const names = new Set<string>();
    for (const { name } of fields) {
      if (names.has(name)) {
        throw new Error(`A select option repeats the field name "${name}"`);
      }
      names.add(name);
    }
  }
  for (const { dialog } of options) {
    if (dialog !== undefined && "options" in dialog) {
      requireCollectableFields(dialog.options, seen);
    }
  }
}

/**
 * Rejects a column whose display text could not line up, before any terminal
 * state changes: an option declaring both shapes or neither, a column mixing
 * the two, a column of rows with different numbers of cells, and headers a
 * column has no fields for.
 *
 * A column of cells is a table, and a table's shape is a property of the
 * column rather than of any one row in it — which is why this walks a request
 * rather than an option, and why it is the request's own `headers` it checks
 * them against. Every reachable sub-dialog is a column of its own and decides
 * its own shape and its own headers, so every one of them is validated here
 * too.
 *
 * The cycle guard is on the request rather than on its options list, which is
 * where the other two validations put theirs. Those read the list alone, so
 * two requests sharing one list are the same question asked twice; this one
 * also reads the request's own headers, so they are two different questions —
 * and a guard keyed on the list would answer the second by skipping it,
 * letting a column declaring headers its cells cannot carry render anyway.
 * Keying on the request still terminates, because a cyclic graph revisits the
 * same request object.
 *
 * Two emptinesses are decided by the rules rather than by a check of their
 * own. An empty cell list is not a list of cells: the option declaring one has
 * declared neither shape, and the label-or-cells rule rejects it as such. An
 * empty header list is a column saying it has no headers, which contradicts
 * nothing and means exactly what omitting it means.
 */
function requireAlignedCells<T>(
  request: {
    readonly options: readonly SelectOption<T>[];
    readonly headers?: readonly string[] | undefined;
  },
  seen: Set<object> = new Set(),
): void {
  const { options, headers } = request;
  if (seen.has(request)) return;
  seen.add(request);
  /** The cell count this column settled on, and so what every later row of it
   * and its headers are held to. */
  let cells: number | undefined;
  let labelled = false;
  for (const option of options) {
    const declared =
      option.cells !== undefined && option.cells.length > 0
        ? option.cells
        : undefined;
    if ((option.label !== undefined) === (declared !== undefined)) {
      throw new Error(
        "A select option requires either a label or cells, and not both",
      );
    }
    if (declared === undefined) {
      labelled = true;
      continue;
    }
    if (cells !== undefined && declared.length !== cells) {
      throw new Error(
        "A select column requires the same number of cells on every option",
      );
    }
    cells ??= declared.length;
  }
  // A label is not a one-cell row: reading it as one would put it in the first
  // field among fields that mean something else, which reads as a row that
  // lost its data rather than as a label.
  if (labelled && cells !== undefined) {
    throw new Error(
      "A select column cannot mix label options with cell options",
    );
  }
  if (headers !== undefined && headers.length > 0) {
    if (cells === undefined) {
      throw new Error("Select headers require a column of cell options");
    }
    if (headers.length !== cells) {
      throw new Error(
        "Select headers require one header for every cell of their column",
      );
    }
  }
  for (const { dialog } of options) {
    if (dialog !== undefined && "options" in dialog) {
      requireAlignedCells(dialog, seen);
    }
  }
}

/** Every rejection a select request can earn before anything is drawn, in the
 * order `select` has always raised them. The embedded `Select` runs the same
 * function on its first render, so the two forms cannot disagree about what is
 * rejected. */
function requireSelectableRequest<T>(request: SelectRequest<T>): void {
  requireNonEmptyOptions(request.options);
  requireCollectableFields(request.options);
  requireAlignedCells(request);
}

type DialogSession = {
  readonly context: CommandContext;
  readonly dependencies: CoreDependencies;
};

/**
 * Renders one dialog on the injected streams and settles only after the
 * terminal is restored and the renderer is unmounted, on completion,
 * cancellation, and failure alike. `build` receives the settle callback and
 * returns the view driving it.
 */
async function runDialog<T>(
  { context, dependencies }: DialogSession,
  label: string,
  build: (settle: (outcome: Outcome<T>) => void) => DialogView,
): Promise<T | undefined> {
  const { react, ink } = dependencies;
  const settled = Promise.withResolvers<Outcome<T>>();
  const terminalFailures = new FailureTracker();
  const input = new InputAdapter(context.stdin, terminalFailures);
  const output = new OutputAdapter(context.stderr, terminalFailures);
  let failure: Failure = { present: false };
  const View = build(settled.resolve);

  let renderer: ReturnType<typeof ink.render> | undefined;
  let exited: Promise<unknown> | undefined;
  let outcome: Outcome<T> | undefined;
  try {
    renderer = ink.render(react.createElement(ink.Text, null, ""), {
      stdout: output,
      stdin: input,
      stderr: output,
      exitOnCtrlC: false,
      interactive: true,
      patchConsole: false,
    });
    exited = renderer.waitUntilExit();
    renderer.rerender(react.createElement(View));
    const result = await Promise.race([
      settled.promise,
      exited,
      terminalFailures.promise.then((error) => {
        throw error;
      }),
    ]);
    if (result === undefined) {
      throw new Error(`${label} renderer exited before the dialog completed`);
    }
    outcome = result as Outcome<T>;
  } catch (reason) {
    failure = { present: true, reason };
  } finally {
    let unmounted = false;
    for (let attempt = 0; renderer && !unmounted && attempt < 2; attempt++) {
      try {
        renderer.unmount();
        unmounted = true;
      } catch (reason) {
        failure = recordFailure(failure, terminalFailures.failure);
        failure = recordFailure(failure, { present: true, reason });
      }
    }
    input.stopForwarding();
    if (unmounted && exited) {
      try {
        await exited;
      } catch (reason) {
        failure = recordFailure(failure, terminalFailures.failure);
        failure = recordFailure(failure, { present: true, reason });
      }
    }
    input.cleanup();
    await output.flush();
    output.cleanup();
    failure = recordFailure(failure, terminalFailures.failure);
  }

  if (failure.present) throw failure.reason;
  return outcome?.type === "completed" ? outcome.value : undefined;
}

/** The key the capability is registered under, which is also the specifier its
 * contract is published at — one string rather than two that have to be kept
 * agreeing, and one a package other than this one could not claim. The plugin
 * keeps its own bare identity name below: that names the plugin, and a
 * capability provider claiming no command namespace has nothing to collide
 * over. */
const dialogsKey = "@fx/tx/dialogs";

const identity: PluginIdentity = Object.freeze({ name: "dialogs" });

const definition: PluginDefinition = Object.freeze({
  identity,
  load(): Plugin {
    return ({ context, dependencies, register, registrations }) => {
      const { react, ink } = dependencies;
      const session: DialogSession = { context, dependencies };

      /**
       * The components for one mount, built around the theme resolved for the
       * stream the provider draws to.
       *
       * Resolved while a dialog is mounted rather than while this plugin
       * initializes, for two reasons the registry fixes: a plugin reading
       * during its own initialization sees only what committed before it, and
       * the theme provider is composed ahead of its consumers. Reading here
       * sees every committed provider and every committed override.
       */
      const components = () => {
        const theme = requireThemeCapability(registrations).theme(
          context.stderr,
        );
        const Frame = createFrame(react, ink, theme);
        return { Frame, Entry: createEntry(react, ink, Frame) };
      };

      const SelectView = createSelectView(react, ink);

      /**
       * The embeddable select, created once here so every read of the
       * capability yields the same function and a host rendering it again keeps
       * its state rather than remounting it.
       *
       * Its first render validates the request it was mounted with and
       * resolves its theme, both once per mount: a request `select` would
       * reject throws there, before anything of the component's own is drawn.
       * The request is held from then on — a component presents the question it
       * was mounted with, and a host asking another one mounts another.
       */
      function Select<T>({
        request,
        width,
        height,
        isActive,
        onSubmit,
        onCancel,
      }: SelectProps<T>) {
        const [mounted] = react.useState(() => {
          requireSelectableRequest(request);
          return {
            components: components(),
            request: {
              message: request.message,
              options: request.options,
              headers: request.headers ?? [],
              filter: request.filter ?? "typed",
              expandKey: request.expand ?? "enter",
            },
          };
        });
        return react.createElement(SelectView<T>, {
          ...mounted,
          width,
          height,
          isActive,
          onSubmit,
          onCancel,
        });
      }

      /**
       * The embeddable input, created once for the same reason as `Select`.
       * It holds the dialog's one animation subscription, which runs only while
       * the input is active: an active input always has its caret on screen, so
       * it needs no other activity test, and an inactive one draws no caret and
       * so has nothing to animate.
       */
      function Input({
        request,
        width,
        isActive,
        onSubmit,
        onCancel,
      }: InputProps) {
        const [mounted] = react.useState(() => ({
          ...components(),
          message: request.message,
          initialValue: request.initialValue,
        }));
        /** Read through a ref, so a host passing fresh callbacks on every
         * render hands the entry nothing new to answer with. */
        const callbacks = react.useRef({ onSubmit, onCancel });
        callbacks.current = { onSubmit, onCancel };
        /** Set once the entry has called back, which stops the caret's timer
         * where it stood: a settled input keeps drawing its last frame for as
         * long as its host keeps it mounted, rather than blinking on. */
        const [finished, setFinished] = react.useState(false);
        const { time, reset } = ink.useAnimation({
          interval: animationInterval,
          isActive: isActive && !finished,
        });
        return react.createElement(mounted.Entry, {
          message: mounted.message,
          width,
          isActive,
          initialValue: mounted.initialValue,
          caret: isActive && onPhase(time, animationInterval),
          onEdit: reset,
          onSubmit: (value: string) => {
            setFinished(true);
            callbacks.current.onSubmit(value);
          },
          onCancel: () => {
            setFinished(true);
            callbacks.current.onCancel();
          },
        });
      }

      const dialogs: Dialogs = {
        async input(request: InputRequest) {
          // Read before anything else, as the destructured parameter this
          // replaced was: a missing request rejects here rather than inside a
          // session that has already taken the terminal.
          const { message, initialValue } = request;
          requireInteractiveStreams(context, "An input dialog");
          // Resolved ahead of the session as well as by the mount, so a `tx`
          // composed without exactly one theme rejects before any terminal
          // state changes rather than inside a renderer it then has to restore.
          requireThemeCapability(registrations);

          return runDialog<string>(session, "Input", (settle) => {
            // Measured here rather than by the component, so a resize
            // re-renders the root and the input lays itself out again against
            // the terminal's new width.
            const Root = () => {
              const { columns } = ink.useWindowSize();
              return react.createElement(Input, {
                request:
                  initialValue === undefined
                    ? { message }
                    : { message, initialValue },
                width: columns,
                isActive: true,
                onSubmit: (value: string) =>
                  settle({ type: "completed", value }),
                onCancel: () => settle({ type: "cancelled" }),
              });
            };
            return Root;
          });
        },

        async select<T>(request: SelectRequest<T>) {
          requireSelectableRequest(request);
          requireInteractiveStreams(context, "A select dialog");
          requireThemeCapability(registrations);

          return runDialog<SelectResult<T>>(session, "Select", (settle) => {
            /** The terminal's rows less one: the row that keeps the dialog
             * strictly shorter than the terminal, so Ink never reads it as
             * full-screen and clears what was on screen before it opened. */
            const Root = () => {
              const { columns, rows } = ink.useWindowSize();
              return react.createElement(Select<T>, {
                request,
                width: columns,
                height: rows - 1,
                isActive: true,
                onSubmit: (value: SelectResult<T>) =>
                  settle({ type: "completed", value }),
                onCancel: () => settle({ type: "cancelled" }),
              });
            };
            return Root;
          });
        },

        Input,
        Select,
      };

      register<Dialogs>(dialogsKey, dialogs);
    };
  },
});

export default definition;
