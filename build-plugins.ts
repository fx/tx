/**
 * Bundler plugins for the production build. They rewrite a dependency's
 * source while it is bundled into the executables, so the installed package
 * — and the published one, which carries no build — stays untouched.
 */

const stringWidthDeclaration =
  "export default function stringWidth(input, options = {}) {";
const stringWidthAnchors = [
  stringWidthDeclaration,
  "import stripAnsi from 'strip-ansi';",
  "const segmenter = new Intl.Segmenter();",
];

/**
 * Cache keys start with this, one per `ambiguousIsNarrow` value. It is also
 * how a test recognises the rewrite in a minified executable.
 */
export const clusterKeyPrefix = "tx-string-width-cluster";

/**
 * `string-width`'s source, measuring each distinct grapheme cluster once.
 *
 * The module sums a width per grapheme cluster, and each cluster's width
 * depends only on the cluster and `ambiguousIsNarrow`. Measuring one costs a
 * `v`-flag `\p{RGI_Emoji}` test that Bun runs about a thousand times slower
 * than other engines, and Ink measures every visible row on every frame — the
 * same few clusters (box drawing, letters) over and over. The rewrite keeps
 * the module's function as it is, renamed, and puts in front of it the same
 * preparation (ANSI stripping, the printable-ASCII fast path) followed by a
 * per-cluster sum that asks the module's own function about each cluster it
 * has not measured yet. The results are the module's own; only repeated work
 * is skipped. The cache is bounded and starts over when full.
 *
 * Throws when the source no longer has the shape this relies on, so a
 * dependency update cannot silently drop the rewrite.
 */
export function cachedStringWidthSource(source: string): string {
  if (!stringWidthAnchors.every((anchor) => source.includes(anchor))) {
    throw new Error(
      "string-width no longer has the shape the cached-width rewrite expects",
    );
  }
  return `${source.replace(
    stringWidthDeclaration,
    "function stringWidthOfCluster(input, options = {}) {",
  )}
const clusterWidths = new Map();

export default function stringWidth(input, options = {}) {
	if (typeof input !== 'string' || input.length === 0) {
		return 0;
	}

	const {
		ambiguousIsNarrow = true,
		countAnsiEscapeCodes = false,
	} = options;

	let string = input;
	if (!countAnsiEscapeCodes && (string.includes('\\u001B') || string.includes('\\u009B'))) {
		string = stripAnsi(string);
	}

	if (string.length === 0) {
		return 0;
	}

	if (/^[\\u0020-\\u007E]*$/.test(string)) {
		return string.length;
	}

	// The string is already stripped as asked, so each cluster is measured as it stands.
	const clusterOptions = {ambiguousIsNarrow, countAnsiEscapeCodes: true};
	const prefix = ambiguousIsNarrow ? '${clusterKeyPrefix}:narrow:' : '${clusterKeyPrefix}:wide:';
	let width = 0;
	for (const {segment} of segmenter.segment(string)) {
		const key = prefix + segment;
		let clusterWidth = clusterWidths.get(key);
		if (clusterWidth === undefined) {
			clusterWidth = stringWidthOfCluster(segment, clusterOptions);
			if (clusterWidths.size >= 4096) {
				clusterWidths.clear();
			}

			clusterWidths.set(key, clusterWidth);
		}

		width += clusterWidth;
	}

	return width;
}
`;
}

/** Bundle every `string-width` copy with {@link cachedStringWidthSource}. */
export const cachedStringWidth: Bun.BunPlugin = {
  name: "cached-string-width",
  setup(builder) {
    builder.onLoad(
      { filter: /[/\\]string-width[/\\]index\.js$/ },
      async ({ path }) => ({
        contents: cachedStringWidthSource(await Bun.file(path).text()),
        loader: "js",
      }),
    );
  },
};
