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
import packageMetadata from "../package.json" with { type: "json" };

const repositoryRoot = resolve(import.meta.dir, "..");
const pluginsRoot = join(repositoryRoot, "plugins");
const sourceRoot = join(repositoryRoot, "src");
const moduleExtensions = [".ts", ".tsx", ".mts", ".cts"];

/**
 * Every specifier the package publishes, read from the `exports` map rather
 * than listed here.
 *
 * The rules below used to name `@fx/tx/plugin` literally, which was safe while
 * it was the only published specifier and became a hole the moment it was not:
 * a bare `@fx/tx/<capability>` import is neither relative nor that literal, so
 * it would have been invisible to every check in this file. Deriving the set
 * means a subpath added to `package.json` is held to the type-only, no-runtime
 * and no-`src/` rules without anyone remembering to widen a test.
 */
const publishedSpecifiers: readonly string[] = Object.keys(
  packageMetadata.exports,
).map((subpath) => `${packageMetadata.name}${subpath.slice(1)}`);
const publishedSpecifierSet = new Set(publishedSpecifiers);

/** Each published specifier against the file its `types` condition points at,
 * which is where resolving that specifier starts. */
const publishedTargets = new Map(
  Object.entries(packageMetadata.exports).map(([subpath, condition]) => [
    `${packageMetadata.name}${subpath.slice(1)}`,
    join(repositoryRoot, condition.types),
  ]),
);

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

/**
 * Every way this module breaks the rules a published specifier is held to: it
 * is imported for types alone and never loaded at run time.
 *
 * The rules are the same for every published specifier, so the check is one
 * pass over the set rather than one pass per subpath — which is what keeps a
 * capability contract from being held to less than the public plugin contract
 * simply because nobody copied a branch for it.
 */
