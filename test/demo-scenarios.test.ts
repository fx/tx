import { describe, expect, test } from "bun:test";
import {
  type Cell,
  type Dialogs,
  type Grid,
  type GridRequest,
  type GridSelection,
  type GridSelectRequest,
  type InputRequest,
  isScenario,
  order,
  type PrintRequest,
  present,
  type SelectOption,
  type SelectRequest,
  type SelectResult,
  scenarios,
  type TextField,
  usage,
} from "../demo/scenarios.ts";

/** Every options list the request reaches, its own included: what the dialogs
 * plugin walks when it validates a request, and so what these assertions have
 * to walk to say the catalogue satisfies it. */
function columns(
  request: SelectRequest<string>,
): readonly (readonly SelectOption<string>[])[] {
  const found: (readonly SelectOption<string>[])[] = [request.options];
  for (const { dialog } of request.options) {
    if (dialog !== undefined && "options" in dialog)
      found.push(...columns(dialog));
  }
  return found;
}

/** Every request the walk reaches, its own included: a column is a request of
 * its own, and it is the request that carries the headers naming that column's
 * fields. */
function requests(
  request: SelectRequest<string>,
): readonly SelectRequest<string>[] {
  const found: SelectRequest<string>[] = [request];
  for (const { dialog } of request.options) {
    if (dialog !== undefined && "options" in dialog)
      found.push(...requests(dialog));
  }
  return found;
}

/** Every option the request reaches, at any depth. */
function reachableOptions(
  request: SelectRequest<string>,
): readonly SelectOption<string>[] {
  return columns(request).flat();
}

/** Every text field the request reaches: the collected field lists and the
 * leaves that are a field rather than a column. */
function textFields(request: SelectRequest<string>): readonly TextField[] {
  const found: TextField[] = [];
  for (const option of reachableOptions(request)) {
    found.push(...(option.fields ?? []));
    if (option.dialog !== undefined && !("options" in option.dialog)) {
      found.push(option.dialog);
    }
  }
  return found;
}

/** Every select request in the catalogue, named, so a failure says which
 * scenario carries the malformed one. */
const selectRequests: readonly (readonly [string, SelectRequest<string>])[] =
  order.flatMap((name) => {
    const scenario = scenarios[name];
    return scenario.kind === "select"
      ? [[name, scenario.request] as const]
      : [];
  });

/** Every standalone input request in the catalogue, named the same way. */
const inputRequests: readonly (readonly [string, InputRequest])[] =
  order.flatMap((name) => {
    const scenario = scenarios[name];
    return scenario.kind === "input" ? [[name, scenario.request] as const] : [];
  });

/** Every printed grid in the catalogue, named the same way. */
const gridRequests: readonly (readonly [string, PrintRequest])[] =
  order.flatMap((name) => {
    const scenario = scenarios[name];
    return scenario.kind === "grid" ? [[name, scenario.request] as const] : [];
  });

/** Every interactive grid in the catalogue, named the same way. */
const rowRequests: readonly (readonly [
  string,
  GridSelectRequest<string, string>,
])[] = order.flatMap((name) => {
  const scenario = scenarios[name];
  return scenario.kind === "rows" ? [[name, scenario.request] as const] : [];
});

/** Every cell a grid request carries, whichever notation it was written in. */
function cells(request: PrintRequest): readonly Cell[] {
  return request.rows.flatMap((row) =>
    row.map((cell) => (typeof cell === "string" ? { text: cell } : cell)),
  );
}

/** Surfaces that answer immediately and record what they were asked, so what a
 * scenario presents can be asserted without a terminal. */
function recordingSurfaces(): {
  readonly surfaces: {
    readonly dialogs: Dialogs;
    readonly grid: Grid;
    readonly stream: { write(chunk: string): unknown };
  };
  readonly inputs: InputRequest[];
  readonly selects: SelectRequest<unknown>[];
  readonly prints: GridRequest[];
  readonly driven: GridSelectRequest<string, string>[];
  written(): string;
} {
  const inputs: InputRequest[] = [];
  const selects: SelectRequest<unknown>[] = [];
  const prints: GridRequest[] = [];
  const driven: GridSelectRequest<string, string>[] = [];
  let written = "";
  const stream = {
    write(chunk: string) {
      written += chunk;
      return true;
    },
  };
  const dialogs: Dialogs = {
    async input(request) {
      inputs.push(request);
      return "answered";
    },
    // The first option's value, with the same caveat `firstRow` carries in
    // test/demo.test.ts: where that option opens a sub-dialog the real dialogs
    // would resolve with whatever finally completed instead. Sound here for
    // the same reason — what these assertions are about is which surface a
    // scenario is presented on, not what a dialog answers.
    async select<T>(request: SelectRequest<T>) {
      selects.push(request as SelectRequest<unknown>);
      const [first] = request.options;
      if (!first) throw new Error("a select with no options");
      return { value: first.value, values: {} } as SelectResult<T>;
    },
  };
  const grid: Grid = {
    print(request) {
      prints.push(request);
      request.stream.write("printed\n");
    },
    async select<T, A>(request: GridSelectRequest<T, A>) {
      driven.push(request as unknown as GridSelectRequest<string, string>);
      const [first] = request.rows;
      if (!first) throw new Error("an interactive grid with no rows");
      const [action] = first.actions ?? [];
      // The first row, and its first action where it declared any: the answer
      // a reader taking every default would give, and the one that carries
      // both halves when there are two to carry.
      return (
        action === undefined
          ? { value: first.value }
          : { value: first.value, action: action.value }
      ) as GridSelection<T, A>;
    },
  };
  return {
    inputs,
    selects,
    prints,
    driven,
    surfaces: { dialogs, grid, stream },
    written: () => written,
  };
}

