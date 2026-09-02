import type { CoreDependencies } from "@fx/tx/plugin";
import {
  animationInterval,
  flashDuration,
  flashInterval,
  onPhase,
} from "./animation.ts";
import {
  caretGlyph,
  type EntryComponent,
  editedText,
  withCaret,
} from "./entry.ts";
import { visibleOptionIndices } from "./filter.ts";
import {
  displayWidth,
  type FrameComponent,
  innerWidth,
  panelWidth,
} from "./frame.ts";
import type {
  DialogElement,
  DialogView,
  Outcome,
  SelectOption,
  SelectResult,
  TextField,
} from "./types.ts";
import { optionRowCount, optionWindow } from "./viewport.ts";

/** The prompt the filter row carries, so the row the user types into is
 * distinguishable from the option rows under it. */
const filterPrompt = "›";

/** What the dialog shows when the filter text leaves nothing visible. */
const noMatch = "no match";

/** The overflow indicators, each carrying how many visible options the window
 * hides on its side. */
const hiddenAboveGlyph = "▲";
const hiddenBelowGlyph = "▼";

/** The select's key hint line, written out either way rather than assembled,
 * so each reads as the spec fixes it. The filter phrase is there exactly when
 * the filter is, so the line never names a key the dialog would ignore. */
function selectHint(filtering: boolean): string {
  return filtering
    ? "↑↓ move · Enter select · type to filter · Esc cancel"
    : "↑↓ move · Enter select · Esc cancel";
}

/** One rendered row of the panel, described before it is measured: the panel's
 * width follows the widest of them, and only then can the cursor bar be padded
 * to span the width that produced. */
type PanelRow = {
  readonly key: string;
  readonly text: string;
  /** A dimmed run drawn before the text. The filter needs one because its
   * prompt is chrome while the text after it is what the user typed, and the
   * two shadings have to meet inside one row for start truncation to trim the
   * row as a whole. */
  readonly prefix?: string;
  /** Chrome rather than content, so it is dimmed relative to the labels. */
  readonly dim?: boolean;
  /** The active option, drawn as a bar across the panel's inner width. */
  readonly inverse?: boolean;
  /** Text whose tail matters more than its head — entered text — so a row too
   * wide for the panel keeps its end and its caret rather than its start. */
  readonly tail?: boolean;
};

/** The parts of Ink's key report a movement reads. */
type NavigationKey = {
  readonly upArrow: boolean;
  readonly downArrow: boolean;
  readonly pageUp: boolean;
  readonly pageDown: boolean;
  readonly home: boolean;
  readonly end: boolean;
};

/**
 * Where a navigation key puts the active position within the visible list,
 * clamped to it so a key at a boundary settles on the boundary rather than
 * running past it. Page Up and Page Down move by the window's own height, which
 * is why they read the terminal alongside the list.
 *
 * `undefined` means the key does not navigate — which is what lets typed text
 * reach the filter — or that nothing is visible to move over.
 */
function movedPosition(
  key: NavigationKey,
  current: number,
  visibleCount: number,
  terminalRows: number,
): number | undefined {
  let target: number | undefined;
  if (key.home) target = 0;
  else if (key.end) target = visibleCount - 1;
  else if (key.upArrow) target = current - 1;
  else if (key.downArrow) target = current + 1;
  else if (key.pageUp || key.pageDown) {
    // Navigation is refused once collection begins, so the window this pages
    // by is always the choosing one.
    const page = optionRowCount(visibleCount, terminalRows, false);
    target = current + (key.pageUp ? -page : page);
  }
  if (target === undefined || visibleCount === 0) return undefined;
  return Math.min(visibleCount - 1, Math.max(0, target));
}

/** The option a user-provided choice committed to, held while its fields are
 * collected so a later navigation attempt cannot change what is submitted. */
type Collection<T> = {
  readonly value: T;
  readonly fields: readonly TextField[];
};

type SelectViewRequest<T> = {
  readonly message: string;
  readonly options: readonly SelectOption<T>[];
  readonly filtering: boolean;
};

/**
 * The select view: the filter, the option list, and the fields of a chosen
 * user-provided option, in one component with one input handler, so the whole
 * interaction is a single render session.
 *
 * The active position, the rendered window, and every key that moves either are
 * expressed over the visible options rather than over the supplied list, so
 * navigation and the viewport compose with the filter and the settled value is
 * still looked up by its original index.
 */
