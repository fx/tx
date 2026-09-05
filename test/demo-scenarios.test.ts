import { describe, expect, test } from "bun:test";
import {
  type Dialogs,
  type InputRequest,
  isScenario,
  order,
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

/** A dialogs double that answers immediately and records what it was asked,
 * so what a scenario presents can be asserted without a terminal. */
function recordingDialogs(): {
  readonly dialogs: Dialogs;
  readonly inputs: InputRequest[];
  readonly selects: SelectRequest<unknown>[];
} {
  const inputs: InputRequest[] = [];
  const selects: SelectRequest<unknown>[] = [];
  return {
    inputs,
    selects,
    dialogs: {
      async input(request) {
        inputs.push(request);
        return "answered";
      },
      async select<T>(request: SelectRequest<T>) {
        selects.push(request as SelectRequest<unknown>);
        const [first] = request.options;
        if (!first) throw new Error("a select with no options");
        return { value: first.value, values: {} } as SelectResult<T>;
      },
    },
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
    "%s labels every option it offers",
    (_, request) => {
      for (const options of columns(request)) {
        const labels = options.map((option) => option.label);
        expect(labels.every((label) => label !== "")).toBe(true);
        expect(new Set(labels).size).toBe(labels.length);
        const values = options.map((option) => option.value);
        expect(new Set(values).size).toBe(values.length);
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
    expect(usage).toContain("Usage: demo [scenario]");
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
      const { dialogs, inputs, selects } = recordingDialogs();
      const scenario = scenarios[name];

      const result = await present(dialogs, name);

      if (scenario.kind === "input") {
        expect(inputs).toEqual([scenario.request]);
        expect(selects).toEqual([]);
        expect(result).toBe("answered");
        return;
      }
      expect(selects).toEqual([scenario.request]);
      expect(inputs).toEqual([]);
      expect(result).toEqual({
        value: scenario.request.options[0]?.value,
        values: {},
      });
    },
  );
});
