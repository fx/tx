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

type FailureTracker = {
  readonly promise: Promise<unknown>;
  readonly value: () => unknown;
  fail(error: unknown): void;
};

function failureTracker(): FailureTracker {
  const failed = Promise.withResolvers<unknown>();
  let failure: unknown;
  return {
    promise: failed.promise,
    value: () => failure,
    fail(error) {
      if (failure !== undefined) return;
      failure = error;
      failed.resolve(error);
    },
  };
}

function controlledOutput(stderr: NodeJS.WriteStream): {
  readonly stream: NodeJS.WriteStream;
  readonly failures: FailureTracker;
} {
  const failures = failureTracker();
  const stream = new Proxy(stderr, {
    get(target, property) {
      if (property === "write") {
        return (...args: unknown[]) => {
          try {
            return Reflect.apply(target.write, target, args);
          } catch (error) {
            failures.fail(error);
            const callback = args.at(-1);
            if (typeof callback === "function") {
              queueMicrotask(() => Reflect.apply(callback, undefined, []));
            }
            return true;
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { stream, failures };
}

function controlledInput(stdin: NodeJS.ReadStream): {
  readonly stream: NodeJS.ReadStream;
  cleanup(): unknown;
} {
  const initialReadableListeners = new Set(stdin.listeners("readable"));
  const failures = failureTracker();
  let references = 0;
  let rawModeNeedsRestoring = false;
  let stream: NodeJS.ReadStream;

  stream = new Proxy(stdin, {
    get(target, property) {
      if (property === "ref") {
        return () => {
          target.ref();
          references++;
          return stream;
        };
      }
      if (property === "unref") {
        return () => {
          try {
            target.unref();
            references = Math.max(0, references - 1);
          } catch (error) {
            failures.fail(error);
          }
          return stream;
        };
      }
      if (property === "setRawMode") {
        return (enabled: boolean) => {
          if (enabled) {
            rawModeNeedsRestoring = true;
            target.setRawMode(true);
          } else {
            try {
              target.setRawMode(false);
              rawModeNeedsRestoring = false;
            } catch (error) {
              failures.fail(error);
            }
          }
          return stream;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    stream,
    cleanup() {
      for (const listener of stdin.listeners("readable")) {
        if (!initialReadableListeners.has(listener)) {
          stdin.removeListener("readable", listener);
        }
      }
      if (rawModeNeedsRestoring) {
        try {
          stdin.setRawMode(false);
          rawModeNeedsRestoring = false;
        } catch (error) {
          failures.fail(error);
        }
      }
      while (references > 0) {
        references--;
        try {
          stdin.unref();
        } catch (error) {
          failures.fail(error);
        }
      }
      return failures.value();
    },
  };
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
          const input = controlledInput(context.stdin);
          const output = controlledOutput(context.stderr);

          const Select = () => {
            const active = react.useRef(0);
            const [activeIndex, setActiveIndex] = react.useState(0);
            ink.useInput((input, key) => {
              if (key.escape || (key.ctrl && input === "c")) {
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

          const renderer = ink.render(react.createElement(ink.Text, null, ""), {
            stdout: output.stream,
            stdin: input.stream,
            stderr: output.stream,
            exitOnCtrlC: false,
            interactive: true,
            patchConsole: false,
          });
          const previousBeforeExitListeners = new Set(
            process.listeners("beforeExit"),
          );
          const exited = renderer.waitUntilExit();
          const rendererBeforeExitListeners = process
            .listeners("beforeExit")
            .filter((listener) => !previousBeforeExitListeners.has(listener));
          let outcome: Selection<T> | undefined;
          let primaryFailure: unknown;

          try {
            renderer.rerender(react.createElement(Select));
            outcome = await Promise.race([
              selected.promise,
              exited.then(
                () => {
                  throw new Error(
                    "Select renderer exited before the dialog completed",
                  );
                },
                (error: unknown) => {
                  throw error;
                },
              ),
              output.failures.promise.then((error) => {
                throw error;
              }),
            ]);
          } catch (error) {
            primaryFailure = error;
          } finally {
            let unmounted = false;
            try {
              renderer.unmount();
              unmounted = true;
            } catch (error) {
              primaryFailure ??= error;
            }
            if (unmounted) {
              try {
                await exited;
              } catch (error) {
                primaryFailure ??= error;
              }
            } else {
              for (const listener of rendererBeforeExitListeners) {
                process.removeListener("beforeExit", listener);
              }
            }
            const outputFailure = output.failures.value();
            primaryFailure ??= outputFailure;
            const inputFailure = input.cleanup();
            primaryFailure ??= inputFailure;
          }

          if (primaryFailure !== undefined) throw primaryFailure;
          return outcome?.type === "selected" ? outcome.value : undefined;
        },
      };

      register<Dialogs>("dialogs", dialogs);
    },
};

export default definition;