export function createSelectView<T>(
  react: CoreDependencies["react"],
  ink: CoreDependencies["ink"],
  { Entry, Frame }: { Entry: EntryComponent; Frame: FrameComponent },
  { message, options, filtering }: SelectViewRequest<T>,
  settle: (outcome: Outcome<SelectResult<T>>) => void,
): DialogView {
  const cancel = () => settle({ type: "cancelled" });
  // Neither the request nor the filter setting changes for the life of the
  // dialog, so its hint line is settled here rather than on every keystroke.
  const hint = selectHint(filtering);

  return function Select() {
    const { columns, rows } = ink.useWindowSize();
    const active = react.useRef(0);
    const [activeIndex, setActiveIndex] = react.useState(0);
    /** Where the window sat on the previous frame. It is derived rather than
     * driven: every input that could move it already re-renders, and the
     * terminal's own height changes without any input at all. */
    const windowStart = react.useRef(0);
    const entered = react.useRef("");
    const [filterText, setFilterText] = react.useState("");
    /** Set the moment a user-provided option is chosen; its presence is what
     * makes the option list and the filter stop accepting input. */
    const collecting = react.useRef<Collection<T> | undefined>(undefined);
    /** Prototype-free, because a field name is an opaque caller key:
     * `__proto__` would otherwise reach the inherited setter and the value
     * would vanish instead of being collected. */
    const collected = react.useRef<Record<string, string>>(
      Object.create(null) as Record<string, string>,
    );
    const field = react.useRef(0);
    const [fieldIndex, setFieldIndex] = react.useState(-1);
    /** The result a confirmed plain option is holding while the cursor bar
     * flashes it. The ref is what the input handler reads, because a chunk
     * carrying several keys is handled before any of them has re-rendered, and
     * its presence is what makes every one of those keys too late. */
    const confirmed = react.useRef<SelectResult<T> | undefined>(undefined);
    const [flashing, setFlashing] = react.useState(false);

    const collectingField = fieldIndex >= 0;
    // Kept across frames rather than recomputed on each: the animation
    // re-renders the view several times a second, and neither the matching nor
    // the width scan below it can change without the filter text changing.
    // Lowercasing every label on a timer is exactly the kind of cost the
    // animations are not allowed to add.
    const visible = react.useMemo(
      () => visibleOptionIndices(options, filterText),
      [filterText],
    );
    /** The widest visible label, in terminal columns.
     *
     * Kept as a running maximum rather than an array spread into `Math.max`:
     * measuring every visible option makes the argument count the length of the
     * list rather than the height of the window, and a spread that long throws
     * `RangeError` on a list a select can plausibly be given — a branch,
     * plugin, or version list. One pass over the same strings, no intermediate
     * array, and only when the filter has changed what is visible. */
    const widestLabel = react.useMemo(() => {
      let widest = 0;
      for (const index of visible) {
        const { label } = options[index] as SelectOption<T>;
        widest = Math.max(widest, displayWidth(label));
      }
      return widest;
    }, [visible]);
    // Derived while rendering, and remembered only so the next frame can move
    // it as little as possible; the window is never state of its own. Deriving
    // it against the state the frame is actually in is what lets the window
    // give back rows to the field's panel the moment collection begins.
    const viewport = optionWindow(
      visible.length,
      activeIndex,
      windowStart.current,
      rows,
      collectingField,
    );
    // The remembered start, not the rendered one: a terminal too short to draw
    // the window collapses it to nothing and renders from the top, and storing
    // that would lose the place the user scrolled to the moment the terminal
    // grew back.
    windowStart.current = viewport.rememberedStart;
    /** Visible options the window has no room for, whichever side of it they
     * fall on: an indicator is on screen exactly while this is positive, and it
     * is also the largest count either indicator can ever carry. */
    const hidden = visible.length - viewport.count;

    // The dialog's one animation subscription, driving the caret, the overflow
    // pulse, and the confirmation flash together. It is active exactly while
    // one of them is on screen, so a select with no caret, no hidden row, and
    // no flash running runs no timer and writes nothing while it idles. A
    // second subscription would keep its own start time, drift out of phase
    // with this one, and wake the renderer's shared timer twice an interval.
    const { time, reset } = ink.useAnimation({
      interval: flashing ? flashInterval : animationInterval,
      isActive: filtering || collectingField || flashing || hidden > 0,
    });
    /** The flash ends on elapsed time reaching its duration, never on a frame
     * number: a tick landing inside the renderer's render throttle is dropped
     * rather than delivered, so waiting for one particular frame would leave
     * the dialog running with every key ignored. */
    const flashOver = flashing && time >= flashDuration;
    react.useEffect(() => {
      const outcome = confirmed.current;
      if (!flashOver || outcome === undefined) return;
      settle({ type: "completed", value: outcome });
    }, [flashOver, settle]);

    ink.useInput((value, key) => {
      // The choice is made and the flash is running it out. Every key is too
      // late to change it, Escape and Ctrl-C included: cancelling a choice
      // already taken is exactly what the flash exists to rule out.
      if (confirmed.current) return;
      if (key.escape || (key.ctrl && value === "c")) {
        cancel();
        return;
      }
      // Ink delivers every key parsed out of one chunk in a single synchronous
      // pass, so this list keeps receiving input after the Enter that began
      // collection, before the field entry has mounted. Everything but
      // cancellation is declined from then on — filter edits included;
      // cancellation is answered above, at every stage.
      if (collecting.current) return;
      // Read from the ref rather than the rendered text: a chunk carrying
      // several keys is handled before any of them has re-rendered.
      const visible = visibleOptionIndices(options, entered.current);
      if (key.return) {
        const chosen = visible[active.current];
        // Nothing is visible, so there is nothing to confirm.
        if (chosen === undefined) return;
        const option = options[chosen] as SelectOption<T>;
        if (option.fields) {
          collecting.current = { value: option.value, fields: option.fields };
          setFieldIndex(0);
        } else {
          const outcome: SelectResult<T> = { value: option.value, values: {} };
          // A terminal too short for one option row leaves no cursor bar to
          // flash, and a flash nobody can see is only dead time with every key
          // ignored. The outcome is still fixed by the key that chose it, so
          // the settlement rule the flash exists to protect is unaffected.
          if (viewport.count === 0) {
            settle({ type: "completed", value: outcome });
            return;
          }
          // Recorded before the flash rather than after it, so the outcome is
          // fixed by the key that chose it and no later key can reach it. The
          // reset is explicit rather than left to the interval change, so the
          // flash starts from its first phase however the renderer decides to
          // treat a subscription whose interval moved.
          confirmed.current = outcome;
          reset();
          setFlashing(true);
        }
        return;
      }
      const moved = movedPosition(key, active.current, visible.length, rows);
      if (moved !== undefined) {
        active.current = moved;
        setActiveIndex(moved);
      } else if (filtering) {
        const edited = editedText(entered.current, value, key);
        if (edited === entered.current) return;
        entered.current = edited;
        setFilterText(edited);
        // The caret goes back to its visible phase on the frame the typed
        // character lands in, so no keystroke is ever answered by a row that
        // looks like it lost its caret.
        reset();
        // The point of typing is to narrow to the thing you want and press
        // Enter, so the first match becomes the target rather than whatever
        // row happened to be active before.
        active.current = 0;
        setActiveIndex(0);
      }
    });

    /** `index` is the field the submitting entry was rendered for. The entry
     * stays mounted for the rest of the synchronous pass that submitted it, so
     * a later Enter in the same chunk would otherwise answer the next field
     * before it is presented. */
    const submitField = (index: number, value: string) => {
      if (index !== field.current) return;
      const collection = collecting.current as Collection<T>;
      const current = collection.fields[field.current] as TextField;
      collected.current[current.name] = value;
      const next = field.current + 1;
      if (next < collection.fields.length) {
        field.current = next;
        setFieldIndex(next);
      } else {
        settle({
          type: "completed",
          value: {
            value: collection.value,
            values: { ...collected.current },
          },
        });
      }
    };

    /** The phase the caret and the overflow indicator show themselves on: the
     * caret visible, the indicator dimmed. A flash restarts elapsed time and
     * never runs a caret interval long, so both simply hold this phase for the
     * whole of it and the bar is the only thing moving while a choice is
     * confirmed. */
    const showPhase = onPhase(time, animationInterval);
    /** The filter stops accepting input the moment a field is collected, so its
     * row stops carrying a caret then. A caret blinking on a row whose
     * keystrokes are declined advertises an editable row that is not one — the
     * more so because typing into the field resets the shared phase, which
     * would blink the dead caret in lockstep with the live one. The cell stays
     * blank rather than disappearing, so the panel keeps its width. */
    const filterCaret = showPhase && !collectingField;
    /** The bar blinks off on the flash's off phases and is restored on the
     * frame the flash settles on, so the last thing left on screen is the
     * option that was taken rather than the gap where it was. */
    const barInverted = !flashing || flashOver || onPhase(time, flashInterval);

    const panelRows: PanelRow[] = [];
    if (filtering) {
      panelRows.push({
        key: "filter",
        prefix: `${filterPrompt} `,
        text: withCaret(filterText, filterCaret),
        tail: true,
      });
    }
    if (visible.length === 0) {
      panelRows.push({ key: "no-match", text: noMatch });
    } else {
      if (viewport.hiddenAbove > 0) {
        panelRows.push({
          key: "hidden-above",
          text: `${hiddenAboveGlyph} ${viewport.hiddenAbove} more`,
          // Pulsed between dimmed and normal on the caret's own phase, so an
          // indicator says "there is more" without a second timer and without
          // ever being on screen when nothing is hidden.
          dim: showPhase,
        });
      }
      const windowed = visible.slice(
        viewport.renderedStart,
        viewport.renderedStart + viewport.count,
      );
      for (const [offset, index] of windowed.entries()) {
        const option = options[index] as SelectOption<T>;
        const position = viewport.renderedStart + offset;
        panelRows.push({
          key: `option-${index}`,
          text: option.label,
          inverse: position === activeIndex && barInverted,
        });
      }
      if (viewport.hiddenBelow > 0) {
        panelRows.push({
          key: "hidden-below",
          text: `${hiddenBelowGlyph} ${viewport.hiddenBelow} more`,
          dim: showPhase,
        });
      }
    }

    // The panel is measured over every visible option and over an indicator
    // carrying the largest count it can ever carry — not over the rows this
    // frame happens to draw — so scrolling the window does not resize the panel
    // under the cursor bar. Whatever the window's position, one side or the
    // other hides exactly the options the window has no room for, so that total
    // is the widest either indicator ever gets.
    let content = widestLabel;
    const measure = (text: string) => {
      content = Math.max(content, displayWidth(text));
    };
    // Measured with the caret's own glyph whatever phase it is on, because the
    // blank standing in for it is exactly as wide: the panel is sized once for
    // both.
    if (filtering) measure(`${filterPrompt} ${filterText}${caretGlyph}`);
    if (visible.length === 0) measure(noMatch);
    if (hidden > 0) measure(`${hiddenAboveGlyph} ${hidden} more`);
    const width = panelWidth(message, content, columns);
    const inner = innerWidth(width);
    const children: DialogElement[] = panelRows.map((panelRow) =>
      react.createElement(
        ink.Text,
        {
          key: panelRow.key,
          dimColor: panelRow.dim ?? false,
          inverse: panelRow.inverse ?? false,
          wrap: panelRow.tail ? "truncate-start" : "truncate-end",
        },
        panelRow.prefix === undefined
          ? undefined
          : react.createElement(
              ink.Text,
              { key: "prefix", dimColor: true },
              panelRow.prefix,
            ),
        // The bar spans the panel rather than the label, so padding to the
        // inner width is what makes it a bar at all; truncation then trims a
        // label too long for the panel back to exactly that width.
        // Padded in columns, not code units, so the bar spans the panel for a
        // label the terminal draws wider than its `length`.
        panelRow.inverse
          ? panelRow.text.padEnd(
              panelRow.text.length + inner - displayWidth(panelRow.text),
            )
          : panelRow.text,
      ),
    );

    const panel = react.createElement(
      Frame,
      {
        key: "select",
        title: message,
        double: true,
        width,
        columns,
        // While a field is collected the entry's own panel follows this one
        // and carries the hints that apply; naming navigation and selection
        // here would name keys the dialog has stopped answering.
        hint: collectingField ? undefined : hint,
      },
      children,
    );
    // The column stays the root whether or not a field is on screen, so
    // beginning collection adds a panel under the existing one rather than
    // changing the element the whole view hangs from and remounting it.
    let fieldPanel: DialogElement | undefined;
    if (collectingField) {
      const collection = collecting.current as Collection<T>;
      const pending = collection.fields[fieldIndex] as TextField;
      fieldPanel = react.createElement(Entry, {
        key: `field-${fieldIndex}`,
        message: pending.message,
        initialValue: pending.initialValue,
        caret: showPhase,
        onEdit: reset,
        onSubmit: (value: string) => submitField(fieldIndex, value),
        onCancel: cancel,
      });
    }
    return react.createElement(
      ink.Box,
      { flexDirection: "column" },
      panel,
      fieldPanel,
    );
  };
}
