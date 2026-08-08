import { describe, expect, test } from "bun:test";
import updatePlugin from "../plugins/update/index.ts";
import {
  createRootProgram,
  dispatch,
  EXIT_FAILURE,
  EXIT_SUCCESS,
} from "../src/commands.ts";
import type {
  PluginDefinition,
  PluginIdentity,
  UpdateItem,
  UpdateParticipant,
  UpdateResult,
} from "../src/plugin.ts";
import { coreDependencies, initializePlugins } from "../src/plugins.ts";
import { type CapturedContext, captureContext } from "./helpers.ts";

/**
 * A participant defined entirely by the test. The driver is specified to know
 * nothing about what it updates, so nothing here reaches a marketplace, the
 * network, or the filesystem.
 */
class StubParticipant implements UpdateParticipant {
  readonly gathered: string[] = [];
  readonly applied: string[] = [];

  constructor(
    private readonly items: readonly UpdateItem[] | Error,
    private readonly results: Readonly<
      Record<string, UpdateResult | Error>
    > = {},
  ) {}

  async gather(): Promise<readonly UpdateItem[]> {
    this.gathered.push("gather");
    if (this.items instanceof Error) throw this.items;
    return this.items;
  }

  apply(item: UpdateItem): UpdateResult {
    this.applied.push(item.name);
    const result = this.results[item.name];
    if (result instanceof Error) throw result;
    if (result) return result;
    return item.available === undefined
      ? { applied: true }
      : { applied: true, version: item.available };
  }
}

function contributor(
  name: string,
  participant: UpdateParticipant,
  parent?: PluginIdentity,
): PluginDefinition {
  return {
    identity: parent ? { name, parent } : { name },
    load: () => (api) => api.update(participant),
  };
}

async function setup(
  context: CapturedContext,
  definitions: readonly PluginDefinition[] = [],
) {
  const { namespaces, failures } = await initializePlugins(
    [...definitions, updatePlugin],
    { context },
  );
  expect(failures).toEqual([]);
  return createRootProgram(coreDependencies, namespaces);
}

const outdated: UpdateItem = {
  name: "alpha",
  current: "1.0.0",
  available: "1.1.0",
  detail: "two commits behind",
};
const current: UpdateItem = { name: "beta", current: "2.0.0" };
const stale: UpdateItem = {
  name: "gamma",
  current: "3.0.0",
  available: "3.1.0",
};

