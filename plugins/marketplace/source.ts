/** The one colon that opens a local path rather than a remote's authority. */
export const windowsDrivePattern = /^[A-Za-z]:[\\/]/;

/** A Git source and the version its suffix named, where it carried one. */
export interface GitSourceVersion {
  readonly source: string;
  readonly ref?: string;
}

/**
 * Where a source's authority ends — the part Git reads to locate the host —
 * or undefined for a source that has none.
 *
 * A URL scheme and SCP-style `host:path` syntax both put a colon ahead of the
 * first slash, which is exactly when Git reads a source as a remote; a Windows
 * drive letter is the one such colon that still names a local path. That much
 * is the classification rule below. Where the authority *ends* is the question
 * only the version suffix has to answer: at the first `/` after `://` for a
 * scheme, and at the colon for SCP syntax, which is where the path starts in
 * each. A source carrying neither has no authority at all, so nothing in it is
 * a host and every `@` in it is the user's own.
 */
function gitSourceAuthorityEnd(source: string): number | undefined {
  const colon = source.indexOf(":");
  if (colon < 0 || windowsDrivePattern.test(source)) return undefined;
  if (source.slice(0, colon).includes("/")) return undefined;
  if (!source.startsWith("://", colon)) return colon;

  const start = colon + 3;
  const path = source.indexOf("/", start);
  return path < 0 ? source.length : path;
}

/**
 * Whether Git keeps this source rather than the filesystem, which is what
 * leaves `file://` a clone. One rule, shared with the suffix parser below, so
 * classification and versioning cannot disagree about what a source's host is.
 */
export function carriesGitSyntax(source: string): boolean {
  return gitSourceAuthorityEnd(source) !== undefined;
}

/**
 * A source as a diagnostic may quote it back: with whatever userinfo a scheme's
 * authority carries left out, because that userinfo is an HTTP(S) credential
 * and a diagnostic goes to a terminal and to whatever collects its output. An
 * SCP-style source keeps its `user@` — that is an SSH login rather than a
 * secret, and it is half of what makes such a source recognizable.
 */
function quotableSource(source: string): string {
  const scheme = source.indexOf("://");
  if (scheme < 0) return source;
  const start = scheme + 3;
  const authority = source.slice(start, gitSourceAuthorityEnd(source));
  const credential = authority.lastIndexOf("@");
  if (credential < 0) return source;
  return source.slice(0, start) + source.slice(start + credential + 1);
}

/**
 * A Git source split from the version suffix it carries, or the source
 * unchanged when it carries none.
 *
 * The separator is the last `@` outside the authority. Every `@` that is not a
 * version separator lives in there — an SSH login in `git@host:path`, an
 * HTTP(S) credential in `https://user@host/path` — so excluding it first is
 * the whole rule, and it is what lets a ref contain `/`: `fx/cc@release/1.4`
 * is a branch rather than a source nobody typed.
 *
 * A ref whose own name contains `@` cannot be carried here, because no
 * separator rule can tell which `@` the user meant; `marketplace pin` takes
 * such a ref as an argument of its own. The split is deliberately not applied
 * to a local source: classification runs first, and a directory named
 * `tools@2` is that directory.
 */
export function parseGitSourceVersion(source: string): GitSourceVersion {
  const boundary = gitSourceAuthorityEnd(source) ?? 0;
  const separator = source.lastIndexOf("@");
  // At or before the boundary the `@` is authority; at zero it would leave no
  // source at all, which is a source spelled oddly rather than a version.
  if (separator <= boundary) return { source };

  const ref = source.slice(separator + 1);
  if (!ref) {
    throw new Error(
      `Marketplace source "${quotableSource(source)}" names an empty version; write "<source>@<ref>"`,
    );
  }
  return { source: source.slice(0, separator), ref };
}
