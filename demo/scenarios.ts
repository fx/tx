/**
 * The demo's catalogue: what each scenario shows and the exact dialog it
 * presents.
 *
 * Everything here is a pure value or a pure builder, so the whole catalogue can
 * be asserted without a terminal. Rendering it — and waiting for the person
 * in front of it — is `./index.ts`, which is as thin as it can be made.
 *
 * The dialog vocabulary is restated here rather than imported: the capability
 * is internal to the dialogs plugin, so its types are not a public export and a
 * consumer describes structurally what it asks for, exactly as the plugin's own
 * tests do.
 */

export type TextField = {
  readonly type: "text";
  readonly name: string;
  readonly message: string;
  readonly initialValue?: string;
};
export type SelectRequest<T> = {
  readonly message: string;
  readonly options: readonly SelectOption<T>[];
  readonly filter?: "typed" | "always";
  readonly expand?: "enter" | "tab";
};
export type SelectOption<T> = {
  readonly label: string;
  readonly value: T;
  readonly fields?: readonly TextField[];
  readonly dialog?: SelectRequest<T> | TextField;
};
export type InputRequest = {
  readonly message: string;
  readonly initialValue?: string;
};
export type SelectResult<T> = {
  readonly value: T;
  readonly values: Readonly<Record<string, string>>;
};
export type Dialogs = {
  input(request: InputRequest): Promise<string | undefined>;
  select<T>(request: SelectRequest<T>): Promise<SelectResult<T> | undefined>;
};

/** One scenario: the line the help text gives it, and the request it presents.
 * The two kinds are the two dialogs there are to show. */
export type Scenario =
  | {
      readonly kind: "input";
      readonly description: string;
      readonly request: InputRequest;
    }
  | {
      readonly kind: "select";
      readonly description: string;
      readonly request: SelectRequest<string>;
    };

const branches = [
  "main",
  "release/1.4",
  "release/1.5",
  "release/2.0-rc",
  "feature/dialog-animation",
  "feature/dialog-filter",
  "feature/norton-panel",
  "feature/select-viewport",
  "fix/caret-phase",
  "fix/overflow-indicator",
  "fix/raw-mode-restore",
  "chore/bump-ink",
  "chore/coverage",
  "docs/plugins",
  "docs/dialogs-spec",
  "spike/wide-glyphs-😀-and-CJK-漢字",
];

/** The branches as a column of plain choices: the same list under either
 * filter setting, which is what makes the two a comparison. */
function branchOptions(): readonly SelectOption<string>[] {
  return branches.map((label) => ({ label, value: label }));
}

/** The scripts a package or app exposes: a column of plain options, which is
 * where a walk through the tree ends. */
function scripts(
  name: string,
  ...names: readonly string[]
): SelectRequest<string> {
  return {
    message: `Run in ${name}`,
    options: names.map((script) => ({
      label: script,
      value: `${name}:${script}`,
    })),
  };
}

/** Long enough to overflow its column, so the second level shows the ▲/▼
 * counts set into the frame's edges. The last one is deliberately wide: its
 * glyphs take two terminal columns each, and the column is padded in columns
 * rather than in characters. */
const packages = [
  "core",
  "cli",
  "config",
  "dialogs",
  "filter",
  "frame",
  "logger",
  "marketplace",
  "plugin-api",
  "registry",
  "storage",
  "telemetry",
  "updater",
  "viewport",
  "国际化-i18n 😀",
];

/**
 * A monorepo to walk: three levels deep, with columns of very different
 * lengths beside each other, one long enough to scroll, and two leaves that
 * are not lists at all — a text field and a pair of collected fields. Wide
 * enough overall that a narrow terminal has to start dropping columns off its
 * left.
 */
function targets(expand?: "enter" | "tab"): SelectRequest<string> {
  return {
    message: "Pick a target",
    ...(expand === undefined ? {} : { expand }),
    options: [
      {
        label: "apps",
        value: "apps",
        dialog: {
          message: "Pick an app",
          options: [
            {
              label: "web",
              value: "web",
              dialog: scripts(
                "web",
                "build",
                "dev",
                "test",
                "lint",
                "typecheck",
              ),
            },
            {
              label: "admin",
              value: "admin",
              dialog: scripts("admin", "build", "dev"),
            },
            {
              label: "docs-site",
              value: "docs-site",
              dialog: scripts("docs-site", "build"),
            },
          ],
        },
      },
      {
        label: "packages",
        value: "packages",
        dialog: {
          message: "Pick a package",
          options: packages.map((name) => ({
            label: name,
            value: name,
            dialog: scripts(name, "build", "test", "lint"),
          })),
        },
      },
      {
        label: "infra",
        value: "infra",
        dialog: {
          message: "Pick an action",
          options: [
            {
              label: "deploy…",
              value: "deploy",
              // A text field rather than a list: it renders as its own panel
              // under the browser instead of as another column.
              dialog: {
                type: "text",
                name: "environment",
                message: "Which environment?",
                initialValue: "staging",
              },
            },
            {
              label: "rollback…",
              value: "rollback",
              // Collected fields reached three levels in, to show a collection
              // running under a browser rather than under a flat list.
              fields: [
                { type: "text", name: "service", message: "Which service?" },
                {
                  type: "text",
                  name: "revision",
                  message: "Which revision?",
                  initialValue: "HEAD~1",
                },
              ],
            },
            { label: "status", value: "status" },
          ],
        },
      },
      { label: "everything", value: "everything" },
    ],
  };
}