describe("bundled update plugin", () => {
  test("declares its namespace, item argument, and dry-run flag", async () => {
    const context = captureContext();
    const program = await setup(context);

    expect(await dispatch(program, ["--help"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(context.stdoutText()).toMatch(
      /^ +update \[options\] \[items\.\.\.\] +Update everything tx has installed$/m,
    );

    const help = captureContext();
    expect(await dispatch(program, ["update", "--help"], help)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(help.stdoutText()).toContain(
      "Usage: tx update [options] [items...]",
    );
    expect(help.stdoutText()).toContain("--dry-run");
    expect(help.stderrText()).toBe("");
  });

  test("reports nothing to update when no participant is committed", async () => {
    const context = captureContext();
    const program = await setup(context);

    expect(await dispatch(program, ["update"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(context.stdoutText()).toBe("Nothing installed to update.\n");
    expect(context.stderrText()).toBe("");
  });

  test("reports nothing to update when every participant gathers no item", async () => {
    const context = captureContext();
    const participant = new StubParticipant([]);
    const program = await setup(context, [contributor("empty", participant)]);

    expect(await dispatch(program, ["update"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(participant.gathered).toEqual(["gather"]);
    expect(context.stdoutText()).toBe("Nothing installed to update.\n");
  });

  test("does not report nothing installed when the names matched nothing", async () => {
    const context = captureContext();
    const program = await setup(context);

    // The run failed, so the answer an unfiltered run gives would contradict
    // its outcome on the stream a caller reads results from.
    expect(await dispatch(program, ["update", "ghost"], context)).toEqual({
      exitCode: EXIT_FAILURE,
    });
    expect(context.stdoutText()).toBe("");
    expect(context.stderrText()).toBe(
      [
        'Error: No update named "ghost".',
        "Error: Update completed with failures",
        "",
      ].join("\n"),
    );
  });

  test("gathers without applying on a dry run", async () => {
    const context = captureContext();
    const participant = new StubParticipant([outdated, current]);
    const program = await setup(context, [contributor("stub", participant)]);

    expect(await dispatch(program, ["update", "--dry-run"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(context.stdoutText()).toBe(
      ["alpha\t1.0.0\t-> 1.1.0\ttwo commits behind", "beta\t2.0.0\tup to date"]
        .map((line) => `${line}\n`)
        .join(""),
    );
    expect(context.stderrText()).toBe("");
    expect(participant.applied).toEqual([]);
  });

  test("applies what is available, leaving an item with nothing to apply alone", async () => {
    const context = captureContext();
    const participant = new StubParticipant([outdated, current, stale], {
      gamma: { applied: false, detail: "already current" },
    });
    const program = await setup(context, [contributor("stub", participant)]);

    expect(await dispatch(program, ["update"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    // An item reporting nothing available is never handed back to its owner,
    // and one the owner declined to change is not a failure.
    expect(participant.applied).toEqual(["alpha", "gamma"]);
    expect(context.stdoutText()).toBe(
      [
        "alpha\t1.0.0\t-> 1.1.0\ttwo commits behind",
        "beta\t2.0.0\tup to date",
        "gamma\t3.0.0\t-> 3.1.0",
        "alpha\tupdated to 1.1.0",
        "gamma\tnothing to apply\talready current",
      ]
        .map((line) => `${line}\n`)
        .join(""),
    );
    expect(context.stderrText()).toBe("");
  });

  test("reports an applied item that named no version", async () => {
    const context = captureContext();
    const participant = new StubParticipant([stale], {
      gamma: { applied: true },
    });
    const program = await setup(context, [contributor("stub", participant)]);

    expect(await dispatch(program, ["update"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(context.stdoutText()).toEndWith("gamma\tupdated\n");
  });

  test("gathers and applies participants in commit order", async () => {
    const context = captureContext();
    const order: string[] = [];
    const track = (label: string): UpdateParticipant => ({
      gather: () => {
        order.push(`gather:${label}`);
        return [{ name: label, current: "1", available: "2" }];
      },
      apply: () => {
        order.push(`apply:${label}`);
        return { applied: true };
      },
    });
    const program = await setup(context, [
      contributor("first", track("first")),
      contributor("second", track("second")),
    ]);

    expect(await dispatch(program, ["update"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(order).toEqual([
      "gather:first",
      "gather:second",
      "apply:first",
      "apply:second",
    ]);
  });

  test("applies only the items named on the command line", async () => {
    const context = captureContext();
    const participant = new StubParticipant([outdated, stale]);
    const program = await setup(context, [contributor("stub", participant)]);

    expect(await dispatch(program, ["update", "gamma"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(participant.applied).toEqual(["gamma"]);
    expect(context.stdoutText()).toContain("alpha\t1.0.0\t-> 1.1.0");
    expect(context.stdoutText()).toEndWith("gamma\tupdated to 3.1.0\n");
  });

  test("fails a name matching no gathered item while applying the rest", async () => {
    const context = captureContext();
    const participant = new StubParticipant([outdated, current]);
    const program = await setup(context, [contributor("stub", participant)]);

    expect(
      await dispatch(program, ["update", "alpha", "ghost"], context),
    ).toEqual({ exitCode: EXIT_FAILURE });
    expect(participant.applied).toEqual(["alpha"]);
    expect(context.stderrText()).toBe(
      [
        'Error: No update named "ghost".',
        "Error: Update completed with failures",
        "",
      ].join("\n"),
    );
  });

  test("isolates a participant that fails while gathering", async () => {
    const context = captureContext();
    const healthy = new StubParticipant([stale]);
    const program = await setup(context, [
      contributor("broken", new StubParticipant(new Error("remote refused")), {
        name: "marketplace",
      }),
      contributor("healthy", healthy),
    ]);

    expect(await dispatch(program, ["update"], context)).toEqual({
      exitCode: EXIT_FAILURE,
    });
    expect(healthy.applied).toEqual(["gamma"]);
    expect(context.stdoutText()).toBe(
      "gamma\t3.0.0\t-> 3.1.0\ngamma\tupdated to 3.1.0\n",
    );
    expect(context.stderrText()).toBe(
      [
        "Error: Plugin marketplace/broken could not report updates: remote refused",
        "Error: Update completed with failures",
        "",
      ].join("\n"),
    );
  });

  test("isolates an item that fails while applying", async () => {
    const context = captureContext();
    const participant = new StubParticipant([outdated, current, stale], {
      alpha: new Error("checkout is dirty"),
    });
    const program = await setup(context, [contributor("stub", participant)]);

    expect(await dispatch(program, ["update"], context)).toEqual({
      exitCode: EXIT_FAILURE,
    });
    expect(participant.applied).toEqual(["alpha", "gamma"]);
    expect(context.stdoutText()).toEndWith("gamma\tupdated to 3.1.0\n");
    expect(context.stderrText()).toBe(
      [
        "Error: alpha\tfailed: checkout is dirty",
        "Error: Update completed with failures",
        "",
      ].join("\n"),
    );
  });

  test("reports an item carrying its own failure without applying it", async () => {
    const context = captureContext();
    const participant = new StubParticipant([
      {
        name: "alpha",
        current: "1.0.0",
        available: "1.1.0",
        failure: "checkout is missing",
      },
      stale,
    ]);
    const program = await setup(context, [contributor("stub", participant)]);

    expect(await dispatch(program, ["update"], context)).toEqual({
      exitCode: EXIT_FAILURE,
    });
    expect(participant.applied).toEqual(["gamma"]);
    expect(context.stdoutText()).toBe(
      "gamma\t3.0.0\t-> 3.1.0\ngamma\tupdated to 3.1.0\n",
    );
    // The failure replaces what it would have moved to, and its name, current
    // label, and detail are reported with it.
    expect(context.stderrText()).toBe(
      [
        "Error: alpha\t1.0.0\tfailed: checkout is missing",
        "Error: Update completed with failures",
        "",
      ].join("\n"),
    );
  });

  test("fails a dry run whose gathering failed, without applying anything", async () => {
    const context = captureContext();
    const participant = new StubParticipant(new Error("remote refused"));
    const program = await setup(context, [contributor("stub", participant)]);

    expect(await dispatch(program, ["update", "--dry-run"], context)).toEqual({
      exitCode: EXIT_FAILURE,
    });
    expect(participant.applied).toEqual([]);
    expect(context.stdoutText()).toBe("");
    expect(context.stderrText()).toContain(
      "Error: Plugin stub could not report updates: remote refused",
    );
  });

  test("fails a dry run for an item carrying its own failure", async () => {
    const context = captureContext();
    const participant = new StubParticipant([
      { name: "alpha", current: "1.0.0", failure: "checkout is missing" },
    ]);
    const program = await setup(context, [contributor("stub", participant)]);

    expect(await dispatch(program, ["update", "--dry-run"], context)).toEqual({
      exitCode: EXIT_FAILURE,
    });
    expect(participant.applied).toEqual([]);
    expect(context.stderrText()).toContain(
      "Error: alpha\t1.0.0\tfailed: checkout is missing",
    );
  });

  test("treats an empty failure as the failure it is", async () => {
    const context = captureContext();
    const participant = new StubParticipant([
      { name: "alpha", current: "1.0.0", available: "1.1.0", failure: "" },
    ]);
    const program = await setup(context, [contributor("stub", participant)]);

    expect(await dispatch(program, ["update"], context)).toEqual({
      exitCode: EXIT_FAILURE,
    });
    expect(participant.applied).toEqual([]);
    expect(context.stderrText()).toStartWith("Error: alpha\t1.0.0\tfailed: \n");
  });

  test("reports a participant that fails with a non-error value", async () => {
    const context = captureContext();
    const program = await setup(context, [
      contributor("stub", {
        gather: () => {
          throw "plain failure";
        },
        apply: () => ({ applied: false }),
      }),
    ]);

    expect(await dispatch(program, ["update"], context)).toEqual({
      exitCode: EXIT_FAILURE,
    });
    expect(context.stderrText()).toContain(
      "Error: Plugin stub could not report updates: plain failure",
    );
  });
});
