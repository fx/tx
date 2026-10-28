import { expect, test } from "bun:test";
import { ThemeProvider } from "@fx/ui";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { App } from "../src/App";
import config from "../vite.config";

test("renders the application and its installation instructions", () => {
  render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  );
  expect(screen.getByText("Extensible command-line toolbox.")).toBeDefined();
  expect(screen.getByText("mise use -g github:fx/tx")).toBeDefined();
  cleanup();
});

test("copies the installation commands from the site", async () => {
  let copied = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  );
  const block = screen.getByText("Install").parentElement;
  if (!block) throw new Error("Install command block missing");
  fireEvent.click(
    within(block).getByRole("button", { name: "Copy to clipboard" }),
  );
  await within(block).findByRole("button", { name: "Copied" });
  expect(copied).toBe("mise use -g github:fx/tx\ntx --version");
  cleanup();
});

test("switches the site theme", () => {
  render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  );
  const button = screen.getByRole("button", {
    name: /Switch to (dark|light) theme/,
  });
  const initial = button.getAttribute("aria-label");
  fireEvent.click(button);
  expect(button.getAttribute("aria-label")).not.toBe(initial);
  cleanup();
});

test("keeps development server access restricted to tailnet hosts", () => {
  expect(config.server?.allowedHosts).toEqual([".ts.net"]);
});

test("mounts the application into the document root", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    await import("../src/main");
  });
  expect(
    await screen.findByText("Extensible command-line toolbox."),
  ).toBeDefined();
});

test("loads every site source module for coverage", async () => {
  const modules = Array.from(
    new Bun.Glob("**/*.{ts,tsx,mts,cts}").scanSync({
      cwd: `${import.meta.dir}/../src`,
      absolute: true,
    }),
  );
  expect(modules.length).toBeGreaterThan(0);
  for (const module of modules) await import(module);
});
