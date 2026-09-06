import type { FilterMode } from "./contract.ts";

/** The setting this module reads is the caller's, so it arrives from the
 * published contract rather than being declared here: a caller sets it on a
 * request, and none of the matcher code below is a consumer's to compile. */

/** Whether a column's filter is on screen: once anything has been typed into
 * it, and from the start for a caller that asked for it. Hidden while it is
 * empty and unasked-for, because an empty filter is saying nothing and the
 * edge it sits in has a title and a count to carry instead. */
export function filterIsShown(mode: FilterMode, entered: string): boolean {
  return mode === "always" || entered !== "";
}

/** All the matcher reads: a value is opaque, so it is never matched against,
 * and a header names a field rather than belonging to any option, so it is not
 * here at all. An option declares one of the two display shapes; which one it
 * declared is what decides the runs a term may occur in. */
type MatchableOption = {
  readonly label?: string | undefined;
  readonly cells?: readonly string[] | undefined;
  readonly fields?: readonly unknown[];
};

/**
 * The indices of the options the filter text leaves visible, in supplied order:
 * visibility is a pure function of the list and the text, so nothing ranks,
 * reorders, or deduplicates, and a caller's ordering survives filtering.
 *
 * A term is a whitespace-separated piece of the text and must occur in the
 * option's display text under a case-insensitive comparison; every term must
 * match, in any order, so `rel 1.4` finds `release/1.4` without the user
 * recalling the separator. Blank text has no terms and leaves everything
 * visible.
 *
 * What the display text is follows the shape the option declared. A label is
 * one run. Cells are one run each, matched individually rather than joined:
 * matching the joined row is what makes `alphab` find a row of `alpha` and
 * `beta`, a match the reader can neither see nor predict, and joining with a
 * separator no term can contain would only make the rule an artifact of the
 * separator. Every option of one column declares the same shape, so no column
 * mixes the two readings.
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
    // The one conditional the two shapes need. A label option has no cells and
    // matches against its label alone; a cell option has no label and matches
    // within one cell at a time. The empty run stands for neither shape being
    // declared, which the request validation rejects before this is reached.
    const runs = (option.cells ?? [option.label ?? ""]).map((run) =>
      run.toLowerCase(),
    );
    if (terms.every((term) => runs.some((run) => run.includes(term)))) {
      visible.push(index);
    }
  }
  return visible;
}
