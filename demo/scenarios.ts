/**
 * The demo's catalogue: what each scenario shows and the exact dialog it asks
 * or grid it prints.
 *
 * Everything here is a pure value or a pure builder, so the whole catalogue can
 * be asserted without a terminal. Rendering it — and waiting for the person
 * in front of it — is `./index.ts`, which is as thin as it can be made.
 *
 * Every capability's vocabulary is imported from the specifier it is published
 * at — the same string the runner reads that capability from — so the
 * catalogue is checked against the contracts rather than against copies of
 * them that would compile whichever way they moved.
 */

import type {
  Dialogs,
  InputRequest,
  SelectOption,
  SelectRequest,
} from "@fx/tx/dialogs";
import type {
  Grid,
  GridAction,
  GridRequest,
  GridSelectRequest,
  OutputStream,
} from "@fx/tx/grid";
import type { ThemeVariable } from "@fx/tx/theme";

/** A printing request without the stream it goes to, which is the runner's to
 * supply rather than the catalogue's. It is the published request minus that
 * one field rather than a shape of its own, so a field added to the contract
 * reaches the catalogue without being retyped here. */
export type PrintRequest = Omit<GridRequest, "stream">;

/** The surfaces a scenario is presented on: the dialogs it drives, the grid it
 * prints through, and the stream a printed grid goes to. */
export type Surfaces = {
  readonly dialogs: Dialogs;
  readonly grid: Grid;
  readonly stream: OutputStream;
};

