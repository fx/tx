const streams: typeof import("node:stream") = require("node:stream");

import type {
  CommandContext,
  CoreDependencies,
  Plugin,
  PluginDefinition,
  PluginIdentity,
} from "@fx/tx/plugin";

type TextField = {
  readonly type: "text";
  readonly name: string;
  readonly message: string;
  readonly initialValue?: string;
};

type SelectOption<T> = {
  readonly label: string;
  readonly value: T;
  readonly fields?: readonly TextField[];
};

type SelectRequest<T> = {
  readonly message: string;
  readonly options: readonly SelectOption<T>[];
};

type SelectResult<T> = {
  readonly value: T;
  readonly values: Readonly<Record<string, string>>;
};

type InputRequest = {
  readonly message: string;
  readonly initialValue?: string;
};

type Dialogs = {
  input(request: InputRequest): Promise<string | undefined>;
  select<T>(request: SelectRequest<T>): Promise<SelectResult<T> | undefined>;
};

type Outcome<T> =
  | { readonly type: "completed"; readonly value: T }
  | { readonly type: "cancelled" };

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

/** Rejects a declaration that could never be collected, before any terminal
 * state changes: an option marked user-provided by an empty field list asks for
 * nothing, and a repeated name would let one field overwrite another's value.
 * Names only have to be unique within the option declaring them, because only
 * one option is ever collected. */
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
}

/** A control sequence Ink did not resolve to a key, as it reaches a handler:
 * Ink strips the leading escape, leaving the introducer, any parameter and
 * intermediate bytes, and the final byte. Ink reports the sequences it knows
 * as an empty entry, so anything still shaped like one is an unrecognized key
 * rather than typed text. Shape is all there is to go on — see REVIEW.md — so
 * this covers the CSI form only, and a paste that is exactly a CSI body enters
 * nothing. */
