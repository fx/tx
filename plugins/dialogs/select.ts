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
import { filterIsEnabled, visibleOptionIndices } from "./filter.ts";
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
  SelectRequest,
  SelectResult,
  TextField,
} from "./types.ts";
import {
  optionRowCount,
  type OptionWindow,
  optionWindow,
  stackedExtraRows,
  stackedOffsetColumns,
  stackedShadowRows,
} from "./viewport.ts";

/** The prompt the filter row carries, so the row the user types into is
 * distinguishable from the option rows under it. */
const filterPrompt = "›";

/** What the dialog shows when the filter text leaves nothing visible. */
const noMatch = "no match";

/** The overflow indicators, each carrying how many visible options the window
 * hides on its side. */
const hiddenAboveGlyph = "▲";
const hiddenBelowGlyph = "▼";

/** The select's key hint line, written out rather than assembled, so each
 * reads as the spec fixes it. The filter phrase is there exactly when the
 * filter is, so the line never names a key the dialog would ignore, and the
 * expand phrase is there exactly when a visible option declares a sub-dialog.
 */
function selectHint(filtering: boolean, expandable: boolean): string {
  const base = filtering
    ? "↑↓ move · Enter select · type to filter · Esc cancel"
    : "↑↓ move · Enter select · Esc cancel";
  return expandable ? `${base} · Ctrl+Enter expand` : base;
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

/** One select level on the stack: the request slice it renders plus the
 * runtime state the flat dialog already holds — filter text and active
 * position — kept per level so entering and leaving a sub-dialog leaves every
 * parent exactly as it was. `collected` carries the input values submitted on
 * the way down to this level, outer levels first; `opener` is the value of
 * the option that opened this level, which a text leaf resolves with. */
type SelectLevel<T> = {
  readonly message: string;
  readonly options: readonly SelectOption<T>[];
  readonly filtering: boolean;
  readonly entered: string;
  readonly active: number;
  readonly collected: Readonly<Record<string, string>>;
  readonly opener: T | undefined;
};

/** A text-field level: the field under entry, the opening option's value the
 * whole session resolves with, and the values collected above it. */
type InputLevel<T> = {
  readonly field: TextField;
  readonly opener: T;
  readonly collected: Readonly<Record<string, string>>;
};

/** Read the active option's declaration: a nested select carries `options`,
 * a text leaf is the field itself. The `in` check narrows the union, so no
 * unchecked shape is trusted for the access. */
function declaredSubDialog<T>(
  option: SelectOption<T>,
):
  | { readonly select: SelectRequest<T> }
  | { readonly field: TextField }
  | undefined {
  const dialog = option.dialog;
  if (dialog === undefined) return undefined;
  if ("options" in dialog) return { select: dialog };
  return { field: dialog };
}

/** Merge one submitted input into the values collected along the path:
 * prototype-free, because a field name is an opaque caller key, with the
 * deeper submission winning a repeated name. Pure, so the merge rule is
 * directly tested whatever path the session walked to reach it. */
export function stackedValues(
  collected: Readonly<Record<string, string>>,
  name: string,
  value: string,
): Record<string, string> {
  const merged: Record<string, string> = Object.assign(
    Object.create(null) as Record<string, string>,
    collected,
  );
  merged[name] = value;
  return merged;
}

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

  return function Select() {
    const { columns, rows } = ink.useWindowSize();
    /** The stack of open levels inside the single render session: the root is
     * the caller's request, Ctrl+Enter pushes the active option's sub-dialog
     * over it, and Escape pops one level above the root. It lives in a ref so
     * a chunk carrying several keys is handled before any of them has
     * re-rendered; every push, pop, and edit bumps `revision` to show the
     * frame the refs now hold. Each level keeps its own filter text and
     * active position, so the trigger never alters a parent and popping
     * restores exactly what it showed. */
    const levels = react.useRef<readonly (SelectLevel<T> | InputLevel<T>)[]>([
      {
        message,
        options,
        filtering,
        entered: "",
        active: 0,
        collected: {},
        opener: undefined,
      },
    ]);
    const [revision, setRevision] = react.useState(0);
    const refresh = () => setRevision((current) => current + 1);
    void revision;
    /** Where each level's window sat on the previous frame, keyed by depth:
     * a child opened over a scrolled parent starts at its own top without
     * disturbing the parent's, and popping restores exactly what the parent
     * showed. Derived rather than driven: every input that could move it
     * already re-renders, and the terminal's own height changes without any
     * input at all. */
    const windowStarts = react.useRef<readonly number[]>([0]);
    const active = react.useRef(0);
    const entered = react.useRef("");
    /** The top level's filter text as state, so typing re-renders: the stack
     * ref holds the same text for the input handler to read mid-chunk. */
    const [filterText, setFilterText] = react.useState("");
    /** The top level's active position as state, so movement re-renders: the
     * stack ref holds the same position for the input handler mid-chunk. */
    const [activeIndex, setActiveIndex] = react.useState(0);
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

    /** The top select level: every key routes here, and the levels beneath it
     * stay rendered and ignore input until it closes. At most one text leaf
     * can sit on top — nothing pushes above it, since the trigger returns
     * early while a leaf is on top — so the top select level is either the
     * uppermost level or the one right beneath it, with the root guaranteeing
     * a select level exists. */
    const topSelect = (): SelectLevel<T> => {
      const uppermost = levels.current[levels.current.length - 1] as
        | SelectLevel<T>
        | InputLevel<T>;
      if (!("field" in uppermost)) return uppermost;
      return levels.current[levels.current.length - 2] as SelectLevel<T>;
    };
    const collectingField = fieldIndex >= 0;
    const top = topSelect();
    const topOptions = top.options;
    const topFiltering = top.filtering;
    // Kept across frames rather than recomputed on each: the animation
    // re-renders the view several times a second, and neither the matching nor
    // the width scan below it can change without the filter text changing.
    // Lowercasing every label on a timer is exactly the kind of cost the
    // animations are not allowed to add.
    const visible = react.useMemo(
      () => visibleOptionIndices(topOptions, filterText),
      [topOptions, filterText],
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
        const { label } = topOptions[index] as SelectOption<T>;
        widest = Math.max(widest, displayWidth(label));
      }
      return widest;
    }, [topOptions, visible]);
    /** The select hint names the expand key exactly while a visible option
     * declares a sub-dialog, matching the glyph contract in the spec. */
    const hint = selectHint(
      topFiltering,
      visible.some(
        (index) => (topOptions[index] as SelectOption<T>).dialog !== undefined,
      ),
    );
    /** Sync the top select level's runtime state into the stack ref and the
     * render state together: refs answer mid-chunk keys before any
     * re-render, state shows the frame the refs now hold. */
    const syncTop = (next: SelectLevel<T>): void => {
      const depth = levels.current.length - 1;
      levels.current = [...levels.current.slice(0, depth), next] as readonly (
        | SelectLevel<T>
        | InputLevel<T>
      )[];
      entered.current = next.entered;
      active.current = next.active;
      setFilterText(next.entered);
      setActiveIndex(next.active);
    };
    // Derived while rendering, and remembered only so the next frame can move
    // each window as little as possible; no window is state of its own.
    // Deriving the top one against the state the frame is actually in is what
    // lets it give back rows to the field's panel the moment collection
    // begins. The shadow row each stacked level above the root adds counts
    // toward the same budget, so the union of the stacked frames stays
    // strictly shorter than the terminal; a stack deeper than the budget still
    // renders the top level with at least one option row, covering whatever
    // of the lower levels it overlaps.
    const depth = levels.current.length;
    const stackedBudget = stackedExtraRows(depth);
    const topStart = windowStarts.current[depth - 1] ?? 0;
    const viewport = optionWindow(
      visible.length,
      activeIndex,
      topStart,
      rows,
      collectingField,
      stackedBudget,
    );
    // The remembered start, not the rendered one: a terminal too short to draw
    // the window collapses it to nothing and renders from the top, and storing
    // that would lose the place the user scrolled to the moment the terminal
    // grew back.
    windowStarts.current = windowStarts.current.map((start, index) =>
      index === depth - 1 ? viewport.rememberedStart : start,
    );
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
      isActive: topFiltering || collectingField || flashing || hidden > 0,
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

    /** Push the active option's sub-dialog over the top level: a nested
     * select starts with a blank filter on its first option, a text leaf
     * starts entry from its field's initial value. The parent keeps its own
     * filter text and active position untouched inside its level. */
    const pushSubDialog = (current: SelectLevel<T>): void => {
      const shown = visibleOptionIndices(current.options, current.entered);
      const chosen = shown[current.active];
      if (chosen === undefined) return;
      const option = current.options[chosen] as SelectOption<T>;
      const declared = declaredSubDialog(option);
      if (declared === undefined) return;
      if ("field" in declared) {
        const leaf: InputLevel<T> = {
          field: declared.field,
          opener: option.value,
          collected: current.collected,
        };
        levels.current = [...levels.current, leaf] as readonly (
          | SelectLevel<T>
          | InputLevel<T>
        )[];
        windowStarts.current = [...windowStarts.current, 0];
        refresh();
        return;
      }
      const nested = declared.select;
      const child: SelectLevel<T> = {
        message: nested.message,
        options: nested.options,
        filtering: filterIsEnabled(nested.filter, nested.options.length),
        entered: "",
        active: 0,
        collected: current.collected,
        opener: undefined,
      };
      levels.current = [...levels.current, child] as readonly (
        | SelectLevel<T>
        | InputLevel<T>
      )[];
      windowStarts.current = [...windowStarts.current, 0];
      entered.current = "";
      active.current = 0;
      setFilterText("");
      setActiveIndex(0);
      refresh();
    };

    /** Pop the top level above the root and restore the parent's filter text
     * and active position exactly as they were: they never left its level. */
    const popLevel = (): void => {
      if (levels.current.length <= 1) {
        cancel();
        return;
      }
      const parent = levels.current[
        levels.current.length - 2
      ] as SelectLevel<T>;
      levels.current = levels.current.slice(0, -1);
      windowStarts.current = windowStarts.current.slice(0, -1);
      entered.current = parent.entered;
      active.current = parent.active;
      setFilterText(parent.entered);
      setActiveIndex(parent.active);
      refresh();
    };

    /** Resolve the whole session: the completing option's value plus every
     * input value collected along the path, prototype-free so an opaque
     * caller key lands as an own value. Plain nested options contribute
     * nothing beyond the path; a text leaf contributes its submitted text
     * under its field's name alongside the opening option's value. */
    const resolveStack = (
      value: T,
      values: Readonly<Record<string, string>>,
    ): void => {
      const outcome: SelectResult<T> = {
        value,
        values: { ...values },
      };
      if (viewport.count === 0) {
        settle({ type: "completed", value: outcome });
        return;
      }
      confirmed.current = outcome;
      reset();
      setFlashing(true);
    };

    ink.useInput((value, key) => {
      // The choice is made and the flash is running it out. Every key is too
      // late to change it, Escape and Ctrl-C included: cancelling a choice
      // already taken is exactly what the flash exists to rule out.
      if (confirmed.current) return;
      // Read once: a text leaf answers keys through its own entry, and the
      // flushed escape reaches every subscriber in one emit, so popping for a
      // leaf here as well would pop twice and cancel the session the pop was
      // meant to save.
      const uppermost = levels.current[levels.current.length - 1] as
        | SelectLevel<T>
        | InputLevel<T>;
      if (key.escape || (key.ctrl && value === "c")) {
        if (collecting.current) {
          cancel();
          return;
        }
        if ("field" in uppermost) return;
        popLevel();
        return;
      }
      // Ink delivers every key parsed out of one chunk in a single synchronous
      // pass, so this list keeps receiving input after the Enter that began
      // collection, before the field entry has mounted. Everything but
      // cancellation is declined from then on — filter edits included;
      // cancellation is answered above, at every stage.
      if (collecting.current) return;
      // While a leaf is on top the select list beneath it stays rendered
      // and ignores input.
      if ("field" in uppermost) return;
      const current = topSelect();
      // The trigger is the modified key report — return with control — never
      // typed or pasted text: `value` carries the whole chunk Ink parsed, so
      // a multi-character chunk (a paste or several keys at once) holds more
      // than the one return the chord reports and must not open anything.
      if (key.return && key.ctrl) {
        if (value.length !== 1) return;
        pushSubDialog(current);
        return;
      }
      // Read from the level rather than the rendered text: a chunk carrying
      // several keys is handled before any of them has re-rendered.
      const shown = visibleOptionIndices(current.options, current.entered);
      if (key.return) {
        const chosen = shown[current.active];
        // Nothing is visible, so there is nothing to confirm.
        if (chosen === undefined) return;
        const option = current.options[chosen] as SelectOption<T>;
        if (option.fields) {
          collecting.current = { value: option.value, fields: option.fields };
          setFieldIndex(0);
        } else {
          resolveStack(option.value, current.collected);
        }
        return;
      }
      const moved = movedPosition(key, current.active, shown.length, rows);
      if (moved !== undefined) {
        syncTop({ ...current, active: moved });
        // The caret goes back to its visible phase on the frame the movement
        // lands in, matching the filter edit below.
        reset();
      } else if (current.filtering) {
        const edited = editedText(current.entered, value, key);
        if (edited === current.entered) return;
        // The point of typing is to narrow to the thing you want and press
        // Enter, so the first match becomes the target rather than whatever
        // row happened to be active before.
        syncTop({ ...current, entered: edited, active: 0 });
        // The caret goes back to its visible phase on the frame the typed
        // character lands in, so no keystroke is ever answered by a row that
        // looks like it lost its caret.
        reset();
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

    /** Submit a text leaf from its entry: the opening option's value plus
     * the path's inputs including the submitted text under its field's name,
     * with the deeper submission winning a repeated name. */
    const submitLeaf = (leaf: InputLevel<T>, text: string): void => {
      resolveStack(
        leaf.opener,
        stackedValues(leaf.collected, leaf.field.name, text),
      );
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

    const current = top;
    const renderMessage = current?.message ?? message;
    const renderOptions = topOptions;
    const renderFiltering = topFiltering;
    const uppermost = levels.current[levels.current.length - 1] as
      | SelectLevel<T>
      | InputLevel<T>;
    const leaf = "field" in uppermost ? uppermost : undefined;

    const panelRows: PanelRow[] = [];
    if (renderFiltering) {
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
        const option = renderOptions[index] as SelectOption<T>;
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
    if (renderFiltering) measure(`${filterPrompt} ${filterText}${caretGlyph}`);
    if (visible.length === 0) measure(noMatch);
    if (hidden > 0) measure(`${hiddenAboveGlyph} ${hidden} more`);
    const width = panelWidth(renderMessage, content, columns);
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
        title: renderMessage,
        double: true,
        width,
        columns,
        // While a field is collected the entry's own panel follows this one
        // and carries the hints that apply; naming navigation and selection
        // here would name keys the dialog has stopped answering. A text leaf
        // answers through its own entry the same way.
        hint: collectingField || leaf !== undefined ? undefined : hint,
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
    } else if (leaf !== undefined) {
      // A text leaf reuses the existing entry logic: its editing is the same
      // implementation a standalone input and a collected field use. Its
      // cancel pops one level rather than cancelling the session, so Escape
      // above the root and Escape on a leaf stay distinct.
      const activeLeaf = leaf;
      fieldPanel = react.createElement(Entry, {
        key: "leaf",
        message: activeLeaf.field.message,
        initialValue: activeLeaf.field.initialValue,
        caret: showPhase,
        onEdit: reset,
        onSubmit: (value: string) => submitLeaf(activeLeaf, value),
        onCancel: () => popLevel(),
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