/** The order the scenarios run in when the demo is given no argument, and so
 * the order the help text lists them in. */
export const order = [
  "input",
  "select",
  "filter",
  "shownfilter",
  "fields",
  "nested",
  "tab",
  "leaf",
] as const;

export type ScenarioName = (typeof order)[number];

export function isScenario(value: string): value is ScenarioName {
  return (order as readonly string[]).includes(value);
}

export const scenarios = {
  input: {
    kind: "input",
    description: "standalone input with an initial value",
    request: {
      message: "What should the release be called?",
      initialValue: "spring",
    },
  },

  select: {
    kind: "select",
    description: "short list, no sub-dialogs",
    request: {
      message: "Pick a bump",
      options: [
        { label: "patch", value: "patch" },
        { label: "minor", value: "minor" },
        { label: "major", value: "major" },
        { label: "prerelease", value: "prerelease" },
      ],
    },
  },

  filter: {
    kind: "select",
    description: "long list: start typing and it narrows",
    request: { message: "Pick a branch", options: branchOptions() },
  },

  shownfilter: {
    kind: "select",
    description: "long list whose filter is shown before you type",
    request: {
      message: "Pick a branch (filter shown)",
      options: branchOptions(),
      filter: "always",
    },
  },

  fields: {
    kind: "select",
    description: "select whose option collects input fields",
    request: {
      message: "Where should this go?",
      options: [
        { label: "origin", value: "origin" },
        { label: "upstream", value: "upstream" },
        { label: "fork", value: "fork" },
        {
          // Typing filters whatever the list's length, and this escape hatch
          // stays visible however hard you filter — it declares fields, and a
          // filter never hides the caller's "none of these" answer.
          label: "Somewhere else…",
          value: "custom",
          fields: [
            { type: "text", name: "name", message: "Remote name" },
            {
              type: "text",
              name: "url",
              message: "Remote URL",
              initialValue: "https://",
            },
          ],
        },
      ],
    },
  },

  nested: {
    kind: "select",
    description:
      "three-level column browser: lists, a scrolling column, two leaves",
    request: targets(),
  },

  tab: {
    kind: "select",
    // The same tree under the other binding: Enter takes the row it is on
    // whether or not it leads anywhere, and Tab is what opens it. Selecting
    // `apps` here resolves with "apps" instead of drilling into it.
    description: "the same tree with opening bound to Tab instead of Enter",
    request: targets("tab"),
  },

  leaf: {
    kind: "select",
    description: "select whose option opens a text input leaf",
    request: {
      message: "Pick a tag",
      options: [
        { label: "stable", value: "stable" },
        {
          label: "custom…",
          value: "custom",
          dialog: { type: "text", name: "tag", message: "Tag name" },
        },
      ],
    },
  },
} as const satisfies Record<ScenarioName, Scenario>;

/** Presents one scenario and resolves with what the person answered, or
 * `undefined` if they cancelled. The only dispatch in the catalogue: which of
 * the two dialogs a scenario is. */
export async function present(
  dialogs: Dialogs,
  name: ScenarioName,
): Promise<unknown> {
  const scenario = scenarios[name];
  if (scenario.kind === "input") return await dialogs.input(scenario.request);
  return await dialogs.select(scenario.request);
}

const nameWidth = Math.max(...order.map((name) => name.length));

/** The help text, written from the catalogue so a scenario cannot be listed
 * with a description the catalogue does not carry, or listed at all without
 * being in it. */
export const usage = `Usage: bun run demo [scenario]

Showcase every dialog: ${order.join(", ")}.

${order
  .map((name) => `  ${name.padEnd(nameWidth)}  ${scenarios[name].description}`)
  .join("\n")}

A ▸ marks an option that opens a sub-dialog: Enter or → opens it as the next
column, ← or Esc backs out. Typing always filters the column you are in.`;
