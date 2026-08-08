import { pathToFileURL } from "node:url";

/**
 * A plugin entry is loaded through Bun's bundler rather than handed straight
 * to `import()`, because the runtime module resolver of a compiled executable
 * cannot read an on-disk `package.json` at all.
 *
 * Inside a single-file executable, resolving a specifier against a directory
 * outside the embedded filesystem is reduced to pure path arithmetic: a
 * literal file path resolves, and so does a directory holding `index.js`, but
 * neither `exports` nor `main` is ever consulted. A dependency whose entry
 * point sits behind an `exports` map — which is most of npm — is reported as
 * missing; one whose `main` points anywhere other than `index.js` is reported
 * as missing too; and one that happens to carry both an `exports` map and an
 * `index.js` silently loads the wrong file. The same reduction applies to
 * every specifier in the graph, so an installed dependency cannot reach its
 * own dependencies either.
 *
 * The bundler does not share that resolver. `Bun.build` implements the whole
 * Node resolution algorithm — `exports` and `imports` maps, conditions,
 * subpath patterns, the legacy `main` and directory fallbacks, and the
 * `node_modules` walk — and implements it identically inside a compiled
 * executable and outside one. Bundling the entry therefore resolves the whole
 * plugin graph by Node's rules and hands the runtime one module with nothing
 * left to resolve.
 *
 * The bundle is returned from a loader keyed to the entry's own path rather
 * than written anywhere. Bun loads it *as* that path, so the module keeps its
 * real identity: `import.meta.url` and `import.meta.dir` still name the
 * plugin's own file and directory, a plugin reading a file beside itself
 * still finds it, and nothing is left behind in a referenced local
 * marketplace, whose checkout is the author's own working tree.
 *
 * Bundling applies whether or not tx is running compiled, so a plugin author
 * working against a source checkout exercises the module graph the released
 * executable builds rather than a more forgiving one.
 */

interface BundledModule {
  text(): Promise<string>;
}

/**
 * A bundle reports its outcome twice over: `Bun.build` throws by default, and
 * it reports the same failure as `success` with the detail in `logs` when a
 * caller opts out of the throw. Both are declared, because a build that
 * reports a failure this loader ignored would surface as a plugin exporting
 * nothing — which names the wrong problem entirely, and names it in exactly
 * the case this whole change exists to diagnose.
 */
interface BundleResult {
  readonly success: boolean;
  readonly logs: readonly unknown[];
  readonly outputs: readonly BundledModule[];
}

interface ModuleSource {
  readonly contents: string;
  readonly loader: "js";
}

interface ModuleLoaderRegistry {
  onLoad(
    constraint: { readonly filter: RegExp },
    load: () => Promise<ModuleSource>,
  ): void;
}

/**
 * The runtime this loader needs, declared here rather than taken from Bun's
 * own global type. The marketplace plugin type-checks in a consumer project
 * that installs `@fx/tx` and nothing else, where those types are absent; it
 * already reaches the same runtime through Node's own `process.execPath` to
 * install dependencies.
 */
export interface BundlingRuntime {
  build(options: {
    readonly entrypoints: readonly string[];
    readonly target: "bun";
    readonly format: "esm";
    readonly sourcemap: "inline";
    // Typed as the literal rather than a boolean, so enabling it is a type
    // error rather than a puzzle at runtime: split output references sibling
    // chunks by relative path, and this loader writes nothing to disk for
    // those references to find.
    readonly splitting: false;
  }): Promise<BundleResult>;
  plugin(definition: {
    readonly name: string;
    setup(registry: ModuleLoaderRegistry): void;
  }): void;
}

const runtime = (globalThis as unknown as { readonly Bun: BundlingRuntime })
  .Bun;

/** Entries already given a loader, so a repeated load registers nothing new. */
const loaded = new Set<string>();

const patternMetacharacters = /[\\^$.*+?()[\]{}|]/g;

/** A pattern matching exactly one path and nothing else. */
function exactPathPattern(path: string): RegExp {
  return new RegExp(`^${path.replace(patternMetacharacters, "\\$&")}$`);
}

/** Everything a failure has to say about itself, in one line. */
function describe(failures: readonly unknown[]): string {
  return failures.map(String).join("; ");
}

/**
 * A failure a plugin author can act on. Every path here names the specifier
 * that could not be resolved, because that is the whole point of resolving the
 * graph ahead of time: the alternative is an empty module reported as a plugin
 * that exports nothing, which describes neither the problem nor its location.
 */
function bundleFailure(detail: string): Error {
  return new Error(`Cannot resolve dependencies: ${detail}`);
}

/**
 * The plugin entry and its whole dependency graph as one module's source.
 *
 * The bundler is a parameter so that the outcomes `Bun.build` does not produce
 * under these options can still be exercised. It throws here rather than
 * returning an unsuccessful result, but that is a default it has changed
 * before — this repository's own `build.ts` still checks `success` — and a
 * silent empty bundle is a bad enough failure to be worth handling either way.
 */
export async function bundlePluginEntry(
  entryPath: string,
  bundler: BundlingRuntime = runtime,
): Promise<string> {
  let result: BundleResult;
  try {
    result = await bundler.build({
      entrypoints: [entryPath],
      target: "bun",
      format: "esm",
      // Inline, because the bundle is never written anywhere: a separate map
      // would have no place to sit, and without one every frame of a plugin's
      // own stack traces would point into generated output.
      sourcemap: "inline",
      splitting: false,
    });
  } catch (error) {
    // An `AggregateError` whose `errors` carry the individual resolution and
    // parse failures; its own message ("Bundle failed") names nothing. A throw
    // of any other shape is reported as itself.
    throw bundleFailure(
      describe((error as { errors?: readonly unknown[] }).errors ?? [error]),
    );
  }
  if (!result.success) throw bundleFailure(describe(result.logs));

  const [module] = result.outputs;
  if (module === undefined) {
    throw bundleFailure("the bundle reported success but produced no module");
  }
  return module.text();
}

/**
 * Imports a plugin entry with its dependencies resolved by Node's rules.
 *
 * The entry path must be real and fully resolved, as the manifest reader
 * produces it: the loader is keyed to the exact path the runtime reports for
 * the module, and a link resolved afterwards would not match it.
 */
export async function importPluginEntry(entryPath: string): Promise<unknown> {
  if (!loaded.has(entryPath)) {
    loaded.add(entryPath);
    runtime.plugin({
      name: `tx-plugin-entry:${entryPath}`,
      setup(registry) {
        registry.onLoad({ filter: exactPathPattern(entryPath) }, async () => ({
          contents: await bundlePluginEntry(entryPath),
          loader: "js",
        }));
      },
    });
  }
  return import(pathToFileURL(entryPath).href);
}
