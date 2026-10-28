import { expect } from "bun:test";
import { PassThrough } from "node:stream";

/** Captures terminal writes while exposing its size and TTY state. */
export class TerminalOutput extends PassThrough {
  #output = "";

  constructor(
    readonly isTTY = true,
    public columns = 80,
    public rows = 24,
  ) {
    super();
    this.on("data", (chunk) => {
      this.#output += chunk.toString();
    });
  }

  text(): string {
    return this.#output;
  }
}

export function pause(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitUntil(
  predicate: () => boolean,
  budget: number,
  message: string,
): Promise<void> {
  const deadline = performance.now() + budget;
  for (;;) {
    if (predicate()) return;
    if (performance.now() >= deadline) throw new Error(message);
    await pause(1);
  }
}

const escapeCharacter = String.fromCharCode(27);
const controlSequence = new RegExp(
  `${escapeCharacter}\\[[\\d;?]*[a-zA-Z]`,
  "g",
);
const cursorSequence = new RegExp(
  `${escapeCharacter}\\[[\\d;?]*[A-Za-ln-z]`,
  "g",
);

export function stripped(text: string): string {
  return text.replace(controlSequence, "");
}

/** Ink rewrites each frame, leaving cursor sequences ahead of its anchor. */
export function lastFrame(output: { text(): string }, anchor: string): string {
  const text = output.text();
  const found = text.lastIndexOf(anchor);
  expect(found).toBeGreaterThanOrEqual(0);
  const start = text.lastIndexOf("\n", found) + 1;
  let boundary = 0;
  for (const match of text.slice(start, found).matchAll(cursorSequence)) {
    boundary = (match.index as number) + match[0].length;
  }
  return text.slice(start + boundary);
}

export function frameRows(
  output: { text(): string },
  anchor: string,
): readonly string[] {
  const rows = stripped(lastFrame(output, anchor)).split("\n");
  while (rows.at(-1) === "") rows.pop();
  return rows;
}
