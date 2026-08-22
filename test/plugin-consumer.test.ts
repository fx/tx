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

test("the packed package installs a standalone CLI and public plugin types", async () => {
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
    expect(packed[0]?.files.map(({ path }) => path).sort()).toEqual([
      "LICENSE",
      "README.md",
      "dist/tx",
      "package.json",
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

interface Greeter {
  greet(name?: string): string;
}

const greeter: Greeter = {
  greet: (name) => \`hello \${name ?? "world"}\`,
};

const plugin: Plugin = ({ command, context, register, registrations }) => {
  register<Greeter>("greeter", greeter);
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
        context.stdout.write(\`\${options.loud ? greeting.toUpperCase() : greeting}\\n\`);
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
