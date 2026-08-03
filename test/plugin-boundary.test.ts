import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  isBinaryExpression,
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isStringLiteral,
  isVariableDeclaration,
  type Node,
  NodeFlags,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
} from "typescript/unstable/ast";
import { API, type Checker, type Program } from "typescript/unstable/async";

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

function isRuntimeModuleCall(node: CallExpression): boolean {
  return (
    node.expression.kind === SyntaxKind.ImportKeyword ||
    (isIdentifier(node.expression) && node.expression.text === "require")
  );
}

function runtimeModuleSpecifier(
  node: CallExpression,
): StringLiteral | undefined {
  if (!isRuntimeModuleCall(node)) return undefined;
  const argument = node.arguments[0];
  return argument && isStringLiteral(argument) ? argument : undefined;
}

async function immutableStringBindings(
  sourceFile: SourceFile,
  checker: Checker,
): Promise<ReadonlyMap<number, StringLiteral>> {
  const declarations: {
    readonly name: Node;
    readonly literal: StringLiteral;
  }[] = [];
  const reassignedNames: Node[] = [];

  function visit(node: Node): void {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.initializer &&
      isStringLiteral(node.initializer) &&
      (node.parent.flags & NodeFlags.Const) !== 0
    ) {
      declarations.push({ name: node.name, literal: node.initializer });
    } else if (
      isBinaryExpression(node) &&
      node.operatorToken.kind >= SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= SyntaxKind.LastAssignment &&
      isIdentifier(node.left)
    ) {
      reassignedNames.push(node.left);
    } else if (
      (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
      (node.operator === SyntaxKind.PlusPlusToken ||
        node.operator === SyntaxKind.MinusMinusToken) &&
      isIdentifier(node.operand)
    ) {
      reassignedNames.push(node.operand);
    }
    node.forEachChild(visit);
  }
  visit(sourceFile);

  const reassignedIds = new Set(
    (
      await Promise.all(
        reassignedNames.map((name) => checker.getSymbolAtLocation(name)),
      )
    )
      .filter((symbol) => symbol !== undefined)
      .map((symbol) => symbol.id),
  );
  const bindings = new Map<number, StringLiteral>();
  for (const declaration of declarations) {
    const symbol = await checker.getSymbolAtLocation(declaration.name);
    if (symbol && !reassignedIds.has(symbol.id)) {
      bindings.set(symbol.id, declaration.literal);
    }
  }
  return bindings;
}

async function resolvedStringBinding(
  identifier: Node,
  bindings: ReadonlyMap<number, StringLiteral>,
  checker: Checker,
): Promise<StringLiteral | undefined> {
  const symbol = await checker.getSymbolAtLocation(identifier);
  return symbol ? bindings.get(symbol.id) : undefined;
}

async function moduleSpecifiers(
  sourceFile: SourceFile,
  checker: Checker,
): Promise<readonly StringLiteral[]> {
  const specifiers: StringLiteral[] = [];
  const identifiers: Node[] = [];
  const bindings = await immutableStringBindings(sourceFile, checker);

  function visit(node: Node): void {
    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier);
    } else if (
      isImportEqualsDeclaration(node) &&
      isExternalModuleReference(node.moduleReference) &&
      isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression);
    } else if (isCallExpression(node)) {
      const specifier = runtimeModuleSpecifier(node);
      if (specifier) specifiers.push(specifier);
      else if (isRuntimeModuleCall(node)) {
        const argument = node.arguments[0];
        if (argument && isIdentifier(argument)) identifiers.push(argument);
      }
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
  for (const identifier of identifiers) {
    const binding = await resolvedStringBinding(identifier, bindings, checker);
    if (binding) specifiers.push(binding);
  }
  return specifiers;
}