/** One scenario: the line the help text gives it, and the request it presents.
 * The kinds are the two dialogs there are to show and the grid that prints
 * instead of asking. */
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
    }
  | {
      readonly kind: "grid";
      readonly description: string;
      readonly request: PrintRequest;
    }
  | {
      readonly kind: "rows";
      readonly description: string;
      readonly request: GridSelectRequest<string, string>;
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

/**
 * A release table: a column of cell options under the headers naming its
 * fields.
 *
 * Deliberately uneven — a one-character version beside a long one, a date
 * beside a dash, and a row whose glyphs take two terminal columns each — so
 * the fields are visibly measured rather than guessed, and typing shows that a
 * term matches inside one cell rather than across the gap between two: `1.6`
 * finds the releases, `alpha` finds only the row whose channel says so, and
 * `1.6.1stable` finds nothing at all.
 */
const releases: SelectRequest<string> = {
  message: "Pick a release",
  headers: ["Version", "Published", "Channel", "Size"],
  options: [
    { cells: ["1.6.1", "2026-09-05", "stable", "1.2 MB"], value: "1.6.1" },
    { cells: ["1.6.0", "2026-08-30", "stable", "1.2 MB"], value: "1.6.0" },
    { cells: ["1.5.9", "2026-08-12", "stable", "980 kB"], value: "1.5.9" },
    { cells: ["2.0.0-rc.1", "2026-09-01", "alpha", "1.4 MB"], value: "2.0-rc" },
    { cells: ["9", "—", "nightly", "1.4 MB"], value: "nightly" },
    { cells: ["1.4.0", "2026-06-30", "国际化 😀", "1.1 MB"], value: "1.4.0" },
    {
      // A cell row leads somewhere exactly as a label row does: the marker is
      // on the column's right edge, past the last field.
      cells: ["custom…", "—", "—", "—"],
      value: "custom",
      dialog: { type: "text", name: "release", message: "Which release?" },
    },
  ],
};

/** One service the fleet holds, before anything turns it into a row. */
type Service = {
  readonly name: string;
  readonly environment: string;
  readonly state: "running" | "degraded" | "retired";
  readonly uptime: string;
};

const services: readonly Service[] = [
  { name: "api", environment: "production", state: "running", uptime: "12d" },
  {
    name: "worker",
    environment: "production",
    state: "running",
    uptime: "12d",
  },
  {
    name: "scheduler",
    environment: "staging",
    state: "degraded",
    uptime: "4h",
  },
  {
    name: "国际化-i18n 😀",
    environment: "staging",
    state: "running",
    uptime: "3d",
  },
  {
    name: "legacy-import",
    environment: "production",
    state: "retired",
    uptime: "—",
  },
];

/** What a state's cell says it is. The role is dropped when the row is
 * presented for selection and kept when the same cells are printed, which is
 * what makes the pair a comparison rather than an omission. */
const stateVariables: Readonly<Record<Service["state"], ThemeVariable>> = {
  running: "positive",
  degraded: "caution",
  retired: "muted",
};

/**
 * The actions a service offers, computed from its state rather than declared
 * once for the grid — which is the shape a consumer writes, and the shape that
 * lets a retired service offer none while its neighbours offer three. An empty
 * list means the row declares no actions and is taken on the row alone; it is
 * not a request the grid rejects.
 */
function serviceActions(
  state: Service["state"],
): readonly GridAction<string>[] {
  if (state === "retired") return [];
  return [
    { label: "connect", value: "connect" },
    { label: "open logs", value: "logs" },
    { label: "restart", value: "restart" },
  ];
}

/**
 * A fleet to drive: rows that identify themselves, actions computed per row,
 * one row left with none, and a name whose glyphs take two terminal columns
 * each so the fields are visibly measured rather than guessed.
 */
const fleet: GridSelectRequest<string, string> = {
  message: "Pick a service",
  headers: ["SERVICE", "ENVIRONMENT", "STATE", "UPTIME"],
  rows: services.map((service) => ({
    cells: [
      service.name,
      service.environment,
      { text: service.state, variable: stateVariables[service.state] },
      { text: service.uptime, align: "end" },
    ],
    value: service.name,
    actions: serviceActions(service.state),
  })),
};

/** The order the scenarios run in when the demo is given no argument, and so
 * the order the help text lists them in. */
export const order = [
  "input",
  "select",
  "filter",
  "shownfilter",
  "cells",
  "fields",
  "nested",
  "tab",
  "leaf",
  "grid",
  "flow",
  "rows",
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

  cells: {
    kind: "select",
    description: "a table: aligned cells under the headers naming them",
    request: releases,
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

  grid: {
    kind: "grid",
    // Everything a printed table has: a header row, a column of counts lined
    // up on its digits, cells naming a role, a row that stops short and is
    // filled out rather than shortened, a cell of wide glyphs measured in the
    // columns it occupies, and a summary a blank line beneath the rows.
    description: "printed table: aligned columns, a right-aligned count, roles",
    request: {
      headers: ["PACKAGE", "STATUS", "TESTS"],
      rows: [
        [
          "core",
          { text: "ready", variable: "positive" },
          { text: "128", align: "end" },
        ],
        [
          "dialogs",
          { text: "ready", variable: "positive" },
          { text: "1042", align: "end" },
        ],
        [
          "marketplace",
          { text: "stale", variable: "caution" },
          { text: "97", align: "end" },
        ],
        [
          "国际化-i18n 😀",
          { text: "ready", variable: "positive" },
          { text: "6", align: "end" },
        ],
        ["telemetry", { text: "failing", variable: "danger" }],
      ],
      empty: "No packages.",
      summary: "5 packages",
    },
  },

  flow: {
    kind: "grid",
    // The same cells with no column meaning: short items filling the width the
    // stream reports, read down each column before across.
    description: "printed flow: short items filling the width, read down first",
    request: {
      layout: "flow",
      rows: packages.map((name) => [name]),
      empty: "No packages.",
      summary: `${packages.length} packages`,
    },
  },

  rows: {
    kind: "rows",
    // The driven half of the same capability: the rows are a select, a row's
    // actions are the column it opens, and the answer carries both. Enter on
    // `legacy-import` resolves on the row alone, because it declares none.
    description: "interactive grid: pick a row, then what to do with it",
    request: fleet,
  },
} as const satisfies Record<ScenarioName, Scenario>;

/** Presents one scenario and resolves with what the person answered, or
 * `undefined` if they cancelled. The only dispatch in the catalogue: which
 * surface a scenario is presented on. A printed grid answers nothing — it is
 * output rather than a question — so it resolves with nothing. */
export async function present(
  { dialogs, grid, stream }: Surfaces,
  name: ScenarioName,
): Promise<unknown> {
  const scenario = scenarios[name];
  if (scenario.kind === "input") return await dialogs.input(scenario.request);
  if (scenario.kind === "grid") {
    grid.print({ ...scenario.request, stream });
    return undefined;
  }
  if (scenario.kind === "rows") return await grid.select(scenario.request);
  return await dialogs.select(scenario.request);
}

const nameWidth = Math.max(...order.map((name) => name.length));

/** The help text, written from the catalogue so a scenario cannot be listed
 * with a description the catalogue does not carry, or listed at all without
 * being in it. */
export const usage = `Usage: bun run demo [scenario]

Showcase every dialog and printed layout: ${order.join(", ")}.

${order
  .map((name) => `  ${name.padEnd(nameWidth)}  ${scenarios[name].description}`)
  .join("\n")}

In a dialog, a ▸ marks an option that opens a sub-dialog: Enter or → opens it
as the next column, ← or Esc backs out, and typing always filters the column
you are in. A printed layout answers nothing and waits for no key, while an
interactive one is driven exactly like any other dialog: a row that offers
actions opens them as the next column, and the answer names both.`;
