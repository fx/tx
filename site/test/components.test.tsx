import { afterEach, expect, test } from "bun:test";
import { ThemeProvider } from "@fx/ui";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CommandBlock } from "../src/components/CommandBlock";
import { ThemeToggle } from "../src/components/ThemeToggle";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
const execCommandDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "execCommand",
);

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  if (clipboardDescriptor)
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (execCommandDescriptor)
    Object.defineProperty(document, "execCommand", execCommandDescriptor);
  else Reflect.deleteProperty(document, "execCommand");
});

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

test("copies all commands and confirms success", async () => {
  let copied = "";
  clipboard(async (text) => {
    copied = text;
  });
  render(<CommandBlock commands={["one", "two"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
  await screen.findByRole("button", { name: "Copied" });
  expect(copied).toBe("one\ntwo");
});

test("falls back to selection when clipboard rejects or is unavailable", async () => {
  let calls = 0;
  document.execCommand = (command) => {
    calls++;
    return command === "copy";
  };
  clipboard(async () => {
    throw new Error("denied");
  });
  const view = render(<CommandBlock commands={["one"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
  await screen.findByRole("button", { name: "Copied" });
  expect(calls).toBe(1);
  expect(document.querySelector("textarea")).toBeNull();
  view.unmount();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  render(<CommandBlock commands={["two"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
  await screen.findByRole("button", { name: "Copied" });
  expect(calls).toBe(2);
});

test("does not show success when both copy methods fail", async () => {
  clipboard(async () => {
    throw new Error("denied");
  });
  document.execCommand = () => false;
  render(<CommandBlock commands={["one"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
  await waitFor(() => expect(document.querySelector("textarea")).toBeNull());
  expect(
    screen.getByRole("button", { name: "Copy to clipboard" }),
  ).toBeDefined();
});

test("settling a clipboard write after unmount does not start a timer", async () => {
  let resolve!: () => void;
  clipboard(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const view = render(<CommandBlock commands={["one"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
  view.unmount();
  resolve();
  await Promise.resolve();
  expect(document.querySelector("button")).toBeNull();
});

test("toggles the resolved theme", () => {
  window.localStorage.setItem("theme", "light");
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
  const button = screen.getByRole("button", { name: "Switch to dark theme" });
  fireEvent.click(button);
  expect(button.getAttribute("aria-label")).toBe("Switch to light theme");
  expect(window.localStorage.getItem("theme")).toBe("dark");
  fireEvent.click(button);
  expect(button.getAttribute("aria-label")).toBe("Switch to dark theme");
  expect(window.localStorage.getItem("theme")).toBe("light");
});

test("resets the confirmation after the copy timeout", async () => {
  clipboard(async () => {});
  render(<CommandBlock commands={["one"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
  await screen.findByRole("button", { name: "Copied" });
  await waitFor(
    () =>
      expect(
        screen.getByRole("button", { name: "Copy to clipboard" }),
      ).toBeDefined(),
    { timeout: 2500 },
  );
});

test("keeps the copy action available if the fallback throws", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  document.execCommand = () => {
    throw new Error("unsupported");
  };
  render(<CommandBlock commands={["one"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
  await Promise.resolve();
  expect(
    screen.getByRole("button", { name: "Copy to clipboard" }),
  ).toBeDefined();
  expect(document.querySelector("textarea")).toBeNull();
});
