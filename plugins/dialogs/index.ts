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

          const Select = () => {
            const [active, setActive] = react.useState(0);
            const { exit } = ink.useApp();
            ink.useInput((input, key) => {
              if (key.escape || (key.ctrl && input === "c")) {
                exit({ type: "cancelled" } satisfies Selection<T>);
              } else if (key.return) {
                const option = options[active] as SelectOption<T>;
                exit({
                  type: "selected",
                  value: option.value,
                } satisfies Selection<T>);
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

          const renderer = ink.render(react.createElement(Select), {
            stdout: context.stderr,
            stdin: context.stdin,
            stderr: context.stderr,
            exitOnCtrlC: false,
            interactive: true,
            patchConsole: false,
          });
          const outcome = (await renderer.waitUntilExit()) as Selection<T>;
          return outcome.type === "selected" ? outcome.value : undefined;
        },
      };

      register<Dialogs>("dialogs", dialogs);
    },
};

export default definition;
