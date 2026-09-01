import type { CoreDependencies } from "@fx/tx/plugin";

/** A control sequence Ink did not resolve to a key, as it reaches a handler:
 * Ink strips the leading escape, leaving the introducer, any parameter and
 * intermediate bytes, and the final byte. Ink reports the sequences it knows
 * as an empty entry, so anything still shaped like one is an unrecognized key
 * rather than typed text. Shape is all there is to go on — see REVIEW.md — so
 * this covers the CSI form only, and a paste that is exactly a CSI body enters
 * nothing. */
const unresolvedControlSequence = /^\[\[?[\x20-\x3f]*[\x40-\x7e]$/;

/** Everything a chunk carries that a terminal would display, in order. Control
 * characters drop out, so a pasted line survives while the newline ending it
 * does not, and an unrecognized control sequence contributes nothing at all
 * rather than leaking its payload. */
function printableText(entry: string): string {
  if (unresolvedControlSequence.test(entry)) return "";
  let printable = "";
  for (const character of entry) {
    const code = character.codePointAt(0) as number;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!control) printable += character;
  }
  return printable;
}

/** The parts of Ink's key report an editing step reads. */
type EditingKey = {
  readonly backspace: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
};

/**
 * The one editing step behind every text a dialog collects: a standalone
 * `input`, a field under collection, and the select filter. Keeping it in one
 * place is what makes the control-sequence shape test above hold once rather
 * than once per place text is typed. Backspace is answered before the modifier
 * test, so a modifier never changes what Backspace itself means. Returns
 * `current` unchanged when the input edits nothing, which is also how a caller
 * tells an edit from an ignored key.
 */
export function editedText(
  current: string,
  entry: string,
  key: EditingKey,
): string {
  if (key.backspace) return Array.from(current).slice(0, -1).join("");
  if (key.ctrl || key.meta) return current;
  return current + printableText(entry);
}

type EntryProps = {
  readonly message: string;
  readonly initialValue: string | undefined;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
};

/**
 * The one text entry implementation, used both by a standalone `input` and by
 * each field of a chosen user-provided option, so entry, editing, submission,
 * and cancellation behave identically in either place. Remounting it under a
 * fresh key starts the next field from that field's own initial value.
 */
export function createEntry(
  react: CoreDependencies["react"],
  ink: CoreDependencies["ink"],
) {
  return function Entry({
    message,
    initialValue,
    onSubmit,
    onCancel,
  }: EntryProps) {
    const entered = react.useRef(initialValue ?? "");
    const [value, setValue] = react.useState(entered.current);
    ink.useInput((entry, key) => {
      if (key.escape || (key.ctrl && entry === "c")) {
        onCancel();
      } else if (key.return) {
        onSubmit(entered.current);
      } else {
        const edited = editedText(entered.current, entry, key);
        if (edited !== entered.current) {
          entered.current = edited;
          setValue(edited);
        }
      }
    });

    return react.createElement(
      ink.Box,
      { flexDirection: "column" },
      react.createElement(ink.Text, null, message),
      react.createElement(ink.Text, null, value),
    );
  };
}

export type EntryComponent = ReturnType<typeof createEntry>;
