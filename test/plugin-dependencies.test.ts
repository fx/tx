import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { importPluginEntry } from "../plugins/marketplace/module.ts";
import { temporaryDirectory, writeFixtureFiles } from "./helpers.ts";

const repositoryRoot = join(import.meta.dir, "..");

/**
 * A dependency tree no compiled executable can resolve by path arithmetic
 * alone, which is all its runtime module resolver does. Every package here is
 * shaped after one that fails against the released executable today:
 *
 * - `exports-only` publishes no `main` and no root `index.js`, so nothing but
 *   its `exports` map names its entry point, and that map selects between two
 *   files by condition.
 * - `exports-only/sub.js` is a subpath export whose name does not match the
 *   file behind it.
 * - `leaf` is reached both directly and as a dependency of `exports-only`, and
 *   its `main` points somewhere other than `index.js`, of which it has none.
 * - `commonjs-tracing` is CommonJS with a dependency of its own, no `exports`
 *   map, and a `main` under `src/` — the shape of `debug`.
 * - `commonjs-numeric` is CommonJS with no dependencies at all and an
 *   extensionless `main` naming a file beside it — the shape of `decimal.js`,
 *   and the case that rules out "packages with dependencies" as the rule.
 * - `shadowed-entry` carries both a `main` and a root `index.js` holding
 *   something else. Path arithmetic finds the `index.js` and resolves,
 *   silently, to the wrong file; this is the only failure of the set that
 *   reports no error at all.
 */
const dependencyTree: Readonly<Record<string, string>> = {
  "node_modules/commonjs-tracing/package.json": JSON.stringify({
    name: "commonjs-tracing",
    version: "1.0.0",
    main: "./src/index.js",
    dependencies: { "commonjs-duration": "*" },
  }),
  "node_modules/commonjs-tracing/src/index.js":
    "const duration = require('commonjs-duration');\nmodule.exports = 'traced in ' + duration(1000);\n",
  "node_modules/commonjs-duration/package.json": JSON.stringify({
    name: "commonjs-duration",
    version: "1.0.0",
    main: "./index",
  }),
  "node_modules/commonjs-duration/index.js":
    "module.exports = (value) => value / 1000 + 's';\n",
  "node_modules/commonjs-numeric/package.json": JSON.stringify({
    name: "commonjs-numeric",
    version: "1.0.0",
    main: "./numeric",
  }),
  "node_modules/commonjs-numeric/numeric.js":
    "module.exports = { scale: (value) => value * 2 };\n",
  "node_modules/shadowed-entry/package.json": JSON.stringify({
    name: "shadowed-entry",
    version: "1.0.0",
    main: "./lib/entry.js",
  }),
  "node_modules/shadowed-entry/lib/entry.js":
    "module.exports = 'declared entry';\n",
  "node_modules/shadowed-entry/index.js":
    "module.exports = 'shadowing index.js';\n",
  "node_modules/exports-only/package.json": JSON.stringify({
    name: "exports-only",
    version: "1.0.0",
    type: "module",
    exports: {
      ".": { bun: "./dist/main.js", default: "./dist/unconditional.js" },
      "./sub.js": "./dist/subpath.js",
    },
    dependencies: { leaf: "*" },
  }),
  "node_modules/exports-only/dist/main.js":
    "import { leaf } from 'leaf';\nexport const main = 'main via ' + leaf;\n",
  "node_modules/exports-only/dist/unconditional.js":
    "export const main = 'unconditional';\n",
  "node_modules/exports-only/dist/subpath.js":
    "import { leaf } from 'leaf';\nexport const sub = 'sub via ' + leaf;\n",
  "node_modules/leaf/package.json": JSON.stringify({
    name: "leaf",
    version: "1.0.0",
    type: "module",
    main: "./lib/leaf.js",
  }),
  "node_modules/leaf/lib/leaf.js": "export const leaf = 'leaf';\n",
};

/**
 * A plugin importing its dependencies both ways a plugin can: eagerly, as the
 * entry module is evaluated, and lazily inside a command action, which is the
 * shape a plugin uses to keep an expensive dependency off the help path.
 */
const pluginEntry = `import { main } from 'exports-only';
import { leaf } from 'leaf';
import traced from 'commonjs-tracing';
import numeric from 'commonjs-numeric';
import shadowed from 'shadowed-entry';

export default ({ command, context }) => {
  command((namespace) => {
    namespace.description('Dependency fixture plugin');
    namespace.command('report').action(async () => {
      const { sub } = await import('exports-only/sub.js');
      context.stdout.write(JSON.stringify({
        main,
        leaf,
        sub,
        traced,
        scaled: numeric.scale(21),
        shadowed,
      }) + '\\n');
    });
  });
};
`;

test("a plugin resolves its dependency tree by Node's rules", async () => {
  const temporaryRoot = await temporaryDirectory("tx-plugin-dependencies-");

  try {
    const dataDirectory = join(temporaryRoot, "data");
    const marketplace = join(dataDirectory, "tx", "marketplaces", "fixture");
    await writeFixtureFiles(marketplace, {
      ".tx/config.json": JSON.stringify({
        plugins: [{ name: "deps", entry: "deps/index.ts" }],
      }),
      // Only `exports-only` is declared. `leaf` is installed as its
      // dependency, and the plugin imports it directly as well.
      "deps/package.json": JSON.stringify({
        name: "dependency-fixture",
        private: true,
        type: "module",
        dependencies: { "exports-only": "*" },
      }),
      "deps/index.ts": pluginEntry,
      ...Object.fromEntries(
        Object.entries(dependencyTree).map(([path, contents]) => [
          `deps/${path}`,
          contents,
        ]),
      ),
    });

    // The released artifact, because this is the runtime whose resolver is at
    // stake: run uncompiled, every one of these imports resolves already.
    const build = Bun.spawnSync([process.execPath, "run", "build"], {
      cwd: repositoryRoot,
    });
    expect(build.exitCode).toBe(0);

    const result = Bun.spawnSync(
      [join(repositoryRoot, "dist", "tx"), "deps", "report"],
      { env: { ...process.env, DEV: "true", XDG_DATA_HOME: dataDirectory } },
    );

    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual({
      main: "main via leaf",
      leaf: "leaf",
      sub: "sub via leaf",
      traced: "traced in 1s",
      scaled: 42,
      // Not "shadowing index.js": the declared entry wins over the root
      // `index.js` that path arithmetic reaches first.
      shadowed: "declared entry",
    });
    expect(result.exitCode).toBe(0);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}, 120_000);

test("a plugin whose dependency is missing reports the specifier", async () => {
  const temporaryRoot = await temporaryDirectory("tx-plugin-unresolved-");

  try {
    await writeFixtureFiles(temporaryRoot, {
      "index.ts": "import 'never-installed';\nexport default () => {};\n",
    });
    const entryPath = join(temporaryRoot, "index.ts");

    const failure = await importPluginEntry(entryPath).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toContain("Cannot resolve dependencies:");
    expect(failure?.message).toContain("never-installed");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("loading the same entry twice registers one loader", async () => {
  const temporaryRoot = await temporaryDirectory("tx-plugin-repeated-");

  try {
    await writeFixtureFiles(temporaryRoot, {
      "index.ts": "export default 'loaded';\n",
      ...dependencyTree,
    });
    const entryPath = join(temporaryRoot, "index.ts");

    const first = (await importPluginEntry(entryPath)) as {
      readonly default: unknown;
    };
    const second = await importPluginEntry(entryPath);

    expect(first.default).toBe("loaded");
    expect(second).toBe(first);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
