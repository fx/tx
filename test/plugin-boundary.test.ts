import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  type CallExpression,
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isStringLiteral,
  type Node,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
} from "typescript/unstable/ast";
import { API, type Program } from "typescript/unstable/async";

const repositoryRoot = resolve(import.meta.dir, "..");
const pluginsRoot = join(repositoryRoot, "plugins");
const sourceRoot = join(repositoryRoot, "src");
const moduleExtensions = [".ts", ".tsx", ".mts", ".cts"];

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) &&
      relation !== ".." &&
      !isAbsolute(relation))
  );
}

function moduleSpecifiers(sourceFile: SourceFile): readonly StringLiteral[] {
  const specifiers: StringLiteral[] = [];
  for (const statement of sourceFile.statements) {
    if (
      (isImportDeclaration(statement) || isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier);
    }
  }
  return specifiers;
}

function runtimeModuleSpecifier(node: CallExpression): string | undefined {
  const argument = node.arguments[0];
  if (!argument || !isStringLiteral(argument)) return undefined;
  const isDynamicImport = node.expression.kind === SyntaxKind.ImportKeyword;
  const isRequire =
    isIdentifier(node.expression) && node.expression.text === "require";
  return isDynamicImport || isRequire ? argument.text : undefined;
}

function txPluginViolations(sourceFile: SourceFile): string[] {
  const violations: string[] = [];

  function visit(node: Node): void {
    if (
      isImportDeclaration(node) &&
      isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "tx/plugin" &&
      node.importClause?.phaseModifier !== SyntaxKind.TypeKeyword
    ) {
      violations.push("tx/plugin imports must use import type");
    }
    if (
      isExportDeclaration(node) &&
      node.moduleSpecifier &&
      isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "tx/plugin" &&
      !node.isTypeOnly
    ) {
      violations.push("tx/plugin re-exports must use export type");
    }
    if (
      isCallExpression(node) &&
      runtimeModuleSpecifier(node) === "tx/plugin"
    ) {
      violations.push("tx/plugin cannot be loaded at runtime");
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
  return violations;
}

async function sourceModules(root: string): Promise<string[]> {
  const modules: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) modules.push(...(await sourceModules(path)));
    else if (
      entry.isFile() &&
      moduleExtensions.some((extension) => entry.name.endsWith(extension)) &&
      !/\.d\.(?:ts|mts|cts)$/.test(entry.name)
    ) {
      modules.push(path);
    }
  }
  return modules;
}

async function resolveRelativeModule(
  importer: string,
  specifier: string,
): Promise<string | undefined> {
  const candidate = resolve(dirname(importer), specifier);
  const candidates = extname(candidate)
    ? [candidate]
    : [
        ...moduleExtensions.map((extension) => `${candidate}${extension}`),
        ...moduleExtensions.map((extension) =>
          join(candidate, `index${extension}`),
        ),
      ];
  for (const path of candidates) {
    if (await Bun.file(path).exists()) return path;
  }
  return undefined;
}

async function requiredSourceFile(
  program: Program,
  path: string,
): Promise<SourceFile> {
  const sourceFile = await program.getSourceFile(path);
  if (!sourceFile) throw new Error(`TypeScript did not load ${path}`);
  return sourceFile;
}

async function bundledPluginViolations(
  program: Program,
  entries: readonly string[],
): Promise<string[]> {
  const violations: string[] = [];
  const visited = new Set<string>();

  async function visit(path: string, pluginRoot: string): Promise<void> {
    if (visited.has(path)) return;
    visited.add(path);
    const sourceFile = await requiredSourceFile(program, path);
    violations.push(
      ...txPluginViolations(sourceFile).map(
        (message) => `${relative(repositoryRoot, path)}: ${message}`,
      ),
    );
    for (const literal of moduleSpecifiers(sourceFile)) {
      if (!literal.text.startsWith(".")) continue;
      const imported = await resolveRelativeModule(path, literal.text);
      if (!imported) {
        violations.push(
          `${relative(repositoryRoot, path)}: unresolved relative import ${literal.text}`,
        );
      } else if (!isWithin(pluginRoot, imported)) {
        violations.push(
          `${relative(repositoryRoot, path)}: import escapes bundled plugin: ${literal.text}`,
        );
      } else {
        await visit(imported, pluginRoot);
      }
    }
  }

  for (const entry of entries) await visit(entry, dirname(entry));
  return violations;
}

