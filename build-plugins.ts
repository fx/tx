/**
 * Bundler plugins for the production build. They rewrite a dependency's
 * source while it is bundled into the executables, so the installed package
 * — and the published one, which carries no build — stays untouched.
 */

/** Where `string-width` reads its options, after which it may delegate. */
const stringWidthOptions = `	const {
		ambiguousIsNarrow = true,
		countAnsiEscapeCodes = false,
	} = options;
`;
const stringWidthDeclaration =
  "export default function stringWidth(input, options = {}) {";

/**
 * `string-width`'s source, measuring with Bun's native string width for the
 * default options. The module tests a `v`-flag `\p{RGI_Emoji}` expression per
 * grapheme, which Bun runs about a thousand times slower than
 * `Bun.stringWidth`, and Ink measures every visible row on every frame. Bun
 * agrees with the module except when ambiguous-width characters count as
 * wide, so that mode keeps the module's own code. Throws when the source no
 * longer has the shape this relies on, so a dependency update cannot silently
 * drop the rewrite.
 */
export function nativeStringWidthSource(source: string): string {
  if (
    !source.includes(stringWidthDeclaration) ||
    !source.includes(stringWidthOptions)
  ) {
    throw new Error(
      "string-width no longer has the shape the native-width rewrite expects",
    );
  }
  return source
    .replace(
      stringWidthDeclaration,
      `const nativeStringWidth = globalThis.Bun?.stringWidth;\n\n${stringWidthDeclaration}`,
    )
    .replace(
      stringWidthOptions,
      `${stringWidthOptions}
	if (nativeStringWidth && ambiguousIsNarrow) {
		return nativeStringWidth(input, {countAnsiEscapeCodes});
	}
`,
    );
}

/** Bundle `string-width` with {@link nativeStringWidthSource}. */
export const nativeStringWidth: Bun.BunPlugin = {
  name: "native-string-width",
  setup(builder) {
    builder.onLoad(
      { filter: /[/\\]string-width[/\\]index\.js$/ },
      async ({ path }) => ({
        contents: nativeStringWidthSource(await Bun.file(path).text()),
        loader: "js",
      }),
    );
  },
};
