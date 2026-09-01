import { describe, expect, test } from "bun:test";
import {
  type Config,
  type ConfiguredMarketplace,
  ConfiguredMarketplaceNameCollisionError,
  forgetConfiguredMarketplace,
  isConfiguredMarketplaceList,
  marketplaceConfigKey,
  readConfiguredMarketplaces,
  recordConfiguredMarketplace,
  requireConfigCapability,
  resolveConfiguredMarketplaces,
} from "../plugins/marketplace/configured.ts";
import type {
  MarketplaceListing,
  MarketplaceOperations,
  ResolvedMarketplace,
} from "../plugins/marketplace/manager.ts";

class MemoryConfig implements Config {
  readonly calls: unknown[][] = [];
  value: readonly ConfiguredMarketplace[] | undefined;

  constructor(value?: readonly ConfiguredMarketplace[]) {
    this.value = value;
  }

  define<T>(key: string, guard: (value: unknown) => value is T): void {
    this.calls.push(["define", key, guard]);
  }

  async read<T>(key: string): Promise<T | undefined> {
    this.calls.push(["read", key]);
    return this.value as T | undefined;
  }

  async write<T>(key: string, value: T): Promise<void> {
    this.calls.push(["write", key, value]);
    this.value = value as readonly ConfiguredMarketplace[];
  }
}

class ResolvingManager implements MarketplaceOperations {
  readonly calls: unknown[][] = [];
  readonly names: Readonly<Record<string, string>>;

  constructor(names: Readonly<Record<string, string>> = {}) {
    this.names = names;
  }

  async resolve(source: string, requestedName?: string) {
    this.calls.push(["resolve", source, requestedName]);
    return {
      name: requestedName ?? this.names[source] ?? source,
      source: `safe:${source}`,
    };
  }

  async add(
    source: string,
    requestedName?: string,
  ): Promise<ResolvedMarketplace> {
    return this.resolve(source, requestedName);
  }

  async list(): Promise<readonly MarketplaceListing[]> {
    return [];
  }

  async pin(): Promise<string> {
    return "unused";
  }

  async remove(): Promise<void> {}

  async unpin(): Promise<void> {}
}

describe("configured marketplace shape", () => {
  test.each<[unknown]>(
    [
      undefined,
      null,
      {},
      [null],
      [[]],
      [{}],
      [{ source: 1 }],
      [{ source: "repo", name: 1 }],
    ].map((value) => [value]),
  )("rejects malformed value %#", (value) => {
    expect(isConfiguredMarketplaceList(value)).toBe(false);
  });

  test.each<[unknown]>(
    [
      [],
      [{ source: "" }],
      [{ source: "repo", name: "" }],
      [{ source: "repo", future: true }],
      [{ source: "one" }, { source: "one" }],
    ].map((value) => [value]),
  )("accepts structurally valid value %#", (value) => {
    expect(isConfiguredMarketplaceList(value)).toBe(true);
  });

  test("rejects duplicate explicit names with a dedicated actionable error", () => {
    expect(() =>
      isConfiguredMarketplaceList([
        { source: "one", name: "same" },
        { source: "two", name: "same" },
      ]),
    ).toThrow(ConfiguredMarketplaceNameCollisionError);
    expect(() =>
      isConfiguredMarketplaceList([
        { source: "one", name: "same" },
        { source: "two", name: "same" },
      ]),
    ).toThrow('name "same" appears more than once');
  });

  test("requires exactly one config registration", () => {
    const config = new MemoryConfig();
    expect(requireConfigCapability(<T>() => [config as T])).toBe(config);
    expect(() => requireConfigCapability(<T>(): readonly T[] => [])).toThrow(
      "found 0",
    );
    expect(() =>
      requireConfigCapability(<T>() => [config as T, config as T]),
    ).toThrow("found 2");
  });
});

describe("configured marketplace persistence", () => {
  test("defines the exact key and treats an absent value as an empty list", async () => {
    const config = new MemoryConfig();
    expect(await readConfiguredMarketplaces(config)).toEqual([]);
    expect(config.calls[0]?.slice(0, 2)).toEqual([
      "define",
      marketplaceConfigKey,
    ]);
    expect(config.calls[1]).toEqual(["read", marketplaceConfigKey]);
  });

  test("upserts at the first match, collapses matches, and preserves unrelated order", async () => {
    const config = new MemoryConfig([
      { source: "derived-first" },
      { source: "before", name: "before" },
      { source: "explicit", name: "target" },
      { source: "derived-last" },
      { source: "after", name: "after" },
    ]);
    const manager = new ResolvingManager({
      "derived-first": "target",
      "derived-last": "target",
    });
    const added = { name: "target", source: "safe-target@v1" };

    await recordConfiguredMarketplace(config, manager, added);

    expect(config.value).toEqual([
      added,
      { source: "before", name: "before" },
      { source: "after", name: "after" },
    ]);
    expect(manager.calls).toEqual([
      ["resolve", "derived-first", undefined],
      ["resolve", "derived-last", undefined],
    ]);
  });

  test("appends a newly configured marketplace", async () => {
    const config = new MemoryConfig([{ source: "one", name: "one" }]);
    await recordConfiguredMarketplace(config, new ResolvingManager(), {
      name: "two",
      source: "safe-two",
    });
    expect(config.value).toEqual([
      { source: "one", name: "one" },
      { source: "safe-two", name: "two" },
    ]);
  });

  test("removes explicit and derived matches while preserving the rest", async () => {
    const config = new MemoryConfig([
      { source: "derived" },
      { source: "keep", name: "keep" },
      { source: "explicit", name: "target" },
    ]);
    await forgetConfiguredMarketplace(
      config,
      new ResolvingManager({ derived: "target" }),
      "target",
    );
    expect(config.value).toEqual([{ source: "keep", name: "keep" }]);
  });
});

describe("configured marketplace resolution", () => {
  test("pre-resolves every entry in order", async () => {
    const manager = new ResolvingManager({ first: "one", second: "two" });
    expect(
      await resolveConfiguredMarketplaces(
        [{ source: "first" }, { source: "second", name: "chosen" }],
        manager,
      ),
    ).toEqual([
      { name: "one", source: "safe:first" },
      { name: "chosen", source: "safe:second" },
    ]);
  });

  test.each([
    [
      "explicit and derived",
      [{ source: "first", name: "same" }, { source: "second" }],
    ],
    ["two derived", [{ source: "first" }, { source: "second" }]],
  ])("rejects %s collisions", async (_label, entries) => {
    await expect(
      resolveConfiguredMarketplaces(
        entries,
        new ResolvingManager({ first: "same", second: "same" }),
      ),
    ).rejects.toThrow(ConfiguredMarketplaceNameCollisionError);
  });
});
