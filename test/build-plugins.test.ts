import { beforeAll, expect, test } from "bun:test";
import {
  nativeStringWidth,
  nativeStringWidthSource,
} from "../build-plugins.ts";

type StringWidth = (
  text: string,
  options?: { ambiguousIsNarrow?: boolean; countAnsiEscapeCodes?: boolean },
) => number;

let stringWidth: StringWidth;

// `string-width` exactly as the executables bundle it. The bundle is
// evaluated from its text rather than written and imported, so it is not
// reported as a source file of this repository's coverage.
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [
      new URL("./fixtures/string-width-entry.ts", import.meta.url).pathname,
    ],
    target: "bun",
    format: "cjs",
    plugins: [nativeStringWidth],
  });
  // Bun's CommonJS output is a comment line, then one function expression
  // taking (exports, require, module, __filename, __dirname).
  const source = (await build.outputs[0]?.text()) ?? "";
  const wrapper = new Function(
    `return ${source.slice(source.indexOf("\n") + 1)}`,
  )() as (exports: object, require: unknown, module: object) => void;
  const module = { exports: {} as { default?: StringWidth } };
  wrapper(module.exports, undefined, module);
  stringWidth = module.exports.default as StringWidth;
});

const samples = [
  "",
  "plain ascii",
  "é",
  "日本語",
  "한국어",
  "👍🏽",
  "👨‍👩‍👧",
  "🇩🇪",
  "1️⃣",
  "ℹ️",
  "a​b",
  "½ → ①",
  "╭──── 21:06 ─╮ │ ▸ ∴ ⚒ ✓ ✗ •",
  "\u001b[31mred\u001b[39m",
];

test("bundled string-width agrees with Bun's native width for the options Ink uses", () => {
  for (const text of samples) {
    expect(stringWidth(text)).toBe(Bun.stringWidth(text));
    expect(stringWidth(text, { countAnsiEscapeCodes: true })).toBe(
      Bun.stringWidth(text, { countAnsiEscapeCodes: true }),
    );
  }
});

test("bundled string-width keeps its own rules when ambiguous characters are wide", () => {
  // Bun counts this as narrow either way; the module's own code still runs.
  expect(stringWidth("é", { ambiguousIsNarrow: false })).toBe(2);
});

test("bundled string-width measures a screen of box-drawing rows quickly", () => {
  // Unrewritten, this takes seconds on Bun; natively, a few milliseconds.
  const row = `│ ${"─".repeat(120)} ╭ • ▸ ∴ text with words │`;
  const started = performance.now();
  for (let index = 0; index < 2000; index += 1) stringWidth(`${row}${index}`);
  expect(performance.now() - started).toBeLessThan(500);
});

test("the rewrite refuses a string-width it does not recognise", () => {
  expect(() => nativeStringWidthSource("export default () => 0;")).toThrow(
    "string-width no longer has the shape the native-width rewrite expects",
  );
  expect(() =>
    nativeStringWidthSource(
      "export default function stringWidth(input, options = {}) {}",
    ),
  ).toThrow("native-width rewrite");
});
