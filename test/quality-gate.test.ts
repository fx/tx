import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("the required CI gate runs the same complete local check", async () => {
  const pkg = await Bun.file(join(root, "package.json")).json();
  expect(pkg.scripts.check).toContain("bun run --cwd site test");
  expect(pkg.scripts.check).toContain("bun run --cwd site build");

  const workflow = Bun.YAML.parse(
    await Bun.file(join(root, ".github/workflows/ci.yml")).text(),
  ) as {
    jobs: {
      ci: {
        steps: Array<{
          run?: string;
          "working-directory"?: string;
          if?: string;
        }>;
      };
    };
  };
  const steps = workflow.jobs.ci.steps;
  expect(
    steps.some(
      (step) =>
        step["working-directory"] === "site" &&
        step.run === "bun install --frozen-lockfile" &&
        step.if?.includes("documentation_only"),
    ),
  ).toBe(true);
  expect(
    steps.some(
      (step) =>
        step.run === "bun run check" && step.if?.includes("documentation_only"),
    ),
  ).toBe(true);
});