async function corePluginImportViolations(
  program: Program,
  entries: ReadonlySet<string>,
): Promise<string[]> {
  const violations: string[] = [];
  for (const path of await sourceModules(sourceRoot)) {
    const sourceFile = await requiredSourceFile(program, path);
    for (const literal of moduleSpecifiers(sourceFile)) {
      if (!literal.text.startsWith(".")) continue;
      const imported = await resolveRelativeModule(path, literal.text);
      if (
        imported &&
        isWithin(pluginsRoot, imported) &&
        !entries.has(imported)
      ) {
        violations.push(
          `${relative(repositoryRoot, path)} imports bundled implementation ${relative(repositoryRoot, imported)}`,
        );
      }
    }
  }
  return violations;
}

async function bundledPluginEntries(): Promise<string[]> {
  const entries: string[] = [];
  for (const entry of await readdir(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(pluginsRoot, entry.name, "index.ts");
    if (await Bun.file(candidate).exists()) entries.push(candidate);
  }
  return entries.sort();
}

async function withProgram<T>(
  configPath: string,
  operation: (program: Program) => Promise<T>,
): Promise<T> {
  const api = new API();
  const snapshot = await api.updateSnapshot({ openProjects: [configPath] });
  try {
    const project = snapshot.getProject(configPath);
    if (!project) throw new Error(`TypeScript did not load ${configPath}`);
    return await operation(project.program);
  } finally {
    await snapshot.dispose();
    await api.close();
  }
}

test("bundled plugin module graphs stay behind the public boundary", async () => {
  const entries = await bundledPluginEntries();
  expect(entries.length).toBeGreaterThan(0);
  await withProgram(join(repositoryRoot, "tsconfig.json"), async (program) => {
    expect(await bundledPluginViolations(program, entries)).toEqual([]);
    expect(await corePluginImportViolations(program, new Set(entries))).toEqual(
      [],
    );
  });
});

test("AST checks reject forbidden tx/plugin syntax and graph escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tx-plugin-boundary-"));
  const fixtureSources = [
    ["allowed-import.ts", 'import type { Plugin } from "tx/plugin";', 0],
    ["allowed-export.ts", 'export type { Plugin } from "tx/plugin";', 0],
    ["allowed-import-type.ts", 'type Plugin = import("tx/plugin").Plugin;', 0],
    ["mixed-import.ts", 'import { type Plugin } from "tx/plugin";', 1],
    ["side-effect.ts", 'import "tx/plugin";', 1],
    ["value-import.ts", 'import { Plugin } from "tx/plugin";', 1],
    ["value-export.ts", 'export { Plugin } from "tx/plugin";', 1],
    ["dynamic-import.ts", 'const plugin = import("tx/plugin");', 1],
    ["require.ts", 'const plugin = require("tx/plugin");', 1],
  ] as const;

  try {
    await mkdir(join(root, "plugins", "one"), { recursive: true });
    await mkdir(join(root, "plugins", "two"), { recursive: true });
    await mkdir(join(root, "src"));
    await Promise.all([
      ...fixtureSources.map(([name, source]) =>
        writeFile(join(root, name), source),
      ),
      writeFile(
        join(root, "plugins", "one", "index.ts"),
        'import "../../src/core.ts"; export * from "../two/index.ts";',
      ),
      writeFile(join(root, "plugins", "two", "index.ts"), "export {};"),
      writeFile(join(root, "src", "core.ts"), "export {};"),
      writeFile(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { noEmit: true },
          include: ["**/*.ts"],
        }),
      ),
    ]);

    await withProgram(join(root, "tsconfig.json"), async (program) => {
      for (const [name, , expectedCount] of fixtureSources) {
        expect(
          txPluginViolations(
            await requiredSourceFile(program, join(root, name)),
          ),
        ).toHaveLength(expectedCount);
      }

      const graphViolations = await bundledPluginViolations(program, [
        join(root, "plugins", "one", "index.ts"),
      ]);
      expect(graphViolations).toHaveLength(2);
      expect(
        graphViolations.every((message) => message.includes("escapes")),
      ).toBe(true);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
