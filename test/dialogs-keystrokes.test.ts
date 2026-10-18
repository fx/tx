import { describe, expect, test } from "bun:test";
import { type InputKey, keystrokes } from "../plugins/dialogs/entry.ts";
import { paintedWidth } from "../plugins/dialogs/frame.ts";

/**
 * The two pure rules the dialogs share: how one input event is cut into the
 * keystrokes it carries, and how wide every row of a dialog is painted.
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

describe("the width a dialog paints its rows to", () => {
  test("is the panel's own where the hint fits under it", () => {
    expect(paintedWidth(30, "short", 80)).toBe(30);
    expect(paintedWidth(30, undefined, 80)).toBe(30);
  });

  test("grows to the hint line and the column that leads it", () => {
    expect(paintedWidth(10, "x".repeat(40), 80)).toBe(41);
  });

  test("grows to the floor a panel above it sets", () => {
    expect(paintedWidth(10, "hint", 80, 25)).toBe(25);
    expect(paintedWidth(30, "hint", 80, 25)).toBe(30);
  });

  test("never passes the terminal, laid out as twenty columns below that", () => {
    expect(paintedWidth(10, "x".repeat(100), 80)).toBe(80);
    expect(paintedWidth(10, "x".repeat(100), 5)).toBe(20);
    expect(paintedWidth(10, undefined, 5, 90)).toBe(20);
  });
});
