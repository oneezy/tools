#!/usr/bin/env node
// Runs the host's Python 3 with the given arguments: `py -3` on Windows (the Store
// `python3` is a stub there), `python3` elsewhere, `python` as the last resort.
// Package scripts use it so `pnpm test` is not tied to one platform's launcher.
import { spawnSync } from "node:child_process";

const candidates = process.platform === "win32"
  ? [["py", ["-3"]], ["python", []]]
  : [["python3", []], ["python", []]];

for (const [command, prefix] of candidates) {
  const result = spawnSync(command, [...prefix, ...process.argv.slice(2)], { stdio: "inherit" });
  if (result.error?.code === "ENOENT") continue;
  process.exit(result.status ?? 1);
}
console.error(`python.mjs: no Python 3 interpreter found (tried ${candidates.map(([c]) => c).join(", ")})`);
process.exit(127);
