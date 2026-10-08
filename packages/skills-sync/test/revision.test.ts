import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vite-plus/test";
import { verifyLibraryRevision } from "../src/library.js";

for (const scenario of ["current", "wrong-head", "moved-remote", "dirty-source", "dirty-template"])
  test(`pinned rollout ${scenario} verifies local and remote source before any instruction write`, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-revision-"));
    const origin = path.join(base, "origin"),
      root = path.join(base, "library"),
      home = path.join(base, "home");
    const write = (file: string, body: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    };
    const git = (dir: string, ...args: string[]) => {
      const result = spawnSync(
        "git",
        [
          "-c",
          "core.autocrlf=false",
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "-C",
          dir,
          ...args,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    try {
      fs.mkdirSync(origin);
      git(origin, "init", "-q", "-b", "main");
      write(path.join(origin, "skills-sync.json"), JSON.stringify({ version: 1, generate: { plugins: false } }));
      write(
        path.join(origin, "skills", "oneezy", "oneezy-brain", "SKILL.md"),
        "---\nname: oneezy-brain\ndescription: Brain\n---\nCurrent Brain\n",
      );
      write(path.join(origin, "routing.md"), "Load the current Drive Brain.");
      write(
        path.join(origin, "skills-sync.entrypoints.json"),
        JSON.stringify({
          version: 1,
          blocks: { brain: { source: "routing.md", skill: "oneezy-brain", agents: ["codex"] } },
        }),
      );
      git(origin, "add", ".");
      git(origin, "commit", "-q", "-m", "fixture");
      git(base, "clone", "-q", origin, root);
      const head = git(root, "rev-parse", "HEAD");
      let expected = head;
      if (scenario === "wrong-head") expected = "0".repeat(40);
      if (scenario === "moved-remote") {
        write(path.join(origin, "README.md"), "New remote revision");
        git(origin, "add", ".");
        git(origin, "commit", "-q", "-m", "remote moved");
      }
      if (scenario === "dirty-source")
        write(path.join(root, "skills", "oneezy", "oneezy-brain", "SKILL.md"), "Unreviewed local edit");
      if (scenario === "dirty-template") write(path.join(root, "routing.md"), "Unreviewed template edit");
      assert.equal(verifyLibraryRevision(root, expected) === null, scenario === "current");
      const affected = path.join(home, ".codex", "AGENTS.md");
      write(affected, "Preserve instructions\r\n");
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: path.join(home, ".codex"),
        CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      };
      const cli = path.resolve(import.meta.dirname, "../dist/src/cli.js");
      for (const extra of [["--plan"], []]) {
        const result = spawnSync(
          process.execPath,
          [
            cli,
            "--repo",
            root,
            "--expect-revision",
            expected,
            "--remote-ref",
            "refs/heads/main",
            "--agents",
            "codex",
            "--links",
            "--global",
            "--no-projects",
            "--no-wsl",
            "--no-pull",
            "--no-restore",
            "--no-layers",
            "--no-remember",
            "--json",
            "-y",
            ...extra,
          ],
          { env, encoding: "utf8" },
        );
        assert.equal(result.status, scenario === "current" ? 0 : 1, result.stderr + result.stdout);
        if (scenario !== "current" || extra.length)
          assert.equal(fs.readFileSync(affected, "utf8"), "Preserve instructions\r\n");
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