async function txPluginViolations(
  sourceFile: SourceFile,
  checker: Checker,
): Promise<string[]> {
  const violations: string[] = [];
  const runtimeIdentifiers: Node[] = [];
  const bindings = await immutableStringBindings(sourceFile, checker);

  function visit(node: Node): void {
    if (
      isImportDeclaration(node) &&
      isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@fx/tx/plugin" &&
      node.importClause?.phaseModifier !== SyntaxKind.TypeKeyword
    ) {
      violations.push("@fx/tx/plugin imports must use import type");
    }
    if (
      isExportDeclaration(node) &&
      node.moduleSpecifier &&
      isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@fx/tx/plugin" &&
      !node.isTypeOnly
    ) {
      violations.push("@fx/tx/plugin re-exports must use export type");
    }
    if (
      isImportEqualsDeclaration(node) &&
      isExternalModuleReference(node.moduleReference) &&
      isStringLiteral(node.moduleReference.expression) &&
      node.moduleReference.expression.text === "@fx/tx/plugin" &&
      !node.isTypeOnly
    ) {
      violations.push("@fx/tx/plugin imports must use import type");
    }
    if (isCallExpression(node) && isRuntimeModuleCall(node)) {
      const specifier = runtimeModuleSpecifier(node);
      if (specifier?.text === "@fx/tx/plugin") {
        violations.push("@fx/tx/plugin cannot be loaded at runtime");
      } else if (!specifier) {
        const argument = node.arguments[0];
        if (argument && isIdentifier(argument)) {
          runtimeIdentifiers.push(argument);
        }
      }
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
  for (const identifier of runtimeIdentifiers) {
    const specifier = await resolvedStringBinding(
      identifier,
      bindings,
      checker,
    );
    if (specifier?.text === "@fx/tx/plugin") {
      violations.push("@fx/tx/plugin cannot be loaded at runtime");
    }
  }
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
    if (await Bun.file(path).exists()) return await realpath(path);
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
  checker: Checker,
  entries: readonly string[],
): Promise<string[]> {
  const violations: string[] = [];
  const visited = new Set<string>();

  async function visit(path: string, pluginRoot: string): Promise<void> {
    const canonicalPath = await realpath(path);
    if (visited.has(canonicalPath)) return;
    visited.add(canonicalPath);
    const sourceFile = await requiredSourceFile(program, canonicalPath);
    violations.push(
      ...(await txPluginViolations(sourceFile, checker)).map(
        (message) => `${relative(repositoryRoot, canonicalPath)}: ${message}`,
      ),
    );
    sourceFile.forEachChild(function checkRuntimeModuleCall(node): void {
      if (
        isCallExpression(node) &&
        isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        const argument = node.arguments[0];
        if (!argument || !isStringLiteral(argument)) {
          violations.push(
            `${relative(repositoryRoot, canonicalPath)}: require specifiers must be string literals`,
          );
        }
      }
      node.forEachChild(checkRuntimeModuleCall);
    });
    for (const literal of await moduleSpecifiers(sourceFile, checker)) {
      if (!literal.text.startsWith(".")) continue;
      const imported = await resolveRelativeModule(canonicalPath, literal.text);
      if (!imported) {
        violations.push(
          `${relative(repositoryRoot, canonicalPath)}: unresolved relative import ${literal.text}`,
        );
      } else if (!isWithin(pluginRoot, imported)) {
        violations.push(
          `${relative(repositoryRoot, canonicalPath)}: import escapes bundled plugin: ${literal.text}`,
        );
      } else {
        await visit(imported, pluginRoot);
      }
    }
  }

  for (const entry of entries) {
    await visit(entry, await realpath(dirname(entry)));
  }
  return violations;
}

async function corePluginImportViolations(
  program: Program,
  checker: Checker,
  roots: {
    readonly source: string;
    readonly plugins: string;
    readonly repository: string;
  } = { source: sourceRoot, plugins: pluginsRoot, repository: repositoryRoot },
): Promise<string[]> {
  const violations: string[] = [];
  const canonicalPluginsRoot = await realpath(roots.plugins);
  for (const discoveredPath of await sourceModules(roots.source)) {
    const path = await realpath(discoveredPath);
    const sourceFile = await requiredSourceFile(program, path);
    for (const literal of await moduleSpecifiers(sourceFile, checker)) {
      if (!literal.text.startsWith(".")) continue;
      const imported = await resolveRelativeModule(path, literal.text);
      if (imported && isWithin(canonicalPluginsRoot, imported)) {
        violations.push(
          `${relative(roots.repository, path)} imports bundled implementation ${relative(roots.repository, imported)}`,
        );
      }
    }
  }
  return violations;
}

async function bundledPluginEntries(root = pluginsRoot): Promise<string[]> {
  const entries: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const extension of moduleExtensions) {
      const candidate = join(root, entry.name, `index${extension}`);
      if (await Bun.file(candidate).exists()) {
        entries.push(candidate);
        break;
      }
    }
  }
  return entries.sort();
}

