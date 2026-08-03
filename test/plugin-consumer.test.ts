import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };

const repositoryRoot = join(import.meta.dir, "..");

function expectSuccess(result: {
  readonly stdout: { toString(): string };
  readonly stderr: { toString(): string };
  readonly exitCode: number;
}): void {
  if (result.exitCode !== 0) {
    throw new Error(`${result.stdout.toString()}${result.stderr.toString()}`);
  }
  expect(result.exitCode).toBe(0);
}

test("a production-only consumer can import the Plugin type", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "tx-plugin-consumer-"));

  try {
    const packageArchive = join(
      temporaryRoot,
      `${packageMetadata.name}-${packageMetadata.version}.tgz`,
    );
    const consumerRoot = join(temporaryRoot, "consumer");
    await mkdir(consumerRoot);
    await writeFile(
      join(consumerRoot, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { tx: `file:${packageArchive}` },
      }),
    );
    await writeFile(
      join(consumerRoot, "plugin.ts"),
      `import type { Plugin } from "tx/plugin";

const plugin: Plugin = ({ command }) => {
  command("hello", (_args, context) => {
    context.stdout.write("hello\\n");
  });
};

export default plugin;
`,
    );
    await writeFile(
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
    );

    expectSuccess(
      Bun.spawnSync(
        [
          process.execPath,
          "pm",
          "pack",
          "--destination",
          temporaryRoot,
          "--ignore-scripts",
          "--quiet",
        ],
        { cwd: repositoryRoot },
      ),
    );
    expectSuccess(
      Bun.spawnSync(
        [
          process.execPath,
          "install",
          "--production",
          "--offline",
          "--ignore-scripts",
        ],
        { cwd: consumerRoot },
      ),
    );
    await cp(
      join(repositoryRoot, "plugins", "marketplace"),
      join(consumerRoot, "plugins", "marketplace"),
      { recursive: true },
    );
    expectSuccess(
      Bun.spawnSync(
        [
          join(repositoryRoot, "node_modules", ".bin", "tsc"),
          "--project",
          consumerRoot,
        ],
        { cwd: consumerRoot },
      ),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
