const streams: typeof import("node:stream") = require("node:stream");

import type { PluginDefinition } from "@fx/tx/plugin";

type SelectOption<T> = {
  readonly label: string;
  readonly value: T;
};

type SelectRequest<T> = {
  readonly message: string;
  readonly options: readonly SelectOption<T>[];
};

type Dialogs = {
  select<T>(request: SelectRequest<T>): Promise<T | undefined>;
};

type Selection<T> =
  | { readonly type: "selected"; readonly value: T }
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
    for (let attempt = 0; this.#ownedReferences > 0 && attempt < 3; attempt++) {
      this.unref();
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

const definition: PluginDefinition = {
  identity: { name: "dialogs" },
  load:
    () =>
    ({ context, dependencies, register }) => {
      const { react, ink } = dependencies;

      const dialogs: Dialogs = {
        async select<T>({ message, options }: SelectRequest<T>) {
          if (options.length === 0) {
            throw new Error("A select dialog requires at least one option");
          }
          if (!context.stdin.isTTY || !context.stderr.isTTY) {
            throw new Error(
              "A select dialog requires interactive input and error streams",
            );
          }

          const selected = Promise.withResolvers<Selection<T>>();
          const terminalFailures = new FailureTracker();
          const input = new InputAdapter(context.stdin, terminalFailures);
          const output = new OutputAdapter(context.stderr, terminalFailures);
          let failure: Failure = { present: false };

          const Select = () => {
            const active = react.useRef(0);
            const [activeIndex, setActiveIndex] = react.useState(0);
            ink.useInput((value, key) => {
              if (key.escape || (key.ctrl && value === "c")) {
                selected.resolve({ type: "cancelled" });
              } else if (key.return) {
                const option = options[active.current] as SelectOption<T>;
                selected.resolve({ type: "selected", value: option.value });
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

            return react.createElement(
              ink.Box,
              { flexDirection: "column" },
              react.createElement(ink.Text, null, message),
              ...options.map((option, index) =>
                react.createElement(
                  ink.Text,
                  { key: index },
                  `${index === activeIndex ? ">" : " "} ${option.label}`,
                ),
              ),
            );
          };

          let renderer: ReturnType<typeof ink.render> | undefined;
          let exited: Promise<unknown> | undefined;
          let outcome: Selection<T> | undefined;
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
            renderer.rerender(react.createElement(Select));
            const result = await Promise.race([
              selected.promise,
              exited,
              terminalFailures.promise.then((error) => {
                throw error;
              }),
            ]);
            if (result === undefined) {
              throw new Error(
                "Select renderer exited before the dialog completed",
              );
            }
            outcome = result as Selection<T>;
          } catch (reason) {
            failure = { present: true, reason };
          } finally {
            let unmounted = false;
            for (
              let attempt = 0;
              renderer && !unmounted && attempt < 2;
              attempt++
            ) {
              try {
                renderer.unmount();
                unmounted = true;
              } catch (reason) {
                failure = recordFailure(failure, { present: true, reason });
              }
            }
            input.stopForwarding();
            if (unmounted && exited) {
              try {
                await exited;
              } catch (reason) {
                failure = recordFailure(failure, { present: true, reason });
              }
            }
            input.cleanup();
            output.cleanup();
            failure = recordFailure(failure, terminalFailures.failure);
          }

          if (failure.present) throw failure.reason;
          return outcome?.type === "selected" ? outcome.value : undefined;
        },
      };

      register<Dialogs>("dialogs", dialogs);
    },
};

export default definition;
