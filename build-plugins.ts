/**
 * Bundler plugins for the production build. They rewrite a dependency's
 * source while it is bundled into the executables, so the installed package
 * — and the published one, which carries no build — stays untouched.
 */

const stringWidthDeclaration =
  "export default function stringWidth(input, options = {}) {";

/**
 * The `string-width` sources the rewrite has been verified against, by the
 * SHA-256 of `index.js`. The rewrite repeats the module's preparation (ANSI
 * stripping, the printable-ASCII fast path) and relies on its width being a
 * sum of independent per-cluster widths; a release can change either while
 * keeping every literal the rewrite edits. So any other source fails the
 * build until test/build-plugins.test.ts has shown the rewrite exact for it
 * and its hash is added here.
 */
export const verifiedStringWidthSources: ReadonlyMap<string, string> = new Map([
  ["60c197f20cc966a2ede2dfec1ad4b764aa4095a43d225792b2652bca6afeb21b", "8.2.2"],
  ["abc20775da6b552188b098688ebec671e29f5416d6339d3534bb7b016174003e", "8.3.0"],
]);

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
 * Applies to any source with the declaration it renames; the production build
 * uses {@link cachedStringWidthSource}, which accepts only verified sources.
 */
export function rewriteStringWidthSource(source: string): string {
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

/**
 * {@link rewriteStringWidthSource} for a source in
 * {@link verifiedStringWidthSources} only, so a dependency update cannot
 * silently change what the rewrite relies on.
 */
export function cachedStringWidthSource(source: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(source).digest("hex");
  if (!verifiedStringWidthSources.has(hash)) {
    throw new Error(
      `string-width source ${hash} is not one the cached-width rewrite was verified against; verify it with test/build-plugins.test.ts and add its hash to verifiedStringWidthSources`,
    );
  }
  return rewriteStringWidthSource(source);
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