const unresolvedControlSequence = /^\[\[?[\x20-\x3f]*[\x40-\x7e]$/;

/** Everything a chunk carries that a terminal would display, in order. Control
 * characters drop out, so a pasted line survives while the newline ending it
 * does not, and an unrecognized control sequence contributes nothing at all
 * rather than leaking its payload. */
function printableText(entry: string): string {
  if (unresolvedControlSequence.test(entry)) return "";
  let printable = "";
  for (const character of entry) {
    const code = character.codePointAt(0) as number;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!control) printable += character;
  }
  return printable;
}

type DialogElement = ReturnType<CoreDependencies["react"]["createElement"]>;

type DialogView = () => DialogElement;

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

type EntryProps = {
  readonly message: string;
  readonly initialValue: string | undefined;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
};

/**
 * The one text entry implementation, used both by a standalone `input` and by
 * each field of a chosen user-provided option, so entry, editing, submission,
 * and cancellation behave identically in either place. Remounting it under a
 * fresh key starts the next field from that field's own initial value.
 */
function createEntry(
  react: CoreDependencies["react"],
  ink: CoreDependencies["ink"],
) {
  return function Entry({
    message,
    initialValue,
    onSubmit,
    onCancel,
  }: EntryProps) {
    const entered = react.useRef(initialValue ?? "");
    const [value, setValue] = react.useState(entered.current);
    ink.useInput((entry, key) => {
      if (key.escape || (key.ctrl && entry === "c")) {
        onCancel();
      } else if (key.return) {
        onSubmit(entered.current);
      } else if (key.backspace) {
        entered.current = Array.from(entered.current).slice(0, -1).join("");
        setValue(entered.current);
      } else if (!key.ctrl && !key.meta) {
        const appended = printableText(entry);
        if (appended.length > 0) {
          entered.current += appended;
          setValue(entered.current);
        }
      }
    });

    return react.createElement(
      ink.Box,
      { flexDirection: "column" },
      react.createElement(ink.Text, null, message),
      react.createElement(ink.Text, null, value),
    );
  };
}

/** The option a user-provided choice committed to, held while its fields are
 * collected so a later navigation attempt cannot change what is submitted. */
type Collection<T> = {
  readonly value: T;
  readonly fields: readonly TextField[];
};

const identity: PluginIdentity = Object.freeze({ name: "dialogs" });

const definition: PluginDefinition = Object.freeze({
  identity,
  load(): Plugin {
    return ({ context, dependencies, register }) => {
      const { react, ink } = dependencies;
      const session: DialogSession = { context, dependencies };
      const Entry = createEntry(react, ink);

      const dialogs: Dialogs = {
        async input({ message, initialValue }: InputRequest) {
          requireInteractiveStreams(context, "An input dialog");

          return runDialog<string>(session, "Input", (settle) => {
            const Input = () =>
              react.createElement(Entry, {
                message,
                initialValue,
                onSubmit: (value: string) =>
                  settle({ type: "completed", value }),
                onCancel: () => settle({ type: "cancelled" }),
              });
            return Input;
          });
        },

        async select<T>({ message, options }: SelectRequest<T>) {
          if (options.length === 0) {
            throw new Error("A select dialog requires at least one option");
          }
          requireCollectableFields(options);
          requireInteractiveStreams(context, "A select dialog");

          return runDialog<SelectResult<T>>(session, "Select", (settle) => {
            const cancel = () => settle({ type: "cancelled" });

            const Select = () => {
              const active = react.useRef(0);
              const [activeIndex, setActiveIndex] = react.useState(0);
              /** Set the moment a user-provided option is chosen; its presence
               * is what makes the option list stop accepting input. */
              const collecting = react.useRef<Collection<T> | undefined>(
                undefined,
              );
              /** Prototype-free, because a field name is an opaque caller key:
               * `__proto__` would otherwise reach the inherited setter and the
               * value would vanish instead of being collected. */
              const collected = react.useRef<Record<string, string>>(
                Object.create(null) as Record<string, string>,
              );
              const field = react.useRef(0);
              const [fieldIndex, setFieldIndex] = react.useState(-1);

              ink.useInput((value, key) => {
                if (key.escape || (key.ctrl && value === "c")) {
                  cancel();
                  return;
                }
                // Ink delivers every key parsed out of one chunk in a single
                // synchronous pass, so this list keeps receiving input after
                // the Enter that began collection, before the field entry has
                // mounted. Everything but cancellation is declined from then
                // on; cancellation is answered above, at every stage.
                if (collecting.current) return;
                if (key.return) {
                  const option = options[active.current] as SelectOption<T>;
                  if (option.fields) {
                    collecting.current = {
                      value: option.value,
                      fields: option.fields,
                    };
                    setFieldIndex(0);
                  } else {
                    settle({
                      type: "completed",
                      value: { value: option.value, values: {} },
                    });
                  }
                } else if (key.upArrow) {
                  active.current = Math.max(0, active.current - 1);
                  setActiveIndex(active.current);
                } else if (key.downArrow) {
                  active.current = Math.min(
                    options.length - 1,
                    active.current + 1,
                  );
                  setActiveIndex(active.current);
                }
              });

              const submitField = (entered: string) => {
                const collection = collecting.current as Collection<T>;
                const current = collection.fields[field.current] as TextField;
                collected.current[current.name] = entered;
                const next = field.current + 1;
                if (next < collection.fields.length) {
                  field.current = next;
                  setFieldIndex(next);
                } else {
                  settle({
                    type: "completed",
                    value: {
                      value: collection.value,
                      values: { ...collected.current },
                    },
                  });
                }
              };

              const children: DialogElement[] = [
                react.createElement(ink.Text, { key: "message" }, message),
                ...options.map((option, index) =>
                  react.createElement(
                    ink.Text,
                    { key: `option-${index}` },
                    `${index === activeIndex ? ">" : " "} ${option.label}`,
                  ),
                ),
              ];
              if (fieldIndex >= 0) {
                const collection = collecting.current as Collection<T>;
                const pending = collection.fields[fieldIndex] as TextField;
                children.push(
                  react.createElement(Entry, {
                    key: `field-${fieldIndex}`,
                    message: pending.message,
                    initialValue: pending.initialValue,
                    onSubmit: submitField,
                    onCancel: cancel,
                  }),
                );
              }

              return react.createElement(
                ink.Box,
                { flexDirection: "column" },
                ...children,
              );
            };
            return Select;
          });
        },
      };

      register<Dialogs>("dialogs", dialogs);
    };
  },
});

export default definition;
