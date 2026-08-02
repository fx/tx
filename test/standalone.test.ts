import { expect, test } from "bun:test";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeGitRepository } from "./helpers.ts";

const repositoryRoot = join(import.meta.dir, "..");

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

test("the production build is a standalone executable", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "tx-standalone-"));

  try {
    const stagedProject = join(temporaryRoot, "project");
    const stagedSource = join(stagedProject, "src");
    const stagedPlugins = join(stagedProject, "plugins");
    const stagedNodeModules = join(stagedProject, "node_modules");
    const binaryPath = join(stagedProject, "dist", "tx");
    const runtimeDirectory = join(temporaryRoot, "runtime");
    await mkdir(stagedProject);
    await Promise.all([
      mkdir(runtimeDirectory),
      cp(join(repositoryRoot, "src"), stagedSource, { recursive: true }),
      cp(join(repositoryRoot, "plugins"), stagedPlugins, { recursive: true }),
      copyFile(
        join(repositoryRoot, "package.json"),
        join(stagedProject, "package.json"),
      ),
      copyFile(
        join(repositoryRoot, "build.ts"),
        join(stagedProject, "build.ts"),
      ),
      symlink(join(repositoryRoot, "node_modules"), stagedNodeModules, "dir"),
    ]);

    const build = Bun.spawnSync([process.execPath, "run", "build"], {
      cwd: stagedProject,
    });

    expect(build.exitCode).toBe(0);
    await Promise.all([
      rm(stagedSource, { recursive: true }),
      rm(stagedPlugins, { recursive: true }),
      rm(stagedNodeModules),
    ]);

    const result = Bun.spawnSync([binaryPath], {
      cwd: runtimeDirectory,
      env: { ...process.env, DEV: "true", PATH: runtimeDirectory },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      "Usage: tx <command>\n\nCommands:\n  marketplace\n",
    );
    expect(result.stderr.toString()).toBe("");

    const marketplace = join(temporaryRoot, "marketplace");
    const dependency = join(marketplace, "dependency");
    const dataDirectory = join(temporaryRoot, "data");
    await Promise.all([
      mkdir(dependency, { recursive: true }),
      mkdir(join(marketplace, "plugins"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(marketplace, "tx.marketplace.json"),
        JSON.stringify({
          plugins: [
            { name: "top", entry: "top.ts" },
            { name: "nested", entry: "plugins/nested.ts" },
          ],
        }),
      ),
      writeFile(
        join(marketplace, "package.json"),
        '{"type":"module","dependencies":{"fixture-dependency":"file:./dependency"}}',
      ),
      writeFile(
        join(dependency, "package.json"),
        '{"name":"fixture-dependency","version":"1.0.0","type":"module","exports":"./index.ts"}',
      ),
      writeFile(
        join(dependency, "index.ts"),
        'export const message = "loaded dependency";',
      ),
      writeFile(
        join(marketplace, "top.ts"),
        `export default ({ command, dependencies }) => {
          globalThis[Symbol.for("tx.standalone.injected")] = {
            react: dependencies.react,
            ink: dependencies.ink,
          };
          command("top", (args, context) => context.stdout.write(JSON.stringify({
            args,
            marketplace: context.marketplace,
            plugin: context.plugin,
          }) + "\\n"));
        };`,
      ),
      writeFile(
        join(marketplace, "plugins", "nested.ts"),
        `import { message } from "fixture-dependency";
        export default ({ command, dependencies }) => {
          const injected = globalThis[Symbol.for("tx.standalone.injected")];
          const sameInstances = injected?.react === dependencies.react &&
            injected?.ink === dependencies.ink;
          command(["nested", "run"], (args, context) => {
            const element = dependencies.react.createElement(
              dependencies.ink.Text,
              null,
              message,
            );
            context.stdout.write(JSON.stringify({
              args,
              marketplace: context.marketplace,
              plugin: context.plugin,
              cwd: context.cwd,
              dependency: message,
              sameInstances,
              elementWorks: element.type === dependencies.ink.Text &&
                element.props.children === message,
            }) + "\\n");
          });
        };`,
      ),
    ]);

    initializeGitRepository(marketplace);

    const { PATH } = process.env;
    const env = {
      ...process.env,
      DEV: "true",
      PATH: `${dirname(process.execPath)}:${PATH ?? ""}`,
      XDG_DATA_HOME: dataDirectory,
    };
    const runStandalone = (args: string[], cwd?: string): CommandResult => {
      const result = Bun.spawnSync([binaryPath, ...args], {
        ...(cwd === undefined ? {} : { cwd }),
        env,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    };
    const add = runStandalone([
      "marketplace",
      "add",
      marketplace,
      "--name",
      "fixture",
    ]);
    expect(add).toEqual({
      exitCode: 0,
      stdout: 'Added marketplace "fixture".\n',
      stderr: "",
    });

    const list = runStandalone(["marketplace", "list"]);
    expect(list).toEqual({
      exitCode: 0,
      stdout: `fixture\t${marketplace}\n`,
      stderr: "",
    });

    const rootHelp = runStandalone(["--help"]);
    expect(rootHelp).toEqual({
      exitCode: 0,
      stdout:
        "Usage: tx <command>\n\nCommands:\n  marketplace\n  nested\n  top\n",
      stderr: "",
    });

    const nestedHelp = runStandalone(["nested", "--help"]);
    expect(nestedHelp).toEqual({
      exitCode: 0,
      stdout: "Usage: tx nested <command>\n\nCommands:\n  run\n",
      stderr: "",
    });

    const top = runStandalone(["top", "one", "two"]);
    expect(top.exitCode).toBe(0);
    expect(JSON.parse(top.stdout)).toEqual({
      args: ["one", "two"],
      marketplace: "fixture",
      plugin: "top",
    });
    expect(top.stderr).toBe("");

    const nested = runStandalone(
      ["nested", "run", "remaining", "argv"],
      runtimeDirectory,
    );
    expect(nested.exitCode).toBe(0);
    expect(JSON.parse(nested.stdout)).toEqual({
      args: ["remaining", "argv"],
      marketplace: "fixture",
      plugin: "nested",
      cwd: runtimeDirectory,
      dependency: "loaded dependency",
      sameInstances: true,
      elementWorks: true,
    });
    expect(nested.stderr).toBe("");

    const remove = runStandalone(["marketplace", "remove", "fixture"]);
    expect(remove).toEqual({
      exitCode: 0,
      stdout: 'Removed marketplace "fixture".\n',
      stderr: "",
    });

    const unavailable = runStandalone(["nested", "run"]);
    expect(unavailable).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        'Error: Unknown command "nested run". Run "tx --help" for usage.\n',
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
