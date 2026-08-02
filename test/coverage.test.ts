import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

const sourceRoot = new URL("../src/", import.meta.url);

async function findSourceModules(directory: URL): Promise<URL[]> {
  const modules: URL[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name, directory);

    if (entry.isDirectory()) {
      modules.push(
        ...(await findSourceModules(new URL(`${entry.name}/`, directory))),
      );
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      modules.push(url);
    }
  }

  return modules;
}

test("every production module is loaded for coverage", async () => {
  const modules = await findSourceModules(sourceRoot);

  expect(modules.length).toBeGreaterThan(0);
  await Promise.all(modules.map((module) => import(module.href)));
});
