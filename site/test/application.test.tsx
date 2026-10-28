import { afterEach, expect, spyOn, test } from "bun:test";
import { ThemeProvider } from "@fx/ui";
import { act, cleanup, render, screen } from "@testing-library/react";
import * as ReactDOM from "react-dom/client";
import { App } from "../src/App";
import config from "../vite.config";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  window.localStorage.clear();
});

test("renders the application and its installation instructions", () => {
  render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  );
  expect(screen.getByText("Extensible command-line toolbox.")).toBeDefined();
  expect(screen.getByText("mise use -g github:fx/tx")).toBeDefined();
});

test("keeps development server access restricted to tailnet hosts", () => {
  expect(config.server?.allowedHosts).toEqual([".ts.net"]);
});

test("mounts the application into the document root", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const originalCreateRoot = ReactDOM.createRoot;
  let mounted: ReturnType<typeof originalCreateRoot> | undefined;
  const createRoot = spyOn(ReactDOM, "createRoot").mockImplementation(
    (container, options) => {
      mounted = originalCreateRoot(container, options);
      return mounted;
    },
  );
  try {
    await act(async () => {
      await import("../src/main");
    });
    expect(
      await screen.findByText("Extensible command-line toolbox."),
    ).toBeDefined();
  } finally {
    try {
      await act(() => mounted?.unmount());
    } finally {
      createRoot.mockRestore();
    }
  }
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