async function publishedContractViolations(
  sourceFile: SourceFile,
  checker: Checker,
  published: ReadonlySet<string> = publishedSpecifierSet,
): Promise<string[]> {
  const violations: string[] = [];
  const runtimeIdentifiers: Node[] = [];
  const bindings = await immutableStringBindings(sourceFile, checker);

  function visit(node: Node): void {
    if (
      isImportDeclaration(node) &&
      isStringLiteral(node.moduleSpecifier) &&
      published.has(node.moduleSpecifier.text) &&
      node.importClause?.phaseModifier !== SyntaxKind.TypeKeyword
    ) {
      violations.push(
        `${node.moduleSpecifier.text} imports must use import type`,
      );
    }
    if (
      isExportDeclaration(node) &&
      node.moduleSpecifier &&
      isStringLiteral(node.moduleSpecifier) &&
      published.has(node.moduleSpecifier.text) &&
      !node.isTypeOnly
    ) {
      violations.push(
        `${node.moduleSpecifier.text} re-exports must use export type`,
      );
    }
    if (
      isImportEqualsDeclaration(node) &&
      isExternalModuleReference(node.moduleReference) &&
      isStringLiteral(node.moduleReference.expression) &&
      published.has(node.moduleReference.expression.text) &&
      !node.isTypeOnly
    ) {
      violations.push(
        `${node.moduleReference.expression.text} imports must use import type`,
      );
    }
    if (isCallExpression(node) && isRuntimeModuleCall(node)) {
      const specifier = runtimeModuleSpecifier(node);
      if (specifier && published.has(specifier.text)) {
        violations.push(`${specifier.text} cannot be loaded at runtime`);
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
    if (specifier && published.has(specifier.text)) {
      violations.push(`${specifier.text} cannot be loaded at runtime`);
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
      ...(await publishedContractViolations(sourceFile, checker)).map(
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

/**
 * Every way a module under `src/` reaches into what the plugins own: a
 * relative import of a bundled plugin's implementation, or an import of a
 * published contract.
 *
 * The second is the same boundary stated from the other side. A published
 * capability contract is published *beside* the public plugin contract rather
 * than inside it, so core carrying its vocabulary — a theme variable, say —
 * would put feature vocabulary in a package surface that is deliberately
 * feature-neutral. The specifier is bare rather than relative, which is
 * exactly why the relative check below cannot see it.
 */
async function corePluginImportViolations(
  program: Program,
  checker: Checker,
  roots: {
    readonly source: string;
    readonly plugins: string;
    readonly repository: string;
  } = { source: sourceRoot, plugins: pluginsRoot, repository: repositoryRoot },
  published: ReadonlySet<string> = publishedSpecifierSet,
): Promise<string[]> {
  const violations: string[] = [];
  const canonicalPluginsRoot = await realpath(roots.plugins);
  for (const discoveredPath of await sourceModules(roots.source)) {
    const path = await realpath(discoveredPath);
    const sourceFile = await requiredSourceFile(program, path);
    for (const literal of await moduleSpecifiers(sourceFile, checker)) {
      if (published.has(literal.text)) {
        violations.push(
          `${relative(roots.repository, path)} imports published contract ${literal.text}`,
        );
        continue;
      }
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

/**
 * Every module a consumer compiles when it imports a published specifier: the
 * file the `exports` map points at, and the transitive closure of what that
 * file imports, each named relative to the repository root.
 *
 * Both kinds of specifier a contract may carry are followed — a relative path
 * beside it, and another published specifier, which is the one way a contract
 * names another's vocabulary — so a contract that grew an import into an
 * implementation would widen this rather than escape it. An unresolvable
 * specifier fails rather than silently ending the walk short.
 */
async function publishedContractClosure(
  program: Program,
  checker: Checker,
  specifier: string,
): Promise<string[]> {
  const entry = publishedTargets.get(specifier);
  if (!entry) throw new Error(`${specifier} is not published`);
  const reached = new Set<string>();
  const pending = [await realpath(entry)];

  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (reached.has(path)) continue;
    reached.add(path);
    const sourceFile = await requiredSourceFile(program, path);
    for (const literal of await moduleSpecifiers(sourceFile, checker)) {
      const imported = literal.text.startsWith(".")
        ? await resolveRelativeModule(path, literal.text)
        : publishedTargets.get(literal.text);
      if (!imported) {
        throw new Error(
          `${relative(repositoryRoot, path)} imports unresolvable ${literal.text}`,
        );
      }
      pending.push(await realpath(imported));
    }
  }
  return [...reached].map((path) => relative(repositoryRoot, path)).sort();
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
  // The whole graph of every discovered entry is walked below, so naming the
  // bundled plugins that own no marketplace storage keep their own checks from
  // passing vacuously: none can reach the marketplace plugin's modules, or core's,
  // without failing here.
  const discovered = entries.map((entry) => relative(repositoryRoot, entry));
  expect(discovered).toContain(join("plugins", "update", "index.ts"));
  expect(discovered).toContain(join("plugins", "config", "index.ts"));
  expect(discovered).toContain(join("plugins", "dialogs", "index.ts"));
  expect(discovered).toContain(join("plugins", "grid", "index.ts"));
  expect(discovered).toContain(join("plugins", "theme", "index.ts"));
  expect(discovered).toContain(join("plugins", "executable", "index.ts"));
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

test("every published subpath is a types condition over a module with no runtime code", async () => {
  // Named exactly rather than counted, because every rule in this file is
  // driven off this set: an `exports` map that stopped yielding specifiers
  // would leave the whole boundary passing vacuously.
  expect(publishedSpecifiers).toEqual([
    "@fx/tx/plugin",
    "@fx/tx/config",
    "@fx/tx/grid",
    "@fx/tx/theme",
    "@fx/tx/theme-override",
  ]);

  const conditions = Object.values(packageMetadata.exports);
  // A runtime condition would be a second way to obtain a capability — one
  // that bypasses composition and hands a consumer a value the host never
  // committed — so `types` is the only condition any subpath carries.
  expect(conditions.map((condition) => Object.keys(condition))).toEqual(
    conditions.map(() => ["types"]),
  );

  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const targets = conditions.map((condition) => condition.types);
  const emitted = await Promise.all(
    targets.map(async (target) => {
      const source = await Bun.file(join(repositoryRoot, target)).text();
      return [target, transpiler.transformSync(source).trim()] as const;
    }),
  );
  // Nothing survives compilation, which is what makes "types alone" a property
  // of the published files rather than of the `exports` map alone: a contract
  // module that grew a constant, a helper, or a value import would be shipped
  // by a subpath that publishes no way to load it.
  expect(emitted).toEqual(targets.map((target) => [target, ""] as const));
});

test("importing the published config contract compiles no implementation", async () => {
  // Named rather than left to the equality below, and checked to exist so the
  // absence assertions cannot pass by naming files that are not there. The
  // config shape used to be exported only from
  // `plugins/marketplace/configured.ts`, so naming a config value pulled in
  // the marketplace manager and, behind it, `node:child_process`, `node:fs`,
  // the source resolver, and the install storage — none of which a consumer
  // that only wants to say what a persisted value looks like needs.
  const implementation = ["manager.ts", "source.ts", "storage.ts"].map(
    (module) => join("plugins", "marketplace", module),
  );

  await withProgram(
    join(repositoryRoot, "tsconfig.json"),
    async (program, checker) => {
      const reached = await publishedContractClosure(
        program,
        checker,
        "@fx/tx/config",
      );
      expect(reached).toEqual([join("plugins", "config", "contract.ts")]);
      for (const module of implementation) {
        expect(await Bun.file(join(repositoryRoot, module)).exists()).toBe(
          true,
        );
        expect(reached).not.toContain(module);
      }
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

test("AST checks reject forbidden published-contract syntax and graph escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tx-plugin-boundary-"));
  // Every published specifier gets the whole case list rather than the public
  // plugin contract getting it and the capability subpaths being taken on
  // trust. A subpath added to the `exports` map that the rules did not cover
  // would otherwise pass this test by never appearing in it.
  const syntaxCases = [
    [
      "allowed-import",
      (from: string) => `import type { C } from "${from}";`,
      0,
    ],
    [
      "allowed-export",
      (from: string) => `export type { C } from "${from}";`,
      0,
    ],
    [
      "allowed-import-type",
      (from: string) => `type C = import("${from}").C;`,
      0,
    ],
    [
      "allowed-import-equals",
      (from: string) => `import type api = require("${from}");`,
      0,
    ],
    ["mixed-import", (from: string) => `import { type C } from "${from}";`, 1],
    ["side-effect", (from: string) => `import "${from}";`, 1],
    ["value-import", (from: string) => `import { C } from "${from}";`, 1],
    ["value-export", (from: string) => `export { C } from "${from}";`, 1],
    ["dynamic-import", (from: string) => `const c = import("${from}");`, 1],
    ["require", (from: string) => `const c = require("${from}");`, 1],
    ["import-equals", (from: string) => `import api = require("${from}");`, 1],
  ] as const;
  const fixtureSources = publishedSpecifiers.flatMap((specifier, index) =>
    syntaxCases.map(
      ([name, source, expectedCount]) =>
        [`${index}-${name}.ts`, source(specifier), expectedCount] as const,
    ),
  );
  expect(fixtureSources).toHaveLength(
    publishedSpecifiers.length * syntaxCases.length,
  );

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
      // One core module per published specifier: a published contract is
      // published beside the public plugin contract rather than inside it, so
      // core importing one — even type-only, which is why the source below is
      // the most innocuous form there is — puts feature vocabulary in a
      // package surface that is deliberately feature-neutral.
      ...publishedSpecifiers.map((specifier, index) =>
        writeFile(
          join(root, "src", `published-${index}.ts`),
          `import type { C } from "${specifier}";\nexport type Local = C;`,
        ),
      ),
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
        const violations = await publishedContractViolations(
          await requiredSourceFile(program, await realpath(join(root, name))),
          checker,
        );
        // The fixture's name rides along in the assertion so a failure names
        // the case and the specifier that broke rather than only a count.
        expect([name, violations.length]).toEqual([name, expectedCount]);
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
      // Sorted rather than compared in discovery order: the core modules are
      // read from the directory, whose order is the file system's business.
      expect(
        (
          await corePluginImportViolations(program, checker, {
            source: join(root, "src"),
            plugins: join(root, "plugins"),
            repository: root,
          })
        ).sort(),
      ).toEqual(
        [
          "src/core.ts imports bundled implementation plugins/one/index.ts",
          ...publishedSpecifiers.map(
            (specifier, index) =>
              `src/published-${index}.ts imports published contract ${specifier}`,
          ),
        ].sort(),
      );
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
