import { expect, test } from "bun:test";
import { truncateSegments } from "../plugins/dialogs/frame.ts";

test("a frame too narrow for its first wide glyph retains an ellipsis", () => {
  const segments = [
    { key: "label", text: "界界", variable: "content" as const },
  ];
  expect(truncateSegments(segments, 1)).toEqual([
    { key: "cut", text: "…", variable: "content" },
  ]);
  expect(truncateSegments(segments, 1, true)).toEqual([
    { key: "cut", text: "…", variable: "content" },
  ]);
});
