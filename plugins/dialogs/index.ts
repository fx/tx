const streams: typeof import("node:stream") = require("node:stream");

import type {
  CommandContext,
  CoreDependencies,
  Plugin,
  PluginDefinition,
  PluginIdentity,
} from "@fx/tx/plugin";
import { animationInterval, onPhase } from "./animation.ts";
import { createEntry } from "./entry.ts";
import { filterIsEnabled } from "./filter.ts";
import { createFrame } from "./frame.ts";
import { createSelectView } from "./select.ts";
import type {
  Dialogs,
  DialogView,
  InputRequest,
  Outcome,
  SelectOption,
  SelectRequest,
  SelectResult,
} from "./types.ts";

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
 */
function requireNonEmptyOptions<T>(options: readonly SelectOption<T>[]): void {
  if (options.length === 0) {
    throw new Error("A select dialog requires at least one option");
  }
  for (const { dialog } of options) {
    if (dialog !== undefined && "options" in dialog) {
      requireNonEmptyOptions(dialog.options);
    }
  }
}

/** Rejects a declaration that could never be collected, before any terminal
 * state changes: an option marked user-provided by an empty field list asks for
 * nothing, and a repeated name would let one field overwrite another's value.
 * Names only have to be unique within the option declaring them, because only
 * one option is ever collected. Every reachable sub-dialog is validated, so a
 * declaration no path walks to can still never render. */
function requireCollectableFields<T>(
  options: readonly SelectOption<T>[],
): void {
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
      requireCollectableFields(dialog.options);
    }
  }
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
      stdout: output as unknown as NodeJS.WriteStream,
      stdin: input as unknown as NodeJS.ReadStream,
      stderr: output as unknown as NodeJS.WriteStream,
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

const identity: PluginIdentity = Object.freeze({ name: "dialogs" });

const definition: PluginDefinition = Object.freeze({
  identity,
  load(): Plugin {
    return ({ context, dependencies, register }) => {
      const { react, ink } = dependencies;
      const session: DialogSession = { context, dependencies };
      const Frame = createFrame(react, ink);
      const Entry = createEntry(react, ink, Frame);

      const dialogs: Dialogs = {
        async input({ message, initialValue }: InputRequest) {
          requireInteractiveStreams(context, "An input dialog");

          return runDialog<string>(session, "Input", (settle) => {
            const Input = () => {
              // The dialog's one animation subscription. A standalone input
              // always has its caret on screen, so it never idles and needs no
              // activity test of its own.
              const { time, reset } = ink.useAnimation({
                interval: animationInterval,
              });
              return react.createElement(Entry, {
                message,
                initialValue,
                caret: onPhase(time, animationInterval),
                onEdit: reset,
                onSubmit: (value: string) =>
                  settle({ type: "completed", value }),
                onCancel: () => settle({ type: "cancelled" }),
              });
            };
            return Input;
          });
        },

        async select<T>({ message, options, filter }: SelectRequest<T>) {
          requireNonEmptyOptions(options);
          requireCollectableFields(options);
          requireInteractiveStreams(context, "A select dialog");

          const filtering = filterIsEnabled(filter, options.length);
          return runDialog<SelectResult<T>>(session, "Select", (settle) =>
            createSelectView(
              react,
              ink,
              { Entry, Frame },
              { message, options, filtering },
              settle,
            ),
          );
        },
      };

      register<Dialogs>("dialogs", dialogs);
    };
  },
});

export default definition;
