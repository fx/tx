import { describe, expect, test } from "bun:test";
import { type InputKey, keystrokes } from "../plugins/dialogs/entry.ts";
import { laidOutWidth } from "../plugins/dialogs/frame.ts";

/**
 * The two pure rules the dialogs share: how one input event is cut into the
 * keystrokes it carries, and how wide a dialog is laid out.
 */

const typed = { return: false, ctrl: false, meta: false } as InputKey;
const RETURN = "\r";

describe("keystrokes of one input event", () => {
  test("an event with no carriage return is one keystroke, key report and all", () => {
    expect(keystrokes("a", typed)).toEqual([["a", typed]]);
    expect(keystrokes("pasted text", typed)).toEqual([["pasted text", typed]]);
    const resolved = { ...typed, return: true };
    expect(keystrokes("", resolved)).toEqual([["", resolved]]);
  });

  test("a space the return follows is the Space keystroke, then Enter", () => {
    expect(keystrokes(` ${RETURN}`, typed)).toEqual([
      [" ", typed],
      ["", { ...typed, return: true }],
    ]);
  });

  test("text around a return is answered before and after the Enter", () => {
    expect(keystrokes(`ab${RETURN}cd`, typed)).toEqual([
      ["ab", typed],
      ["", { ...typed, return: true }],
      ["cd", typed],
    ]);
  });

  test("every return is an Enter of its own, with no empty text between", () => {
    expect(keystrokes(`${RETURN}${RETURN}x`, typed)).toEqual([
      ["", { ...typed, return: true }],
      ["", { ...typed, return: true }],
      ["x", typed],
    ]);
  });
});

describe("the width a dialog is laid out in", () => {
  test("is the panel's own where the hint fits under it", () => {
    expect(laidOutWidth(30, "short", 80)).toBe(30);
    expect(laidOutWidth(30, undefined, 80)).toBe(30);
  });

  test("grows to the hint line and the column that leads it", () => {
    expect(laidOutWidth(10, "x".repeat(40), 80)).toBe(41);
  });

  test("never passes the terminal, laid out as twenty columns below that", () => {
    expect(laidOutWidth(10, "x".repeat(100), 80)).toBe(80);
    expect(laidOutWidth(10, "x".repeat(100), 5)).toBe(20);
  });
});
