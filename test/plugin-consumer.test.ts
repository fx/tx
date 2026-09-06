import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };

const repositoryRoot = join(import.meta.dir, "..");

function run(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): { readonly stdout: string; readonly stderr: string } {
  const result = Bun.spawnSync(command, { cwd, env });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) throw new Error(`${stdout}${stderr}`);
  return { stdout, stderr };
}

test("the packed package installs a standalone CLI and every published contract", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "tx-package-"));

  try {
    run([process.execPath, "run", "build"], repositoryRoot);
    const pack = run(
      [
        "npm",
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        temporaryRoot,
      ],
      repositoryRoot,
    );
    const packed = JSON.parse(pack.stdout) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    expect(packed).toHaveLength(1);
    expect(packed[0]?.filename).toBe(
      `${packageMetadata.name.slice(1).replace("/", "-")}-${packageMetadata.version}.tgz`,
    );
    // Exact rather than a containment check: a published subpath whose types
    // reach a file outside `files` resolves against the repository and fails
    // against the installed package, which is the one failure mode the
    // repository's own type check cannot see. The consumer below imports every
    // subpath from the tarball, so this list and that import together stand
    // for the closure the package has to be over its published contracts.
    expect(packed[0]?.files.map(({ path }) => path).sort()).toEqual([
      "LICENSE",
      "README.md",
      "dist/tx",
      "package.json",
      "plugins/config/contract.ts",
      "plugins/dialogs/contract.ts",
      "plugins/grid/contract.ts",
      "plugins/theme/contract.ts",
      "plugins/theme/override-contract.ts",
      "src/context.ts",
      "src/plugin.ts",
    ]);

    const packageArchive = join(temporaryRoot, packed[0]?.filename ?? "");
    const packedMetadata = JSON.parse(
      run(
        ["tar", "-xOf", packageArchive, "package/package.json"],
        temporaryRoot,
      ).stdout,
    ) as typeof packageMetadata;
    expect(packedMetadata.name).toBe(packageMetadata.name);
    expect(packedMetadata.version).toBe(packageMetadata.version);
    expect(packedMetadata.bin).toEqual({ tx: "./dist/tx" });
    expect(packedMetadata.os).toEqual(["linux"]);
    expect(packedMetadata.cpu).toEqual(["x64"]);
    expect(packedMetadata.libc).toEqual(["glibc"]);

    const consumerRoot = join(temporaryRoot, "consumer");
    await mkdir(consumerRoot);
    await Promise.all([
      writeFile(
        join(consumerRoot, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          dependencies: { "@fx/tx": `file:${packageArchive}` },
        }),
      ),
      writeFile(
        join(consumerRoot, "plugin.ts"),
        `import type { Command, Plugin } from "@fx/tx/plugin";
import type { Config, ConfigValidator } from "@fx/tx/config";
import type { Dialogs, SelectRequest } from "@fx/tx/dialogs";
import type { Grid, GridSelectRow, Row } from "@fx/tx/grid";
import type { Appearance, Hue, Theme, ThemeVariable, Theming } from "@fx/tx/theme";
import type { ThemeOverride } from "@fx/tx/theme-override";

interface Greeter {
  greet(name?: string): string;
}

const greeter: Greeter = {
  greet: (name) => \`hello \${name ?? "world"}\`,
};

// The capability's own vocabulary, imported rather than restated: a member
// this package stopped publishing fails the consumer's build here.
const loud: Hue = "magenta";
const emphasis: ThemeVariable = "strong";
const override: ThemeOverride = { [emphasis]: { bold: true, hue: loud } };

// The grid's vocabulary is declared over the theme's, so importing it makes
// the consumer resolve one published contract through another. That is the
// closure the packed file list above stands for: a cell naming a theme
// variable type checks here only if the tarball carries both contracts.
const cells: Row = ["greeter", { text: "ready", variable: emphasis }];

// A guard typed by the published contract rather than by a restated function
// type. The consumer owns what its own key means; the capability only ever
// asks it this.
const isGreeting: ConfigValidator<string> = (value): value is string =>
  typeof value === "string";
// The dialogs vocabulary, imported at the key the capability is read from
// rather than restated as the part this consumer happens to send. The
// contract publishes what a request may hold; it publishes no rendering, so
// nothing behind this import is a view, a matcher, or React's element type.
const question: SelectRequest<string> = {
  message: "Greet whom?",
  options: [{ label: "world", value: "world" }],
};
const row: GridSelectRow<string, string> = {
  cells,
  value: "greeter",
  actions: [{ label: "greet", value: "greet" }],
};

const plugin: Plugin = ({ command, context, register, registrations }) => {
  register<Greeter>("greeter", greeter);
  // The key and the specifier its contract is imported from are one string.
  register<ThemeOverride>("@fx/tx/theme-override", override);
  command((namespace: Command) => {
    namespace.description("Greet from an external plugin");
    namespace
      .command("hello")
      .description("Say hello")
      .argument("[name]", "who to greet")
      .option("--loud", "shout the greeting")
      .action(async (name: string | undefined, options: { loud?: boolean }) => {
        const available: readonly Greeter[] = registrations<Greeter>("greeter");
        const greeting = available[0]?.greet(name) ?? greeter.greet(name);
        // Read while the command runs, exactly as a bundled consumer does, and
        // typed by the published contract rather than by a local copy.
        const theming: readonly Theming[] = registrations<Theming>("@fx/tx/theme");
        const theme: Theme | undefined = theming[0]?.theme(context.stderr);
        const appearance: Appearance = theme?.appearance(emphasis) ?? {};
        const shown = appearance.bold ? greeting.toUpperCase() : greeting;
        context.stdout.write(\`\${options.loud ? shown.toUpperCase() : shown}\\n\`);
        // Read the same way and typed the same way: the grid's key is the
        // specifier its contract came from, so a printed grid and a driven one
        // are both checked against what the package published.
        const grid: Grid | undefined = registrations<Grid>("@fx/tx/grid")[0];
        grid?.print({ stream: context.stdout, rows: [cells] });
        await grid?.select({ message: greeting, rows: [row] });
        // The config capability, read and typed the same way. Its contract is
        // reachable on its own: nothing behind this import is a store, a path,
        // or the marketplace plugin that used to be the only place the shape
        // was exported from.
        const config: Config | undefined =
          registrations<Config>("@fx/tx/config")[0];
        config?.define("greeting", isGreeting);
        await config?.write("greeting", greeting);
        // The dialogs capability, read and typed the same way. What an absent
        // or repeated provider means stays this consumer's decision: the
        // contract types the values under the key and answers nothing about
        // how many there are.
        const dialogs: Dialogs | undefined =
          registrations<Dialogs>("@fx/tx/dialogs")[0];
        await dialogs?.select(question);
      });
  });
};

export default plugin;
`,
      ),
      // The whole consumer, its own plugin sources included. Those name one
      // another by `.ts` path, which is what `allowImportingTsExtensions` is
      // for here — a property of how this consumer writes its own imports, not
      // something importing the published subpaths asks for. The two projects
      // below are what pin that distinction.
      writeFile(
        join(consumerRoot, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ESNext",
            module: "Preserve",
            moduleResolution: "Bundler",
            allowImportingTsExtensions: true,
          },
          include: ["plugin.ts", "plugins/**/*.ts"],
        }),
      ),
      // Exactly the settings [the plugin guide](../docs/manual/plugins.md)
      // tells a consumer of the published subpaths it needs, over the module
      // that imports every one of them and nothing else: a `moduleResolution`
      // that reads an `exports` map, with no `allowImportingTsExtensions`
      // beside it. Requiring that option would force `noEmit` or
      // `emitDeclarationOnly` on every consumer, so a raw-TypeScript `types`
      // target growing a need for it is a change to what the guide promises,
      // and it fails here rather than in a reader's project.
      writeFile(
        join(consumerRoot, "tsconfig.published.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ESNext",
            module: "Preserve",
            moduleResolution: "Bundler",
          },
          include: ["plugin.ts"],
        }),
      ),
      // The other resolution mode the guide names, under the two conditions it
      // states TypeScript imposes: `module` matching the resolution, and an
      // importer that is an ES module — which the consumer's own `type`:
      // `module` above supplies.
      writeFile(
        join(consumerRoot, "tsconfig.node16.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ESNext",
            module: "Node16",
            moduleResolution: "node16",
          },
          include: ["plugin.ts"],
        }),
      ),
    ]);

    run(
      [
        process.execPath,
        "install",
        "--production",
        "--offline",
        "--ignore-scripts",
      ],
      consumerRoot,
    );
    await cp(
      join(repositoryRoot, "plugins", "marketplace"),
      join(consumerRoot, "plugins", "marketplace"),
      { recursive: true },
    );
    const binary = join(consumerRoot, "node_modules", ".bin", "tx");
    const runtimePath = join(temporaryRoot, "runtime-path");
    await mkdir(runtimePath);
    expect(
      run([binary, "--version"], consumerRoot, {
        ...process.env,
        PATH: runtimePath,
      }),
    ).toEqual({ stdout: `${packageMetadata.version}\n`, stderr: "" });

    for (const project of [
      consumerRoot,
      "tsconfig.published.json",
      "tsconfig.node16.json",
    ]) {
      run(
        [
          join(repositoryRoot, "node_modules", ".bin", "tsc"),
          "--project",
          project,
        ],
        consumerRoot,
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}, 120_000);