async function withProgram<T>(
  configPath: string,
  operation: (program: Program, checker: Checker) => Promise<T>,
): Promise<T> {
  const api = new API();
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [configPath] });
    try {
      const project = snapshot.getProject(configPath);
      if (!project) throw new Error(`TypeScript did not load ${configPath}`);
      return await operation(project.program, project.checker);
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await api.close();
  }
}

test("bundled plugin module graphs stay behind the public boundary", async () => {
  const entries = await bundledPluginEntries();
  expect(entries.length).toBeGreaterThan(0);
  await withProgram(
    join(repositoryRoot, "tsconfig.json"),
    async (program, checker) => {
      expect(await bundledPluginViolations(program, checker, entries)).toEqual(
        [],
      );
      expect(await corePluginImportViolations(program, checker)).toEqual([]);
    },
  );
});

test("bundled plugin entry discovery supports every TypeScript module extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "tx-plugin-entries-"));
  const fixtures = [
    ["a-ts", ".ts"],
    ["b-tsx", ".tsx"],
    ["c-mts", ".mts"],
    ["d-cts", ".cts"],
  ] as const;

  try {
    await Promise.all(
      [...fixtures.map(([name]) => name), "e-precedence"].map((name) =>
        mkdir(join(root, name), { recursive: true }),
      ),
    );
    await Promise.all([
      ...fixtures.map(([name, extension]) =>
        writeFile(join(root, name, `index${extension}`), "export {};"),
      ),
      writeFile(join(root, "e-precedence", "index.cts"), "export {};"),
      writeFile(join(root, "e-precedence", "index.tsx"), "export {};"),
    ]);

    expect(await bundledPluginEntries(root)).toEqual([
      ...fixtures.map(([name, extension]) =>
        join(root, name, `index${extension}`),
      ),
      join(root, "e-precedence", "index.tsx"),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AST checks reject forbidden @fx/tx/plugin syntax and graph escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tx-plugin-boundary-"));
  const fixtureSources = [
    ["allowed-import.ts", 'import type { Plugin } from "@fx/tx/plugin";', 0],
    ["allowed-export.ts", 'export type { Plugin } from "@fx/tx/plugin";', 0],
    [
      "allowed-import-type.ts",
      'type Plugin = import("@fx/tx/plugin").Plugin;',
      0,
    ],
    [
      "allowed-import-equals.ts",
      'import type api = require("@fx/tx/plugin");',
      0,
    ],
    ["mixed-import.ts", 'import { type Plugin } from "@fx/tx/plugin";', 1],
    ["side-effect.ts", 'import "@fx/tx/plugin";', 1],
    ["value-import.ts", 'import { Plugin } from "@fx/tx/plugin";', 1],
    ["value-export.ts", 'export { Plugin } from "@fx/tx/plugin";', 1],
    ["dynamic-import.ts", 'const plugin = import("@fx/tx/plugin");', 1],
    ["require.ts", 'const plugin = require("@fx/tx/plugin");', 1],
    ["import-equals.ts", 'import api = require("@fx/tx/plugin");', 1],
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
        [
          'import "../../src/core.ts";',
          'export * from "../two/index.ts";',
          'void import("../../src/dynamic.ts");',
          'require("../../src/required.ts");',
          'import core = require("../../src/core.ts");',
        ].join("\n"),
      ),
      writeFile(join(root, "plugins", "two", "index.ts"), "export {};"),
      writeFile(
        join(root, "src", "core.ts"),
        'import "../plugins/one/index.ts";',
      ),
      writeFile(join(root, "src", "dynamic.ts"), "export {};"),
      writeFile(join(root, "src", "required.ts"), "export {};"),
      writeFile(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { noEmit: true },
          include: ["**/*.ts"],
        }),
      ),
    ]);

    await withProgram(join(root, "tsconfig.json"), async (program, checker) => {
      for (const [name, , expectedCount] of fixtureSources) {
        expect(
          await txPluginViolations(
            await requiredSourceFile(program, await realpath(join(root, name))),
            checker,
          ),
        ).toHaveLength(expectedCount);
      }

      const graphViolations = await bundledPluginViolations(program, checker, [
        join(root, "plugins", "one", "index.ts"),
      ]);
      expect(graphViolations).toHaveLength(5);
      expect(graphViolations).toContainEqual(
        expect.stringContaining(
          "import escapes bundled plugin: ../../src/core.ts",
        ),
      );
      expect(graphViolations).toContainEqual(
        expect.stringContaining(
          "import escapes bundled plugin: ../../src/dynamic.ts",
        ),
      );
      expect(graphViolations).toContainEqual(
        expect.stringContaining(
          "import escapes bundled plugin: ../../src/required.ts",
        ),
      );
      expect(
        graphViolations.every((message) => message.includes("escapes")),
      ).toBe(true);
      expect(
        await corePluginImportViolations(program, checker, {
          source: join(root, "src"),
          plugins: join(root, "plugins"),
          repository: root,
        }),
      ).toEqual([
        "src/core.ts imports bundled implementation plugins/one/index.ts",
      ]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("string-bound module edges respect lexical symbols and immutability", async () => {
  const root = await mkdtemp(join(tmpdir(), "tx-plugin-bindings-"));

  try {
    const pluginRoot = join(root, "plugins", "one");
    await mkdir(pluginRoot, { recursive: true });
    await mkdir(join(root, "src"));
    await writeFile(
      join(pluginRoot, "index.ts"),
      [
        'const corePath = "../../src/core.ts";',
        "{",
        '  const corePath = "./local.ts";',
        "  void import(corePath);",
        "}",
        "void import(corePath);",
        'let mutablePath = "../../src/core.ts";',
        "void import(mutablePath);",
        'const reassignedPath = "../../src/core.ts";',
        'reassignedPath = "./local.ts";',
        "void import(reassignedPath);",
        'const pluginApi = "@fx/tx/plugin";',
        "function load(pluginApi: string) {",
        "  void import(pluginApi);",
        "}",
        "void load(pluginApi);",
        "void import(pluginApi);",
      ].join("\n"),
    );
    await writeFile(join(pluginRoot, "local.ts"), "export {};");
    await writeFile(join(root, "src", "core.ts"), "export {};");
    await writeFile(
      join(root, "src", "host.ts"),
      [
        'const pluginPath = "../plugins/one/index.ts";',
        "{",
        '  const pluginPath = "./local.ts";',
        "  void import(pluginPath);",
        "}",
        "void import(pluginPath);",
      ].join("\n"),
    );
    await writeFile(join(root, "src", "local.ts"), "export {};");
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { noEmit: true },
        include: ["**/*.ts"],
      }),
    );

    await withProgram(join(root, "tsconfig.json"), async (program, checker) => {
      const pluginViolations = await bundledPluginViolations(program, checker, [
        join(pluginRoot, "index.ts"),
      ]);
      expect(
        pluginViolations.filter((message) =>
          message.includes("import escapes bundled plugin"),
        ),
      ).toHaveLength(1);
      expect(
        pluginViolations.filter((message) =>
          message.includes("@fx/tx/plugin cannot be loaded at runtime"),
        ),
      ).toHaveLength(1);
      expect(
        await corePluginImportViolations(program, checker, {
          source: join(root, "src"),
          plugins: join(root, "plugins"),
          repository: root,
        }),
      ).toEqual([
        "src/host.ts imports bundled implementation plugins/one/index.ts",
      ]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled plugin graphs allow dynamic plugin imports but reject non-literal require", async () => {
  const root = await mkdtemp(join(tmpdir(), "tx-plugin-nonliteral-"));

  try {
    const pluginRoot = join(root, "plugins", "one");
    await mkdir(pluginRoot, { recursive: true });
    await mkdir(join(root, "src"));
    await writeFile(
      join(pluginRoot, "index.ts"),
      [
        "declare const entryPath: string;",
        "void import(entryPath);",
        'const corePath = "../../src/core.ts";',
        "void import(corePath);",
        "require(corePath);",
        'const pluginApi = "@fx/tx/plugin";',
        "void import(pluginApi);",
        "require(pluginApi);",
      ].join("\n"),
    );
    await writeFile(join(root, "src", "core.ts"), "export {};");
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { noEmit: true },
        include: ["**/*.ts"],
      }),
    );

    await withProgram(join(root, "tsconfig.json"), async (program, checker) => {
      const violations = await bundledPluginViolations(program, checker, [
        join(pluginRoot, "index.ts"),
      ]);
      expect(violations).toHaveLength(6);
      expect(
        violations.filter((message) =>
          message.includes("require specifiers must be string literals"),
        ),
      ).toHaveLength(2);
      expect(
        violations.filter((message) =>
          message.includes("@fx/tx/plugin cannot be loaded at runtime"),
        ),
      ).toHaveLength(2);
      expect(
        violations.filter((message) =>
          message.includes("import escapes bundled plugin"),
        ),
      ).toHaveLength(2);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled plugin graphs reject symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tx-plugin-symlink-"));

  try {
    const pluginRoot = join(root, "plugins", "one");
    const corePath = join(root, "src", "core.ts");
    await mkdir(pluginRoot, { recursive: true });
    await mkdir(join(root, "src"));
    await writeFile(join(pluginRoot, "index.ts"), 'import "./core-link.ts";');
    await writeFile(corePath, "export {};");
    await symlink(corePath, join(pluginRoot, "core-link.ts"));
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { noEmit: true },
        include: ["**/*.ts"],
      }),
    );

    await withProgram(join(root, "tsconfig.json"), async (program, checker) => {
      expect(
        await bundledPluginViolations(program, checker, [
          join(pluginRoot, "index.ts"),
        ]),
      ).toEqual([
        expect.stringContaining(
          "import escapes bundled plugin: ./core-link.ts",
        ),
      ]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled plugin graphs allow literal local and static type-only imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "tx-plugin-allowed-"));

  try {
    const pluginRoot = join(root, "plugins", "one");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(
      join(pluginRoot, "index.ts"),
      [
        'import type { Plugin } from "@fx/tx/plugin";',
        'type PluginModule = import("@fx/tx/plugin");',
        'import type api = require("@fx/tx/plugin");',
        'void import("./local.ts");',
        'require("./local.ts");',
      ].join("\n"),
    );
    await writeFile(join(pluginRoot, "local.ts"), "export {};");
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { noEmit: true },
        include: ["**/*.ts"],
      }),
    );

    await withProgram(join(root, "tsconfig.json"), async (program, checker) => {
      expect(
        await bundledPluginViolations(program, checker, [
          join(pluginRoot, "index.ts"),
        ]),
      ).toEqual([]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
