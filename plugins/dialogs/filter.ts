/** The option count above which `"auto"` turns the filter on. A count, rather
 * than something derived from the terminal, so a caller can predict what the
 * user sees; eight fits under the option rows a select shows at once, so a list
 * that gets a filter is also one long enough to need it. */
export const automaticFilterThreshold = 8;

/** `true` and `false` decide whatever the option count, and an omitted setting
 * means `"auto"`, so a caller that never thinks about the filter still gets one
 * exactly when the list is long. */
export function filterIsEnabled(
  setting: boolean | "auto" | undefined,
  optionCount: number,
): boolean {
  if (typeof setting === "boolean") return setting;
  return optionCount > automaticFilterThreshold;
}

/** All the matcher reads: a value is opaque, so it is never matched against. */
type MatchableOption = {
  readonly label: string;
  readonly fields?: readonly unknown[];
};

/**
 * The indices of the options the filter text leaves visible, in supplied order:
 * visibility is a pure function of the list and the text, so nothing ranks,
 * reorders, or deduplicates, and a caller's ordering survives filtering.
 *
 * A term is a whitespace-separated piece of the text and must occur in the
 * label under a case-insensitive comparison; every term must match, in any
 * order, so `rel 1.4` finds `release/1.4` without the user recalling the
 * separator. Blank text has no terms and leaves everything visible.
 *
 * An option declaring fields is the caller's "none of these" answer, so it is
 * always visible: typing something nothing matches is exactly when the user
 * needs it.
 */
export function visibleOptionIndices(
  options: readonly MatchableOption[],
  text: string,
): readonly number[] {
  const terms = text
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  const visible: number[] = [];
  for (const [index, option] of options.entries()) {
    if (option.fields) {
      visible.push(index);
      continue;
    }
    const label = option.label.toLowerCase();
    if (terms.every((term) => label.includes(term))) visible.push(index);
  }
  return visible;
}
