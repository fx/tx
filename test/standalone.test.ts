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
import { createGitRepository, initializeGitRepository } from "./helpers.ts";

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
      copyFile(join(repositoryRoot, "cli.ts"), join(stagedProject, "cli.ts")),
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

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("Usage: tx [options] [command]");
    expect(result.stderr.toString()).toContain("marketplace");

    const marketplace = join(temporaryRoot, "marketplace");
    const dependency = join(marketplace, "plugins", "dependency");
    const dataDirectory = join(temporaryRoot, "data");
    await Promise.all([
      mkdir(dependency, { recursive: true }),
      mkdir(join(marketplace, ".tx"), { recursive: true }),
      mkdir(join(marketplace, "plugins"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(marketplace, ".tx/config.json"),
        JSON.stringify({
          plugins: [
            { name: "top", entry: "top.ts" },
            {
              name: "nested",
              entry: "plugins/nested.ts",
              package: "plugins/package.json",
            },
          ],
        }),
      ),
      writeFile(
        join(marketplace, "plugins", "package.json"),
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
        `export default ({ command, context, dependencies }) => {
          globalThis[Symbol.for("tx.standalone.injected")] = {
            react: dependencies.react,
            ink: dependencies.ink,
          };
          command((namespace) => {
            namespace
              .description("Top fixture plugin")
              .argument("[args...]")
              .action((args) => context.stdout.write(JSON.stringify({
                args,
                plugin: context.plugin,
              }) + "\\n"));
          });
        };`,
      ),
      writeFile(
        join(marketplace, "plugins", "nested.ts"),
        `import { PassThrough } from "node:stream";
        import { message } from "fixture-dependency";
        export default ({ command, context, dependencies }) => {
          const injected = globalThis[Symbol.for("tx.standalone.injected")];
          const sameInstances = injected?.react === dependencies.react &&
            injected?.ink === dependencies.ink;
          command((namespace) => {
            namespace.description("Nested fixture plugin");
            namespace
              .command("run")
              .description("Render through the injected dependencies")
              .argument("[args...]")
              .action(async (args) => {
                const element = dependencies.react.createElement(
                  dependencies.ink.Text,
                  null,
                  message,
                );
                const output = new PassThrough();
                let renderedOutput = "";
                output.on("data", (chunk) => {
                  renderedOutput += chunk.toString();
                });
                const instance = dependencies.ink.render(element, {
                  stdout: output,
                  interactive: false,
                  patchConsole: false,
                });
                instance.unmount();
                const exitResult = await instance.waitUntilExit();
                output.destroy();
                context.stdout.write(JSON.stringify({
                  args,
                  plugin: context.plugin,
                  cwd: context.cwd,
                  dependency: message,
                  sameInstances,
                  elementWorks: element.type === dependencies.ink.Text &&
                    element.props.children === message,
                  renderedOutput,
                  instanceExited: exitResult === undefined,
                }) + "\\n");
              });
          });
        };`,
      ),
    ]);

    initializeGitRepository(marketplace);

    const { PATH } = process.env;
    const env = {
      ...process.env,
      DEV: "true",
      PATH: (PATH ?? "")
        .split(":")
        .filter((entry) => entry !== dirname(process.execPath))
        .join(":"),
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
    expect(rootHelp.exitCode).toBe(0);
    expect(rootHelp.stdout).toContain("Usage: tx [options] [command]");
    for (const [term, description] of [
      ["marketplace", "Manage installed plugin marketplaces"],
      ["top \\[args\\.\\.\\.\\]", "Top fixture plugin"],
      ["nested", "Nested fixture plugin"],
    ]) {
      expect(rootHelp.stdout).toMatch(
        new RegExp(`^ +${term} +${description}$`, "m"),
      );
    }
    expect(rootHelp.stderr).toBe("");

    const nestedHelp = runStandalone(["nested", "--help"]);
    expect(nestedHelp.exitCode).toBe(0);
    expect(nestedHelp.stdout).toContain("Usage: tx nested [options] [command]");
    expect(nestedHelp.stdout).toContain(
      "Render through the injected dependencies",
    );
    expect(nestedHelp.stderr).toBe("");

    const top = runStandalone(["top", "one", "two"]);
    expect(top.exitCode).toBe(0);
    expect(JSON.parse(top.stdout)).toEqual({
      args: ["one", "two"],
      plugin: {
        name: "top",
        parent: {
          name: "fixture",
          parent: { name: "installed", parent: { name: "marketplace" } },
        },
      },
    });
    expect(top.stderr).toBe("");

    const nested = runStandalone(
      ["nested", "run", "remaining", "argv"],
      runtimeDirectory,
    );
    expect(nested.exitCode).toBe(0);
    expect(JSON.parse(nested.stdout)).toEqual({
      args: ["remaining", "argv"],
      plugin: {
        name: "nested",
        parent: {
          name: "fixture",
          parent: { name: "installed", parent: { name: "marketplace" } },
        },
      },
      cwd: runtimeDirectory,
      dependency: "loaded dependency",
      sameInstances: true,
      elementWorks: true,
      renderedOutput: "loaded dependency\n",
      instanceExited: true,
    });
    expect(nested.stderr).toBe("");

    const brokenMarketplace = await createGitRepository(
      temporaryRoot,
      "broken-marketplace",
      {
        ".tx/config.json": JSON.stringify({
          plugins: [{ name: "broken", entry: "broken.ts" }],
        }),
        "broken.ts": "export default 42;\n",
      },
    );

    expect(
      runStandalone([
        "marketplace",
        "add",
        brokenMarketplace,
        "--name",
        "broken",
      ]),
    ).toEqual({
      exitCode: 0,
      stdout: 'Added marketplace "broken".\n',
      stderr: "",
    });

    const withBroken = runStandalone(["top", "one", "two"]);
    expect(withBroken.exitCode).toBe(0);
    expect(withBroken.stdout).toBe(top.stdout);
    expect(withBroken.stderr).toContain(
      "Error loading plugin marketplace/installed/broken/broken",
    );

    const removeBroken = runStandalone(["marketplace", "remove", "broken"]);
    expect(removeBroken).toEqual({
      exitCode: 0,
      stdout: 'Removed marketplace "broken".\n',
      stderr: expect.stringContaining(
        "Error loading plugin marketplace/installed/broken/broken",
      ),
    });

    const remove = runStandalone(["marketplace", "remove", "fixture"]);
    expect(remove).toEqual({
      exitCode: 0,
      stdout: 'Removed marketplace "fixture".\n',
      stderr: "",
    });

    const unavailable = runStandalone(["nested", "run"]);
    expect(unavailable).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: 'Error: Unknown command "nested". Run "tx --help" for usage.\n',
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
