/**
 * When a column shows its filter.
 *
 * Filtering itself is never off: a printable character always narrows the
 * list, at every level and whatever the list's length, because typing is what
 * a reader reaches for the moment a list is longer than their patience and
 * there is no second thing that typing could sensibly mean. What the setting
 * decides is only whether the filter is on screen before they have typed
 * anything.
 */
export type FilterMode = "typed" | "always";

/** Whether a column's filter is on screen: once anything has been typed into
 * it, and from the start for a caller that asked for it. Hidden while it is
 * empty and unasked-for, because an empty filter is saying nothing and the
 * edge it sits in has a title and a count to carry instead. */
export function filterIsShown(mode: FilterMode, entered: string): boolean {
  return mode === "always" || entered !== "";
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
