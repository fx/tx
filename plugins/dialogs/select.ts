import type { CoreDependencies } from "@fx/tx/plugin";
import { type EntryComponent, editedText } from "./entry.ts";
import { visibleOptionIndices } from "./filter.ts";
import type {
  DialogElement,
  DialogView,
  Outcome,
  SelectOption,
  SelectResult,
  TextField,
} from "./types.ts";

/** The prompt the filter row carries. Deliberately not the `>` an active option
 * carries, so the two rows stay distinguishable in output. */
const filterPrompt = "›";

/** What the dialog shows when the filter text leaves nothing visible. */
const noMatch = "no match";

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
 * The active position and every key that moves it are expressed over the
 * visible options rather than over the supplied list, so navigation composes
 * with the filter and the settled value is still looked up by its original
 * index.
 */
export function createSelectView<T>(
  react: CoreDependencies["react"],
  ink: CoreDependencies["ink"],
  Entry: EntryComponent,
  { message, options, filtering }: SelectViewRequest<T>,
  settle: (outcome: Outcome<SelectResult<T>>) => void,
): DialogView {
  const cancel = () => settle({ type: "cancelled" });

  return function Select() {
    const active = react.useRef(0);
    const [activeIndex, setActiveIndex] = react.useState(0);
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

    ink.useInput((value, key) => {
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
          settle({
            type: "completed",
            value: { value: option.value, values: {} },
          });
        }
      } else if (key.upArrow || key.downArrow) {
        if (visible.length === 0) return;
        const moved = active.current + (key.upArrow ? -1 : 1);
        active.current = Math.min(visible.length - 1, Math.max(0, moved));
        setActiveIndex(active.current);
      } else if (filtering) {
        const edited = editedText(entered.current, value, key);
        if (edited === entered.current) return;
        entered.current = edited;
        setFilterText(edited);
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

    const visible = visibleOptionIndices(options, filterText);
    const children: DialogElement[] = [
      react.createElement(ink.Text, { key: "message" }, message),
    ];
    if (filtering) {
      children.push(
        react.createElement(
          ink.Text,
          { key: "filter" },
          `${filterPrompt} ${filterText}`,
        ),
      );
    }
    if (visible.length === 0) {
      children.push(
        react.createElement(ink.Text, { key: "no-match" }, noMatch),
      );
    } else {
      for (const [position, index] of visible.entries()) {
        const option = options[index] as SelectOption<T>;
        children.push(
          react.createElement(
            ink.Text,
            { key: `option-${index}` },
            `${position === activeIndex ? ">" : " "} ${option.label}`,
          ),
        );
      }
    }
    if (fieldIndex >= 0) {
      const collection = collecting.current as Collection<T>;
      const pending = collection.fields[fieldIndex] as TextField;
      children.push(
        react.createElement(Entry, {
          key: `field-${fieldIndex}`,
          message: pending.message,
          initialValue: pending.initialValue,
          onSubmit: (value: string) => submitField(fieldIndex, value),
          onCancel: cancel,
        }),
      );
    }

    return react.createElement(
      ink.Box,
      { flexDirection: "column" },
      ...children,
    );
  };
}
