// node --test .github/scripts/: land.yml's Git steps, read out of the workflow file and run with bash the way the
// runner runs a step (bash --noprofile --norc -eo pipefail), against a clone of dev whose origin is a bare repository on
// disk and a fake `gh` that records its calls. This is the Git merge and promotion half of the library's automation:
// squash land/<topic> onto dev, merge dev into main, ask library.yml for the release, delete the branch. Publication
// is not here: land.yml only dispatches library.yml's release job, which builds the archives and cuts the GitHub
// release (release.test.mjs and tests/release-chain.test.mjs cover that record). The check step (the published tool
// against the tree) needs npm and the network, so it is not run here; run.test.mjs checks that run.sh runs it first.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { branches, fakeGh, findBash, git, remote, tags, write } from "./dry-run.mjs";

const WORKFLOWS = fileURLToPath(new URL("../workflows/", import.meta.url));
const BASH = findBash();
const skip = BASH ? false : "bash is not available (land.yml runs on the ubuntu runner)";

/** The steps of a workflow file: name, if, working-directory and run, read by indentation (no YAML library needed). */
function steps(file) {
  // a Windows checkout may carry CRLF; the runner gets LF
  const lines = fs.readFileSync(path.join(WORKFLOWS, file), "utf8").split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)- name: (.+)$/.exec(lines[i]);
    if (!m) continue;
    const step = { name: m[2].trim() };
    const keyIndent = m[1].length + 2;
    for (i++; i < lines.length; i++) {
      const line = lines[i];
      const indent = line.length - line.trimStart().length;
      if (line.trim() && indent < keyIndent) break;
      if (/^\s*- name: /.test(line) && indent === m[1].length) break;
      const kv = /^\s*(if|working-directory|run|uses): ?(.*)$/.exec(line);
      if (!kv || indent !== keyIndent) continue;
      if (kv[1] === "run" && kv[2].trim() === "|") {
        const body = [];
        for (i++; i < lines.length && (!lines[i].trim() || lines[i].length - lines[i].trimStart().length > keyIndent); i++)
          body.push(lines[i].slice(keyIndent + 2));
        i--;
        step.run = body.join("\n").trimEnd() + "\n";
      } else step[kv[1]] = kv[2].trim();
    }
    i--;
    out.push(step);
  }
  return out;
}

/**
 * The land job on a pushed branch, as the runner would take it: each step in order while every earlier one succeeded,
 * a step whose `if` reads steps.squash.outputs.empty skipped when the squash found nothing to land, the steps that need
 * npm and the network (the tool install and the check) taken as passed.
 */
function land(r, branch) {
  const gh = fakeGh(r.base);
  const output = path.join(r.base, "squash-output");
  const temp = path.join(r.base, "runner-temp");
  fs.mkdirSync(temp, { recursive: true });
  fs.writeFileSync(output, "");
  const ran = [];
  let failed = null;
  for (const step of steps("land.yml")) {
    if (step.name.startsWith("Check out")) continue; // remote() already cloned dev into library/, full history
    const empty = /empty=true/.test(fs.readFileSync(output, "utf8"));
    if (step.if?.includes("steps.squash.outputs.empty != 'true'") && empty) continue;
    if (!step.run) continue; // the composite tool install
    if (/node "\$CLI"/.test(step.run)) continue; // the check: the published tool, from npm
    const res = spawnSync(BASH, ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
      cwd: step["working-directory"] ? path.join(r.base, step["working-directory"]) : r.base,
      encoding: "utf8",
      env: { ...process.env, PATH: `${gh.bin}${path.delimiter}${process.env.PATH}`, BRANCH: branch, GH_TOKEN: "fake", GH_REPO: "oneezy/skills", GITHUB_OUTPUT: output, RUNNER_TEMP: temp },
    });
    ran.push(step.name);
    if (res.status !== 0) {
      failed = { step: step.name, stdout: res.stdout, stderr: res.stderr };
      break;
    }
  }
  return { ran, failed, gh: gh.calls(), output: fs.readFileSync(output, "utf8") };
}

