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

          let complete!: (selection: Selection<T>) => void;
          const selected = new Promise<Selection<T>>((resolve) => {
            complete = resolve;
          });

          const Select = () => {
            const [active, setActive] = react.useState(0);
            ink.useInput((input, key) => {
              if (key.escape || (key.ctrl && input === "c")) {
                complete({ type: "cancelled" });
              } else if (key.return) {
                const option = options[active];
                if (option) complete({ type: "selected", value: option.value });
              } else if (key.upArrow) {
                setActive((index) => Math.max(0, index - 1));
              } else if (key.downArrow) {
                setActive((index) => Math.min(options.length - 1, index + 1));
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
                  `${index === active ? ">" : " "} ${option.label}`,
                ),
              ),
            );
          };

          let renderer: ReturnType<typeof ink.render> | undefined;
          let primaryFailure: unknown;
          try {
            renderer = ink.render(react.createElement(Select), {
              stdout: context.stderr,
              stdin: context.stdin,
              stderr: context.stderr,
              exitOnCtrlC: false,
              interactive: true,
              patchConsole: false,
            });

            const outcome = await Promise.race([
              selected,
              renderer.waitUntilExit().then(
                () => {
                  throw new Error(
                    "Select renderer exited before the dialog completed",
                  );
                },
                (error: unknown) => {
                  throw error;
                },
              ),
            ]);
            renderer.unmount();
            await renderer.waitUntilExit();
            return outcome.type === "selected" ? outcome.value : undefined;
          } catch (error) {
            primaryFailure = error;
          } finally {
            if (renderer) {
              try {
                renderer.unmount();
                await renderer.waitUntilExit();
              } catch (cleanupFailure) {
                primaryFailure ??= cleanupFailure;
              }
            }
          }
          throw primaryFailure;
        },
      };

      register<Dialogs>("dialogs", dialogs);
    },
};

export default definition;