describe("demo catalogue", () => {
  test("lists every scenario it carries, once each", () => {
    expect(Object.keys(scenarios).sort()).toEqual([...order].sort());
    expect(new Set(order).size).toBe(order.length);
  });

  test("resolves every listed name and nothing else", () => {
    for (const name of order) expect(isScenario(name)).toBe(true);
    expect(isScenario("everything")).toBe(false);
    // A record's inherited keys are not scenarios: the check reads the list,
    // not the object, so a prototype member can never dispatch.
    expect(isScenario("constructor")).toBe(false);
    expect(isScenario("toString")).toBe(false);
  });

  test.each(selectRequests)(
    "%s asks something at every depth",
    (_, request) => {
      expect(request.message).not.toBe("");
      for (const options of columns(request))
        expect(options.length).toBeGreaterThan(0);
    },
  );

  test.each(selectRequests)(
    "%s gives every option display text of one shape",
    (_, request) => {
      for (const options of columns(request)) {
        // A column declares one shape throughout and the same number of cells
        // on every row of it: the two things a request is rejected for, so the
        // catalogue has to satisfy both to be presentable at all.
        const shapes = options.map((option) =>
          option.cells === undefined ? "label" : "cells",
        );
        expect(new Set(shapes).size).toBe(1);
        const rows = options.map((option) => option.cells ?? [option.label]);
        expect(new Set(rows.map((row) => row.length)).size).toBe(1);
        expect(
          rows.every((row) =>
            row.every((text) => text !== undefined && text !== ""),
          ),
        ).toBe(true);
        // Nothing is listed twice, and no two options carry the same value.
        const drawn = rows.map((row) => row.join("|"));
        expect(new Set(drawn).size).toBe(drawn.length);
        const values = options.map((option) => option.value);
        expect(new Set(values).size).toBe(values.length);
      }
    },
  );

  test.each(selectRequests)(
    "%s heads a column of cells and names every field of it",
    (_, request) => {
      for (const column of requests(request)) {
        const headers = column.headers;
        if (headers === undefined) continue;
        expect(headers.every((header) => header !== "")).toBe(true);
        // Headers belong to a column of cells and name every one of its
        // fields, which is what the plugin rejects a request for otherwise.
        for (const option of column.options) {
          expect(option.cells?.length).toBe(headers.length);
        }
      }
    },
  );

  test.each(selectRequests)(
    "%s collects fields that can be filled",
    (_, request) => {
      for (const option of reachableOptions(request)) {
        if (!option.fields) continue;
        expect(option.fields.length).toBeGreaterThan(0);
        const names = option.fields.map((field) => field.name);
        expect(new Set(names).size).toBe(names.length);
      }
    },
  );

  test.each(selectRequests)(
    "%s declares well-formed text fields",
    (_, request) => {
      for (const field of textFields(request)) {
        expect(field.type).toBe("text");
        expect(field.name).not.toBe("");
        expect(field.message).not.toBe("");
      }
    },
  );

  test.each(inputRequests)("%s asks a question", (_, request) => {
    expect(request.message).not.toBe("");
  });

  test.each(gridRequests)(
    "%s has rows to show and words for none",
    (_, request) => {
      expect(request.rows.length).toBeGreaterThan(0);
      expect(request.empty).not.toBe("");
      expect(request.summary).not.toBe("");
      for (const cell of cells(request)) expect(cell.text).not.toBe("");
    },
  );

  test.each(rowRequests)(
    "%s asks something over rows that identify themselves",
    (_, request) => {
      expect(request.message).not.toBe("");
      expect(request.rows.length).toBeGreaterThan(0);
      const values = request.rows.map((row) => row.value);
      expect(new Set(values).size).toBe(values.length);
      for (const row of request.rows) {
        // The grid pads a short row rather than rejecting it, but the
        // catalogue is showing a table: every row of this one names every
        // field its headers do.
        expect(row.cells.length).toBe(request.headers?.length ?? 0);
        for (const cell of row.cells) {
          expect(typeof cell === "string" ? cell : cell.text).not.toBe("");
        }
        // An action list is either absent or every label in it says
        // something; the placeholder is for cells alone.
        for (const action of row.actions ?? []) {
          expect(action.label).not.toBe("");
        }
        const actionValues = (row.actions ?? []).map((action) => action.value);
        expect(new Set(actionValues).size).toBe(actionValues.length);
      }
      expect(request.headers?.every((header) => header !== "")).toBe(true);
    },
  );

  test("shows a row that offers actions beside one that offers none", () => {
    // The whole point of declaring actions per row: two rows may offer
    // different ones, and a row computing an empty list is taken on the row
    // alone rather than rejected.
    const counts = scenarios.rows.request.rows.map(
      (row) => (row.actions ?? []).length,
    );

    expect(counts).toContain(0);
    expect(counts.some((count) => count > 0)).toBe(true);
  });

  test("shows the same cells printed and driven", () => {
    // A cell's declared role survives printing and is dropped when the same
    // cell is presented for selection, so the catalogue declares one in both
    // halves and the pair is a comparison rather than an omission.
    const printed = cells(scenarios.grid.request);
    const driven = scenarios.rows.request.rows.flatMap((row) =>
      row.cells.map((cell) =>
        typeof cell === "string" ? { text: cell } : cell,
      ),
    );

    expect(printed.some((cell) => cell.variable !== undefined)).toBe(true);
    expect(driven.some((cell) => cell.variable !== undefined)).toBe(true);
  });

  test("shows both layouts a grid has", () => {
    const table: PrintRequest = scenarios.grid.request;
    const flow: PrintRequest = scenarios.flow.request;

    // A request declaring no layout is a table, so the table scenario says
    // nothing rather than saying "table": the two are a comparison.
    expect(table.layout).toBeUndefined();
    expect(flow.layout).toBe("flow");
    // The table is the one that names columns; a flow ignores headers, so
    // declaring them there would say nothing.
    expect(table.headers?.length).toBeGreaterThan(0);
    expect(flow.headers).toBeUndefined();
  });

  test("shows one list under both filter settings", () => {
    const { request: shown } = scenarios.shownfilter;
    const { request: typed } = scenarios.filter;

    expect(shown.filter).toBe("always");
    // Filtering is never off, so the unfiltered scenario says nothing at all
    // rather than saying "typed": the two differ only in when the filter is on
    // screen, which is what makes them a comparison.
    expect("filter" in typed).toBe(false);
    expect(shown.options.map((option) => option.label)).toEqual(
      typed.options.map((option) => option.label),
    );
  });

  test("shows one tree under both expand bindings", () => {
    const { request: nested } = scenarios.nested;
    const { request: tab } = scenarios.tab;

    expect(nested.expand).toBeUndefined();
    expect(tab.expand).toBe("tab");
    expect(nested.options.map((option) => option.label)).toEqual(
      tab.options.map((option) => option.label),
    );
  });

  test("documents every scenario in its help text", () => {
    expect(usage).toContain("Usage: bun run demo [scenario]");
    for (const name of order) {
      expect(usage).toContain(`  ${name}`);
      expect(usage).toContain(scenarios[name].description);
    }
  });
});