/** A remote with a land/<topic> branch pushed from dev, changing `files`, its tip message `message`. */
function pushed(topic, files, message = "✨ feat(oneezy): add a skill") {
  const r = remote({ "skills-sync.json": "{}\n", "skills/oneezy/a/SKILL.md": "a\n", ".github/workflows/land.yml": "name: land\n" });
  const work = path.join(r.base, "work");
  git(r.base, "clone", "-q", "-b", "dev", r.origin, "work");
  git(work, "checkout", "-q", "-b", `land/${topic}`);
  write(work, files);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "wip");
  write(work, { "skills/oneezy/a/notes.md": "second commit\n" });
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", message);
  git(work, "push", "-q", "origin", `land/${topic}`);
  return r;
}

test("the step list is the one this test drives: checkout, squash, the published tool, the check, push dev and promote main, the release dispatch, the branch delete", () => {
  assert.deepEqual(
    steps("land.yml").map((s) => s.name),
    ["Check out dev", "Squash the branch onto dev", "Install the latest published @oneezy/skills-sync", "Check the result (as library.yml check does)", "Push dev, promote main", "Start the release on main", "Delete the branch"],
  );
});

test("a land branch: one squash commit on dev with the tip's message, dev merged into main with a merge commit, library.yml's release dispatched on main, the branch deleted, no tag", { skip }, () => {
  const r = pushed("add-skill", { "skills/oneezy/b/SKILL.md": "b\n" });
  const devBefore = r.ref("dev");
  const mainBefore = r.ref("main");
  const res = land(r, "land/add-skill");
  assert.equal(res.failed, null, JSON.stringify(res.failed));
  const dev = r.ref("dev");
  const main = r.ref("main");
  assert.equal(git(r.origin, "rev-parse", "dev^"), devBefore, "one commit on dev");
  assert.equal(git(r.origin, "log", "-1", "--format=%B", "dev"), "✨ feat(oneezy): add a skill\n\nLanded from land/add-skill by the land workflow.");
  assert.deepEqual(git(r.origin, "diff", "--name-only", devBefore, dev).split("\n"), ["skills/oneezy/a/notes.md", "skills/oneezy/b/SKILL.md"]);
  assert.deepEqual(git(r.origin, "rev-list", "--parents", "-n", "1", main).split(" ").slice(1), [mainBefore, dev], "main merges dev, dev stays its ancestor");
  assert.equal(git(r.origin, "log", "-1", "--format=%s", "main"), "release: promote dev to main (land/add-skill)");
  assert.deepEqual(res.gh, ["workflow run library.yml --ref main -f job=release"], "the release is library.yml's, asked for, not cut here");
  assert.deepEqual(branches(r.origin), ["dev", "main"]);
  assert.deepEqual(tags(r.origin), []);
});

test("a branch that changes .github/ is refused at the squash: dev, main and the branch stay, nothing is dispatched", { skip }, () => {
  const r = pushed("workflow", { ".github/workflows/land.yml": "name: changed\n" });
  const before = [r.ref("dev"), r.ref("main")];
  const res = land(r, "land/workflow");
  assert.equal(res.failed?.step, "Squash the branch onto dev");
  assert.match(res.failed.stdout, /::error title=land refused::land\/workflow changes \.github\//);
  assert.deepEqual([r.ref("dev"), r.ref("main")], before);
  assert.deepEqual(branches(r.origin), ["dev", "land/workflow", "main"]);
  assert.deepEqual(res.gh, []);
});

test("a branch that changes nothing on dev lands nothing: no push, no dispatch, the branch deleted", { skip }, () => {
  const r = remote({ "skills-sync.json": "{}\n" });
  git(r.library, "push", "-q", "origin", "dev:refs/heads/land/empty");
  const before = [r.ref("dev"), r.ref("main")];
  const res = land(r, "land/empty");
  assert.equal(res.failed, null, JSON.stringify(res.failed));
  assert.match(res.output, /empty=true/);
  assert.deepEqual(res.ran, ["Squash the branch onto dev", "Delete the branch"]);
  assert.deepEqual([r.ref("dev"), r.ref("main")], before);
  assert.deepEqual(res.gh, []);
  assert.deepEqual(branches(r.origin), ["dev", "main"]);
});
