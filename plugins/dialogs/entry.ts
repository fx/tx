import type { CoreDependencies } from "@fx/tx/plugin";
import { displayWidth, type FrameComponent, panelWidth } from "./frame.ts";

/** The caret drawn after text under entry, so the row the user is typing into
 * says so. Shared with the select filter, which is the same editing step under
 * a different prompt. */
export const caretGlyph = "█";

/** What stands in the caret's cell while it is on its hidden phase. */
const hiddenCaret = " ";

/**
 * Text with the caret after it, drawn or blanked according to the phase it is
 * on. The cell is kept either way, which is what stops a blinking caret from
 * resizing the panel it sits in twice a second and shifting the text under the
 * reader; every row that draws a caret goes through here, so that rule holds in
 * one place rather than wherever text is entered.
 */
export function withCaret(text: string, shown: boolean): string {
  return `${text}${shown ? caretGlyph : hiddenCaret}`;
}

/** The key hint lines under a standalone input and under a field: the two keys
 * an entry answers to. Enter always submits; what the Escape an entry answers
 * does depends on what was open when it was mounted, which the entry itself
 * cannot see — so the caller says which line applies. The phrasing follows the
 * select's own hint, where Escape backing out reads `←/Esc back`; an entry has
 * no left arrow to offer, so it names Escape alone. */
const entryHints = {
  cancel: "Enter submit · Esc cancel",
  back: "Enter submit · Esc back",
} as const;

/**
 * What the Escape an entry answers actually does, and so what its hint line
 * names: `cancel` settles the dialog as cancelled, `back` returns to whatever
 * opened the entry without settling anything.
 */
export type EntryEscape = keyof typeof entryHints;

/** The hint line an entry draws for what its Escape does. Exported so a select
 * drawing an entry under its frame can measure the line before the entry has
 * rendered, and paint its own rows as wide as the entry will paint its. */
export function entryHint(action: EntryEscape): string {
  return entryHints[action];
}

/** The key report Ink hands an input handler, as every dialog reads it. */
export type InputKey = Parameters<
  Parameters<CoreDependencies["ink"]["useInput"]>[0]
>[1];

/** What the Enter key sends in raw mode, and so what marks it inside a chunk. */
const carriageReturn = "\r";

/**
 * The keystrokes one input event carries, in the order they were typed.
 *
 * Ink reads whatever the terminal has buffered as one chunk and cuts only
 * escape sequences, Backspace, and Ctrl-C out of it, so two keys typed faster
 * than the chunk is read — a Space and an Enter over a slow link, a character
 * and the Enter after it — arrive as one text event with no key flag set: as
 * ` \r`, which is neither the tick key nor Enter. A carriage return in text
 * can only be the Enter key, so the event is answered as the text before it,
 * then Enter, then whatever follows, each exactly as if it had arrived alone.
 * An event Ink has already resolved to a key, or one carrying no return, is
 * handed back whole; a space the return follows is the one-space keystroke a
 * multiple column ticks on, not the paste it would be among other text.
 */
export function keystrokes(
  entry: string,
  key: InputKey,
): readonly (readonly [string, InputKey])[] {
  if (!entry.includes(carriageReturn)) return [[entry, key]];
  const pressed: (readonly [string, InputKey])[] = [];
  for (const [at, text] of entry.split(carriageReturn).entries()) {
    if (at > 0) pressed.push(["", { ...key, return: true }]);
    if (text !== "") pressed.push([text, key]);
  }
  return pressed;
}

/** Everything a chunk carries that a terminal would display, in order. Control
 * characters drop out, so a pasted line survives while the newline ending it
 * does not. A complete control sequence never gets this far as text: Ink
 * reports the ones it resolves as an empty entry and discards the rest before
 * any handler runs, so text shaped like a sequence's payload was typed. */
