import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const testsDir = path.join(root, "tests");
const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
const config = path.join(root, "vitest.config.js");

const files = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join("tests", name));

if (files.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, [
    vitest,
    "run",
    file,
    "--config",
    config,
    "--maxWorkers=1",
    "--minWorkers=1",
    "--no-file-parallelism",
  ], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env },
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`\nAll ${files.length} test files passed in isolated Node processes.`);
