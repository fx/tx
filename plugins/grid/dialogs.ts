/**
 * The one dialogs capability the grid drives its selectable rows through.
 *
 * The vocabulary it is typed by is imported from `@fx/tx/dialogs` — the same
 * string the read below passes — rather than restated here. A restated copy
 * described only the part the grid sends and compiled whatever the dialogs
 * plugin did, so a contract that moved would be discovered when a row was
 * driven rather than when this plugin was built. The import is a published
 * specifier rather than a relative path into `../dialogs/`, so nothing about
 * it puts two bundled plugins in one runtime module graph: it is erased
 * entirely.
 */

import type { Dialogs } from "@fx/tx/dialogs";

/**
 * The one dialogs capability, or a failure naming how many were found.
 *
 * There is deliberately no fallback, for the reason the theme lookup beside it
 * states and this one shares: a grid that fell back would have to own
 * movement, filtering, a viewport, and a terminal session, which is the
 * duplication composing over dialogs exists to remove. Falling back to
 * printing would be worse still — a consumer that asked a question would get
 * output and no answer.
 *
 * That is this consumer's own policy rather than one the contract imposes.
 * [Dialogs](../../docs/specs/dialogs/index.md) leaves what an absent or
 * repeated provider means to the consumer, and publishing the contract
 * publishes the vocabulary a request is written in, not an answer to that
 * question.
 */
export function requireDialogsCapability(
  registrations: <T>(key: string) => readonly T[],
): Dialogs {
  const dialogs = registrations<Dialogs>("@fx/tx/dialogs");
  if (dialogs.length !== 1) {
    throw new Error(
      `Expected exactly one dialogs capability, but found ${dialogs.length}`,
    );
  }
  return dialogs[0] as Dialogs;
}