function printableText(entry: string): string {
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
 * place is what makes the printable-text rule above hold once rather than once
 * per place text is typed. Backspace is answered before the modifier
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
  /** The terminal columns the entry may draw in: the terminal's own for a
   * standalone `input`, whatever its host gave it for an embedded `Input`, and
   * the select's width for an entry drawn under one. */
  readonly width: number;
  /** Whether the entry answers keys. An entry under a select inherits the
   * select's, so a host moving focus away from a select moves it away from the
   * field or leaf being typed under it too. */
  readonly isActive: boolean;
  readonly initialValue: string | undefined;
  /** Whether the caret is on its visible phase this frame. Passed in rather
   * than subscribed to here: a dialog animates on one subscription, and a field
   * collected under a select rides the select's. */
  readonly caret: boolean;
  /** Called once a keystroke has changed the text, so the dialog can put the
   * caret back on its visible phase. A caret that happened to be hidden under
   * the character just typed would read as a dropped keystroke. */
  readonly onEdit: () => void;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
  /** What `onCancel` does at this call site, which is all the hint line needs
   * to name it truthfully. Defaults to `cancel`, which is what a standalone
   * input's Escape does and the only thing it can do: there is nothing under
   * it to back out into. */
  readonly escapeAction?: EntryEscape;
  /** The narrowest width the entry paints every row to, so an entry drawn
   * under a select's frame paints at least as wide as the frame above it and
   * the two read as one block to a host drawing them over other content. The
   * entry's own panel and hint line still widen it past this. */
  readonly box?: number | undefined;
};

/**
 * The one text entry implementation, used both by a standalone `input` and by
 * each field of a chosen user-provided option, so entry, editing, submission,
 * and cancellation behave identically in either place. Remounting it under a
 * fresh key starts the next field from that field's own initial value.
 *
 * It is one-shot: once it has submitted or cancelled, it ignores every later
 * key for as long as it stays mounted. A chunk carrying several keys is
 * handled before any of them has re-rendered, and an embedded `Input` stays
 * mounted until its host removes it, so without this a key after the Enter
 * would edit, or submit again, a value that has already been handed over.
 */
export function createEntry(
  react: CoreDependencies["react"],
  ink: CoreDependencies["ink"],
  Frame: FrameComponent,
) {
  return function Entry({
    message,
    width: columns,
    isActive,
    initialValue,
    caret,
    onEdit,
    onSubmit,
    onCancel,
    escapeAction = "cancel",
    box,
  }: EntryProps) {
    const entered = react.useRef(initialValue ?? "");
    const [value, setValue] = react.useState(entered.current);
    const finished = react.useRef(false);
    const answer = (entry: string, key: InputKey): void => {
      if (finished.current) return;
      if (key.escape || (key.ctrl && entry === "c")) {
        finished.current = true;
        onCancel();
      } else if (key.return) {
        finished.current = true;
        onSubmit(entered.current);
      } else {
        const edited = editedText(entered.current, entry, key);
        if (edited !== entered.current) {
          entered.current = edited;
          setValue(edited);
          onEdit();
        }
      }
    };
    ink.useInput(
      (entry, key) => {
        // Answered one keystroke at a time: text typed ahead of an Enter is
        // appended before the Enter submits it, and whatever the chunk
        // carries past the Enter meets an entry that has finished.
        for (const [text, pressed] of keystrokes(entry, key)) {
          answer(text, pressed);
        }
      },
      { isActive },
    );

    // The caret rides with the value in one text, so start truncation keeps
    // the tail of a long value and the caret itself in view together.
    const entry = withCaret(value, caret);
    const width = panelWidth(message, displayWidth(entry), columns);
    return react.createElement(Frame, {
      title: message,
      double: false,
      width,
      columns,
      hint: entryHints[escapeAction],
      box,
      // Start truncation keeps the tail of a long value and the caret itself
      // in view together.
      rows: [
        {
          key: "value",
          segments: [{ key: "entry", text: entry, variable: "content" }],
          tail: true,
        },
      ],
    });
  };
}

export type EntryComponent = ReturnType<typeof createEntry>;
