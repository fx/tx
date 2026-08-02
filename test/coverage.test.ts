import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

const productionRoots = [
  new URL("../src/", import.meta.url),
  new URL("../plugins/", import.meta.url),
];
const sourceModuleExtensions = [".ts", ".tsx", ".mts", ".cts"];
const declarationModulePattern = /\.d\.(?:ts|mts|cts)$/;

async function findSourceModules(directory: URL): Promise<URL[]> {
  const modules: URL[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name, directory);

    if (entry.isDirectory()) {
      modules.push(
        ...(await findSourceModules(new URL(`${entry.name}/`, directory))),
      );
    } else if (
      entry.isFile() &&
      !declarationModulePattern.test(entry.name) &&
      sourceModuleExtensions.some((extension) => entry.name.endsWith(extension))
    ) {
      modules.push(url);
    }
  }

  return modules;
}

test("every production module is loaded for coverage", async () => {
  const modules = (
    await Promise.all(productionRoots.map(findSourceModules))
  ).flat();

  expect(modules.length).toBeGreaterThan(0);
  await Promise.all(modules.map((module) => import(module.href)));
});
