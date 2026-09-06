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
      .action((name: string | undefined, options: { loud?: boolean }) => {
        const available: readonly Greeter[] = registrations<Greeter>("greeter");
        const greeting = available[0]?.greet(name) ?? greeter.greet(name);
        // Read while the command runs, exactly as a bundled consumer does, and
        // typed by the published contract rather than by a local copy.
        const theming: readonly Theming[] = registrations<Theming>("@fx/tx/theme");
        const theme: Theme | undefined = theming[0]?.theme(context.stderr);
        const appearance: Appearance = theme?.appearance(emphasis) ?? {};
        const shown = appearance.bold ? greeting.toUpperCase() : greeting;
        context.stdout.write(\`\${options.loud ? shown.toUpperCase() : shown}\\n\`);
      });
  });
};

export default plugin;
`,
      ),
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

    run(
      [
        join(repositoryRoot, "node_modules", ".bin", "tsc"),
        "--project",
        consumerRoot,
      ],
      consumerRoot,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}, 120_000);
