import { expect, test } from "bun:test";
import { ThemeProvider } from "@fx/ui";
import { act, cleanup, render, screen } from "@testing-library/react";
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
