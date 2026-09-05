import type { CoreDependencies } from "@fx/tx/plugin";
import {
  animationInterval,
  flashDuration,
  flashInterval,
  onPhase,
} from "./animation.ts";
import {
  columnCells,
  columnDivider,
  columnsWidth,
  columnWidth,
  droppedColumns,
  fitColumnWidths,
  hiddenAboveGlyph,
  hiddenBelowGlyph,
  indicatorText,
  stretchLastColumn,
} from "./columns.ts";
import { type EntryComponent, editedText, withCaret } from "./entry.ts";
import {
  type FilterMode,
  filterIsShown,
  visibleOptionIndices,
} from "./filter.ts";
import {
  availableInnerWidth,
  displayWidth,
  type FrameComponent,
  type FrameRow,
  type FrameSegment,
  innerWidth,
  panelWidth,
  segmentsWidth,
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
import { optionRowCount, optionWindow } from "./viewport.ts";

/** The prompt the filter row carries, so the row the user types into is
 * distinguishable from the option rows under it. */
const filterPrompt = "›";

/** What separates the levels named in the panel's title. */
const trailSeparator = "›";

/** What stands in the title for the columns that have collapsed off its left,
 * so a title always names exactly the columns on screen. */
const trailElision = "…";

/**
 * How a sub-dialog is opened.
 *
 * `enter` is the default and the one the marker on an expandable row
 * promises: the key that takes a plain option opens an option that leads
 * somewhere, so there is one key to learn rather than two. `tab` keeps Enter
 * meaning "take this" at every level, for a caller whose expandable options
 * are also choices in their own right. The right arrow opens under either
 * binding, and the left arrow backs out under either.
 */
export type ExpandKey = "enter" | "tab";

/**
 * The select's key hint line, assembled from the phrases that apply rather
 * than written out whole, because which of them apply depends on where the
 * reader is: whether the option under the bar leads anywhere, whether there is
 * a column to their left to back out into, and whether the filter is taking
 * keys. The line never names a key the dialog would ignore.
 */
function selectHint(state: {
  readonly expandable: boolean;
  readonly nested: boolean;
  readonly expandKey: ExpandKey;
}): string {
  const phrases = ["↑↓ move"];
  if (state.expandable) {
    phrases.push(state.expandKey === "tab" ? "→/Tab open" : "→/Enter open");
  }
  // An expandable option under the Enter binding is opened rather than taken,
  // so naming a select key on it would name one the dialog does not answer.
  if (!(state.expandable && state.expandKey === "enter")) {
    phrases.push("Enter select");
  }
  // Escape does not cancel from a column: it backs out exactly as the left
  // arrow does, and only the leftmost column's Escape closes the dialog. The
  // two keys do one thing here, so they are named as one phrase, and
  // cancelling is named only where it is what Escape does.
  if (state.nested) phrases.push("←/Esc back");
  // Named whether or not the filter is on screen: typing always narrows the
  // list, so a reader who has not typed yet is exactly the one the phrase is
  // for, and a phrase that came and went as they typed would be one more
  // thing moving under them.
  phrases.push("type to filter");
  if (!state.nested) phrases.push("Esc cancel");
  return phrases.join(" · ");
}

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
  readonly filter: FilterMode;
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
  readonly filter: FilterMode;
  /** Which key opens a sub-dialog, for the whole dialog rather than per
   * level: one dialog answers one set of keys however deep the reader goes. */
  readonly expandKey: ExpandKey;
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
  { message, options, filter, expandKey }: SelectViewRequest<T>,
  settle: (outcome: Outcome<SelectResult<T>>) => void,
): DialogView {
  const cancel = () => settle({ type: "cancelled" });

  return function Select() {
    const { columns, rows } = ink.useWindowSize();
    /** The stack of open levels inside the single render session: the root is
     * the caller's request, Tab pushes the active option's sub-dialog
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
        filter,
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
    /** What each column left of the driven one matched and measured to, kept
     * per column rather than recomputed on every frame. Those columns are
     * frozen — nothing about their options or their filter text can change
     * while a sub-dialog opened from them is on screen — so matching them
     * again on the animation's timer would be exactly the
     * lowercase-every-label cost the driven column's own memo exists to
     * avoid. Keyed by the level object itself, so backing out of a column and
     * opening a different one in its place recomputes rather than reusing a
     * stale entry. */
    const columnContent = react.useRef<
      readonly (
        | {
            readonly level: SelectLevel<T>;
            readonly visible: readonly number[];
            readonly widestLabel: number;
            readonly expandable: boolean;
          }
        | undefined
      )[]
    >([]);
    const columnMatches = (index: number, level: SelectLevel<T>) => {
      const cached = columnContent.current[index];
      if (cached !== undefined && cached.level === level) return cached;
      const shown = visibleOptionIndices(level.options, level.entered);
      let widest = 0;
      let expandable = false;
      for (const at of shown) {
        const option = level.options[at] as SelectOption<T>;
        widest = Math.max(widest, displayWidth(option.label));
        if (option.dialog !== undefined) expandable = true;
      }
      const measurement = {
        level,
        visible: shown,
        widestLabel: widest,
        expandable,
      };
      const next = [...columnContent.current];
      next[index] = measurement;
      columnContent.current = next;
      return measurement;
    };
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
    /** The text leaf on top of the stack, if one is open. It holds a level and
     * a `windowStarts` slot without being a column of the browser: it draws as
     * its own entry panel beneath the frame, exactly as a collected field does.
     * Derived here rather than beside the panels it draws, because the viewport
     * below has to budget the rows that panel takes and index past the slot it
     * holds. */
    const uppermost = levels.current[levels.current.length - 1] as
      | SelectLevel<T>
      | InputLevel<T>;
    const leaf = "field" in uppermost ? uppermost : undefined;
    const collectingField = fieldIndex >= 0;
    /** Whether an entry panel is on screen under the browser, from either of
     * the two things that put one there. Both spend the frame the same rows, so
     * both have to be budgeted the same way: a leaf budgeted as if nothing were
     * under the browser sizes the window against three rows of chrome while the
     * frame spends six, and the difference is exactly the height at which Ink
     * reads the output as full-screen and clears the terminal. */
    const entryOnScreen = collectingField || leaf !== undefined;
    const top = topSelect();
    const topOptions = top.options;
    const topFilter = top.filter;
    // Kept across frames rather than recomputed on each: the animation
    // re-renders the view several times a second, and neither the matching nor
    // the width scan below it can change without the filter text changing.
    // Lowercasing every label on a timer is exactly the kind of cost the
    // animations are not allowed to add.
    const visible = react.useMemo(
      () => visibleOptionIndices(topOptions, filterText),
      [topOptions, filterText],
    );
    /** What the driven column measures to: the widest visible label in
     * terminal columns, and whether any visible option leads somewhere, which
     * is what makes the column reserve the marker on its right edge.
     *
     * The widest label is kept as a running maximum rather than an array
     * spread into `Math.max`: measuring every visible option makes the
     * argument count the length of the list rather than the height of the
     * window, and a spread that long throws `RangeError` on a list a select
     * can plausibly be given — a branch, plugin, or version list. One pass
     * over the same strings, no intermediate array, and only when the filter
     * has changed what is visible. */
    const liveMatches = react.useMemo(() => {
      let widest = 0;
      let expandable = false;
      for (const index of visible) {
        const option = topOptions[index] as SelectOption<T>;
        widest = Math.max(widest, displayWidth(option.label));
        if (option.dialog !== undefined) expandable = true;
      }
      return { visible, widestLabel: widest, expandable };
    }, [topOptions, visible]);
    /** The option under the bar, which is what the hint describes and what
     * every key that opens or takes something acts on. */
    const activeOption =
      visible[activeIndex] === undefined
        ? undefined
        : (topOptions[visible[activeIndex] as number] as SelectOption<T>);
    /** The filter is on screen once anything has been typed into this column,
     * and from the start for a caller that asked for it. Filtering itself is
     * always live, which is why the hint names it whether or not this is set. */
    const filterShown = filterIsShown(topFilter, filterText);
    const hint = selectHint({
      expandable: activeOption?.dialog !== undefined,
      nested: levels.current.length > 1,
      expandKey,
    });
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
    // Deriving the driven one against the state the frame is actually in is
    // what lets it give back rows to the field's panel the moment collection
    // begins. Every column shares the terminal's rows, because they are
    // side by side rather than stacked, so no column costs another one a row.
    /** Where the driven column sits in the stack, which is the top level only
     * while no text leaf is open: a leaf sits above it and holds a slot of its
     * own, pushed as a zero. Reading the top slot while one is open would
     * re-window a scrolled column from that zero and, because the result is
     * written back, lose the place it was scrolled to for good. */
    const drivenColumn = levels.current.length - (leaf === undefined ? 1 : 2);
    const topStart = windowStarts.current[drivenColumn] ?? 0;
    const viewport = optionWindow(
      visible.length,
      activeIndex,
      topStart,
      rows,
      entryOnScreen,
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
      isActive: filterShown || collectingField || flashing || hidden > 0,
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
        filter: nested.filter ?? "typed",
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
      // The child answers keys through its own frame: clear any collection
      // the parent began so its stale record never blocks the new level.
      collecting.current = undefined;
      field.current = 0;
      setFieldIndex(-1);
      collected.current = Object.create(null) as Record<string, string>;
      entered.current = "";
      active.current = 0;
      setFilterText("");
      setActiveIndex(0);
      refresh();
    };

    /** Pop the top level above the root and restore the parent's filter text
     * and active position exactly as they were: they never left its level.
     * A collection abandoned mid-flight is discarded with its level, so the
     * parent answers keys again instead of declining them as post-Enter
     * input. */
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
      collecting.current = undefined;
      field.current = 0;
      setFieldIndex(-1);
      collected.current = Object.create(null) as Record<string, string>;
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
        values: Object.assign(
          Object.create(null) as Record<string, string>,
          values,
        ),
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
        // A collection open on a nested level pops that level like any other
        // top: the spec's pop rule holds at every stack depth, and only the
        // root's own collection cancels the session. The collected-field
        // entry answers the same key through its own handler, but this one
        // runs first in the emit, so it owns the decision.
        if (collecting.current) {
          if (levels.current.length > 1) popLevel();
          else cancel();
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
      // cancellation is answered above, at every stage. A collection is
      // always answered through its own entry at whatever depth it began,
      // so the select ignores everything but cancellation while one is open.
      if (collecting.current) return;
      // While a leaf is on top the select list beneath it stays rendered
      // and ignores input.
      if ("field" in uppermost) return;
      const current = topSelect();
      // Read from the level rather than the rendered text: a chunk carrying
      // several keys is handled before any of them has re-rendered.
      const shown = visibleOptionIndices(current.options, current.entered);
      const chosen = shown[current.active];
      const option =
        chosen === undefined
          ? undefined
          : (current.options[chosen] as SelectOption<T>);
      // The columns run left to right, so the arrows that cross them do too:
      // right opens the column an option leads to, left backs out into the
      // column that opened this one. They work under either binding, which is
      // what lets the binding be about Enter alone.
      //
      // Tab opens only where the caller has bound it there. Under the Enter
      // binding it reaches nothing: a standalone input and a field entry never
      // move focus and the select has no focus to move, and the filter drops
      // it as the control character it is, so it is simply inert.
      if (key.rightArrow || (key.tab && expandKey === "tab")) {
        pushSubDialog(current);
        return;
      }
      if (key.leftArrow) {
        // Backing out of the leftmost column is backing out of the dialog,
        // which is Escape's job rather than an arrow's: at the root this does
        // nothing rather than cancelling.
        if (levels.current.length > 1) popLevel();
        return;
      }
      if (key.return) {
        // Nothing is visible, so there is nothing to open or confirm.
        if (option === undefined) return;
        // Under the Enter binding, an option that leads somewhere is opened
        // rather than taken — which is exactly what the marker on its row
        // promises, and why the hint on such a row names opening instead of
        // selecting.
        if (option.dialog !== undefined && expandKey === "enter") {
          pushSubDialog(current);
          return;
        }
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
      } else {
        // Typing always filters, at every level and whatever the list's
        // length. There is no second thing a printable character could mean
        // here, and a reader who starts typing at a list is asking for exactly
        // one thing; the setting decides only whether the filter was on screen
        // before they did.
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
        // The collection completes its level, which resolves the whole
        // session: the chosen value plus every input along the path — the
        // level's base first, this collection's submissions over it, so a
        // deeper submission wins a repeated name. The root settles exactly
        // as a flat dialog does.
        const path = topSelect();
        let merged = path.collected;
        for (const [name, text] of Object.entries(collected.current)) {
          merged = stackedValues(merged, name, text);
        }
        settle({
          type: "completed",
          value: {
            value: collection.value,
            values: Object.assign(
              Object.create(null) as Record<string, string>,
              merged,
            ),
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

    const renderFiltering = filterShown;
    // While a field is collected the entry's own panel follows this one and
    // carries the hints that apply; naming navigation and selection here
    // would name keys the dialog has stopped answering. A text leaf answers
    // through its own entry the same way — which is the same panel on screen
    // the viewport is budgeted against, so it is the same predicate.
    const entryHasKeys = entryOnScreen;

    // Every select level is a column of one browser. The frame is the root's
    // and stays the root's however deep the stack goes: a sub-dialog is the
    // next column of the panel its parent is already in, not a panel of its
    // own over it. Nothing here is offset, bordered, or shadowed, because
    // there is nothing to be offset from.
    const selectLevels = (
      leaf !== undefined ? levels.current.slice(0, -1) : levels.current
    ) as readonly SelectLevel<T>[];
    const laid = selectLevels.map((level, index) => {
      // The driven column reads live state; the ones behind it are frozen, so
      // their matching comes from the cache rather than being repeated on the
      // animation's timer.
      const driven = index === drivenColumn;
      const matched = driven ? liveMatches : columnMatches(index, level);
      return {
        level,
        driven,
        matched,
        active: driven ? activeIndex : level.active,
        // Frozen columns keep their bar on; only the driven one blinks it out
        // while a choice is confirmed.
        bar: driven ? barInverted : true,
        viewport: driven
          ? viewport
          : optionWindow(
              matched.visible.length,
              level.active,
              windowStarts.current[index] ?? 0,
              rows,
              entryOnScreen,
            ),
      };
    });
    // Only the driven column's window is written back. Every column keeps its
    // own place in its own list, but a frozen one re-derives its window from
    // the start it already remembers on every frame, so it needs no write of
    // its own — and taking one would be wrong: the columns share one band, so
    // an entry panel appearing shrinks the band for all of them, and the start
    // `optionWindow` moves down to keep a frozen column's active option in a
    // shorter window is the state of this frame rather than the place that
    // column was left on. Persisting it would drift the column away from that
    // place every time the band shrank, and it would never come back.
    windowStarts.current = windowStarts.current.map((start, index) =>
      index === drivenColumn ? viewport.rememberedStart : start,
    );

    const widths = laid.map((column) =>
      columnWidth(
        column.matched.widestLabel,
        column.matched.expandable,
        column.matched.visible.length === 0,
      ),
    );
    // Running out of room collapses the oldest columns first. The driven
    // column is the rightmost and is never dropped: it is truncated instead,
    // like every other row that runs out of columns.
    const available = availableInnerWidth(columns);
    const dropped = droppedColumns(widths, available);
    const shown = laid.slice(dropped);
    // The last column left is cut back rather than dropped: collapsing stops
    // at one, and the one being driven has to stay on screen.
    const shownWidths = fitColumnWidths(widths.slice(dropped), available);
    // The title names exactly the columns on screen, and says so when earlier
    // ones have collapsed off its left.
    const trail = shown.map((column) => column.level.message);
    const title = (dropped > 0 ? [trailElision, ...trail] : trail).join(
      ` ${trailSeparator} `,
    );

    // The columns share one band, so a list of three and a list of thirty
    // start on the same row. A column whose filter matched nothing spends its
    // one row saying so. Nothing but option rows is in the band: the filter
    // and the overflow counts are set into the frame's edges, so neither can
    // move the list by appearing.
    const bandRows = shown.reduce(
      (most, column) =>
        Math.max(
          most,
          column.matched.visible.length === 0 ? 1 : column.viewport.count,
        ),
      0,
    );
    const driven = shown.at(-1);
    /** Everything the driven column has off screen, either side of its window
     * together. It is the largest either count can ever reach, so it is the
     * room both edges hold for one — held whether a count is showing or not,
     * because a title that retruncates as the reader scrolls past the first
     * hidden row is the same restlessness the counts were moved out of the
     * panel to stop. */
    const hiddenEitherSide = driven
      ? driven.matched.visible.length - driven.viewport.count
      : 0;
    const edgeReserve =
      hiddenEitherSide > 0
        ? displayWidth(` ${indicatorText(hiddenAboveGlyph, hiddenEitherSide)} `)
        : 0;
    /** An overflow count set into an edge, or nothing when the driven column
     * hides nothing on that side. Pulsed between dimmed and normal on the
     * caret's own phase, so it says "there is more" without a second timer and
     * without ever being on screen when nothing is hidden. Only the driven
     * column reports: it is the only one that scrolls, and the columns behind
     * it are already showing the choice that was made in them. */
    const overflow = (
      key: string,
      glyph: string,
      count: number,
    ): readonly FrameSegment[] =>
      count > 0
        ? [
            { key: `${key}-open`, text: " ", variable: "chrome" },
            // Pulsed by naming chrome on the phase and content off it: the
            // count is chrome that steps forward rather than a second
            // appearance decision made here.
            {
              key,
              text: indicatorText(glyph, count),
              variable: showPhase ? "chrome" : "content",
            },
            { key: `${key}-close`, text: " ", variable: "chrome" },
          ]
        : [];
    /** The filter, set into the bottom edge rather than drawn as a row of the
     * panel. Turning it on as a column that filters is opened would otherwise
     * push every option row down by one, which is exactly the moment the
     * reader is looking at the list. */
    const filterEdge: readonly FrameSegment[] = renderFiltering
      ? [
          { key: "prompt", text: ` ${filterPrompt} `, variable: "chrome" },
          {
            key: "filter",
            text: withCaret(filterText, filterCaret),
            variable: "content",
          },
          { key: "prompt-close", text: " ", variable: "chrome" },
        ]
      : [];

    // Sized for its columns, and for whichever of its two edges carries the
    // most: the title and the filter are both set into one, and both compete
    // with the count held on its right.
    const edgeColumns =
      Math.max(displayWidth(title) + 2, segmentsWidth(filterEdge)) +
      edgeReserve;
    const width = panelWidth(
      title,
      columnsWidth(shownWidths),
      columns,
      edgeColumns,
    );
    // Sized last, once the frame's own width is known: whatever the title made
    // the panel wider by belongs to the last column, so its cursor bar spans
    // the panel instead of stopping short of it.
    const drawnWidths = stretchLastColumn(shownWidths, innerWidth(width));
    const cells = shown.map((column, at) =>
      columnCells(
        column.level.options,
        column.matched.visible,
        column.viewport,
        column.active,
        drawnWidths[at] as number,
        bandRows,
        { bar: column.bar },
      ),
    );

    const panelRows: FrameRow[] = [];
    for (let row = 0; row < bandRows; row += 1) {
      const segments: FrameSegment[] = [];
      for (const [at, column] of cells.entries()) {
        if (at > 0) {
          segments.push({
            key: `divider-${at}`,
            text: ` ${columnDivider} `,
            variable: "chrome",
          });
        }
        const drawn = column[row];
        // A column with nothing on this row still spends its columns on it, so
        // the column after it starts where the ones above and below it do.
        segments.push(
          drawn === undefined
            ? {
                key: `cell-${at}`,
                text: " ".repeat(drawnWidths[at] as number),
                variable: "content" as const,
              }
            : {
                key: `cell-${at}`,
                text: drawn.text,
                variable: drawn.variable,
              },
        );
      }
      panelRows.push({ key: `band-${row}`, segments });
    }

    const panel = react.createElement(Frame, {
      key: "select",
      title,
      double: true,
      width,
      columns,
      hint: entryHasKeys ? undefined : hint,
      topRight: overflow(
        "hidden-above",
        hiddenAboveGlyph,
        driven?.viewport.hiddenAbove ?? 0,
      ),
      bottomLeft: filterEdge,
      // What has been typed keeps its end and its caret when it runs longer
      // than the edge.
      bottomLeftTail: true,
      edgeReserve,
      bottomRight: overflow(
        "hidden-below",
        hiddenBelowGlyph,
        driven?.viewport.hiddenBelow ?? 0,
      ),
      rows: panelRows,
    });
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
        // The main handler answers the same key first in the emit and pops a
        // nested collection; this fires second, so it acts only while a
        // collection is still open. At the root that means a harmless second
        // cancel; above the root the pop already cleared it into a no-op.
        onCancel: () => {
          if (collecting.current) cancel();
        },
        // Keyed on the same condition the main handler branches on above, so
        // the line and the key cannot drift apart: where that handler pops,
        // Escape backs out of the collection's column and the entry's own
        // handler never runs; where it cancels, so does this.
        escapeAction: levels.current.length > 1 ? "back" : "cancel",
      });
    } else if (leaf !== undefined) {
      // A text leaf reuses the existing entry logic: its editing is the same
      // implementation a standalone input and a collected field use. Its
      // cancel pops one level rather than cancelling the session, so Escape
      // above the root and Escape on a leaf stay distinct. It is a panel under
      // the browser rather than a column in it, because a column is a list and
      // this is a line being typed into.
      const activeLeaf = leaf;
      fieldPanel = react.createElement(Entry, {
        key: "leaf",
        message: activeLeaf.field.message,
        initialValue: activeLeaf.field.initialValue,
        caret: showPhase,
        onEdit: reset,
        onSubmit: (value: string) => submitLeaf(activeLeaf, value),
        onCancel: () => popLevel(),
        // A leaf is only ever pushed over the select that opened it, so it is
        // never at the leftmost level and that pop always pops: Escape here
        // backs out and never cancels.
        escapeAction: "back",
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
