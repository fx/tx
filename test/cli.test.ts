import { expect, test } from "bun:test";

import { main } from "../src/cli.ts";

test("main completes without side effects", async () => {
  await expect(main([])).resolves.toBeUndefined();
});

test("the CLI entrypoint starts successfully", () => {
  const result = Bun.spawnSync([process.execPath, "run", "src/cli.ts"], {
    cwd: `${import.meta.dir}/..`,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("");
});