describe("presenting a scenario", () => {
  test.each([...order])(
    "%s presents exactly what it declares",
    async (name) => {
      const { surfaces, inputs, selects, prints, driven, written } =
        recordingSurfaces();
      const scenario = scenarios[name];

      const result = await present(surfaces, name);

      if (scenario.kind === "input") {
        expect(inputs).toEqual([scenario.request]);
        expect(selects).toEqual([]);
        expect(prints).toEqual([]);
        expect(driven).toEqual([]);
        expect(result).toBe("answered");
        return;
      }
      if (scenario.kind === "grid") {
        // The stream is the runner's to supply, so the catalogue carries
        // everything else and nothing more.
        expect(prints).toEqual([
          { ...scenario.request, stream: surfaces.stream },
        ]);
        expect(inputs).toEqual([]);
        expect(selects).toEqual([]);
        expect(driven).toEqual([]);
        expect(written()).toBe("printed\n");
        // A printed grid answers nothing: it is output, not a question.
        expect(result).toBeUndefined();
        return;
      }
      if (scenario.kind === "rows") {
        // A driven grid carries no stream: it draws through the streams the
        // dialogs capability was injected with, so the catalogue's request is
        // handed over exactly as written.
        expect(driven).toEqual([scenario.request]);
        expect(inputs).toEqual([]);
        expect(selects).toEqual([]);
        expect(prints).toEqual([]);
        expect(written()).toBe("");
        const first = scenario.request.rows[0];
        // `toEqual` reads a key holding `undefined` as one that is not there,
        // so this pins what the two halves are and not whether `action` is
        // present — which is what says a row offered none. It is sound here
        // because this row declares actions; repointed at one that does not,
        // it would silently stop testing what it looks like it tests. Where
        // the presence itself is the subject, it is asserted with `"action"
        // in` — see test/grid-select.test.ts.
        expect(result).toEqual({
          value: first?.value,
          action: first?.actions?.[0]?.value,
        });
        return;
      }
      expect(selects).toEqual([scenario.request]);
      expect(inputs).toEqual([]);
      expect(prints).toEqual([]);
      expect(driven).toEqual([]);
      expect(result).toEqual({
        value: scenario.request.options[0]?.value,
        values: {},
      });
    },
  );
});
