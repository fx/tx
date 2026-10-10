import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  cachedStringWidth,
  cachedStringWidthSource,
  rewriteStringWidthSource,
  verifiedStringWidthSources,
} from "../build-plugins.ts";

type StringWidth = (
  text: string,
  options?: { ambiguousIsNarrow?: boolean; countAnsiEscapeCodes?: boolean },
) => number;

/** Every `string-width` the dependency graph resolves, by its installed path. */
const copies = [
  ...new Bun.Glob("**/string-width/index.js").scanSync({
    cwd: new URL("../node_modules/", import.meta.url).pathname,
    absolute: true,
  }),
].sort();

/**
 * The rewrite without the verified-source check, so this test can show it
 * exact for a source before that source's hash is recorded.
 */
const unchecked: Bun.BunPlugin = {
  name: "rewrite-string-width-unchecked",
  setup(builder) {
    builder.onLoad(
      { filter: /[/\\]string-width[/\\]index\.js$/ },
      async ({ path }) => ({
        contents: rewriteStringWidthSource(await Bun.file(path).text()),
        loader: "js",
      }),
    );
  },
};

/**
 * One copy bundled through a rewrite plugin. The bundle is evaluated from its
 * text rather than written and imported, so it is not reported as a source
 * file of this repository's coverage.
 */
async function bundled(
  path: string,
  plugin: Bun.BunPlugin,
): Promise<StringWidth> {
  const build = await Bun.build({
    entrypoints: [path],
    target: "bun",
    format: "cjs",
    plugins: [plugin],
  });
  // Bun's CommonJS output is a comment line, then one function expression
  // taking (exports, require, module, __filename, __dirname).
  const source = (await build.outputs[0]?.text()) ?? "";
  const wrapper = new Function(
    `return ${source.slice(source.indexOf("\n") + 1)}`,
  )() as (exports: object, require: unknown, module: object) => void;
  const module = { exports: {} as { default?: StringWidth } };
  wrapper(module.exports, undefined, module);
  return module.exports.default as StringWidth;
}

/** Clusters and strings where width rules disagree between implementations. */
function corpus(): string[] {
  const texts: string[] = [];
  // Every 64th code point across Unicode, and every code point of the ranges
  // where width rules are subtle: combining marks, Hangul jamo, box drawing,
  // arrows and symbols, CJK punctuation and kana, emoji.
  const ranges: Array<[number, number]> = [
    [0x0300, 0x036f],
    [0x1100, 0x11ff],
    [0x2190, 0x27bf],
    [0x2500, 0x257f],
    [0x3000, 0x30ff],
    [0xa960, 0xa97f],
    [0xd7b0, 0xd7ff],
    [0xfe00, 0xfe0f],
    [0x1f1e6, 0x1f1ff],
    [0x1f300, 0x1f6ff],
    [0x1f900, 0x1faff],
  ];
  const codePoints = new Set<number>();
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 64) {
    codePoints.add(codePoint);
  }
  for (const [from, to] of ranges) {
    for (let codePoint = from; codePoint <= to; codePoint += 1) {
      codePoints.add(codePoint);
    }
  }
  for (const codePoint of codePoints) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    texts.push(String.fromCodePoint(codePoint));
  }
  const bases = [0x61, 0x31, 0x23, 0x2764, 0x263a, 0x1f600, 0x1f468, 0x1f1e9];
  const more = [0x1100, 0xac00, 0x915, 0x4e00, 0x3042, 0xe01, 0x2190, 0xa960];
  const marks = [0x300, 0x20e3, 0xfe0f, 0xfe0e, 0x200d, 0x1f3fb, 0x1161];
  const tail = [0x11a8, 0x93f, 0x94d, 0xe33, 0x3099];
  for (const base of [...bases, ...more]) {
    for (const mark of [...marks, ...tail]) {
      texts.push(String.fromCodePoint(base, mark));
      for (const second of [...marks, ...tail]) {
        texts.push(String.fromCodePoint(base, mark, second));
      }
    }
  }
  texts.push(
    "👨‍👩‍👧 family",
    "🇩🇪🇫🇷 flags",
    "1️⃣ #️⃣ keycaps",
    "🏳️‍🌈",
    "👍🏽",
    "각 jamo",
    "╭──── 21:06 ─╮ │ ▸ ∴ ⚒ ✓ ✗ •",
    "\u001b[31mred\u001b[39m and \u009b1mcsi",
    "\u001b[",
    "日本語 text 한국어",
    "à́b​­ c",
  );
  return texts;
}

describe.each(copies)("string-width at %s", (path) => {
  let original: StringWidth;
  let rewritten: StringWidth;

  beforeAll(async () => {
    original = (await import(path)).default as StringWidth;
    rewritten = await bundled(path, unchecked);
  });

  test("returns exactly the module's own widths, for every option", () => {
    const texts = corpus();
    for (const options of [
      {},
      { ambiguousIsNarrow: false },
      { countAnsiEscapeCodes: true },
      { ambiguousIsNarrow: false, countAnsiEscapeCodes: true },
    ]) {
      const mismatches = texts.filter(
        (text) => rewritten(text, options) !== original(text, options),
      );
      expect(mismatches).toEqual([]);
    }
    expect(rewritten("")).toBe(0);
    expect(rewritten("\u001b[31m\u001b[39m")).toBe(0);
    expect(rewritten(undefined as unknown as string)).toBe(0);
    // The module itself is slow on Bun; measuring the corpus with it takes a while.
  }, 60_000);
});

test("the production plugin measures a screen of box-drawing rows quickly", async () => {
  // Unrewritten, this takes seconds on Bun; cached, tens of milliseconds.
  const measure = await bundled(
    new URL("../node_modules/string-width/index.js", import.meta.url).pathname,
    cachedStringWidth,
  );
  const row = `│ ${"─".repeat(120)} ╭ • ▸ ∴ text with words │`;
  const started = performance.now();
  for (let index = 0; index < 2000; index += 1) measure(`${row}${index}`);
  expect(performance.now() - started).toBeLessThan(500);
});

test("every resolved string-width copy is covered", () => {
  // Ink and its helpers each resolve one; the build rewrites them all.
  expect(copies.length).toBeGreaterThan(0);
  expect(copies.map((path) => dirname(path))).toContain(
    new URL("../node_modules/string-width", import.meta.url).pathname,
  );
});

test("the rewrite refuses a string-width it was not verified against", () => {
  expect(() => cachedStringWidthSource("export default () => 0;")).toThrow(
    "is not one the cached-width rewrite was verified against",
  );
  // A verified source with one character changed is refused too.
  const verified = readFileSync(
    new URL("../node_modules/string-width/index.js", import.meta.url),
    "utf8",
  );
  expect(() => cachedStringWidthSource(`${verified} `)).toThrow(
    "verifiedStringWidthSources",
  );
});

test("every resolved string-width copy is one the rewrite was verified against", () => {
  for (const path of copies) {
    const hash = new Bun.CryptoHasher("sha256")
      .update(readFileSync(path, "utf8"))
      .digest("hex");
    expect(verifiedStringWidthSources.has(hash)).toBe(true);
  }
});
