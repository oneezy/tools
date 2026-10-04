import { describe, expect, it } from "vite-plus/test";
import { formatRepo, parseRepoInput } from "./repo.ts";

// parsing itself is the engine's (and tested there); this checks the round trip the page relies on
describe("formatRepo", () => {
  it.each([
    ["mattpocock/skills", "mattpocock/skills"],
    ["https://github.com/mattpocock/skills.git", "mattpocock/skills"],
    ["git@github.com:oneezy/skills.git", "oneezy/skills"],
    ["oneezy/skills@dev", "oneezy/skills@dev"],
    ["https://github.com/a/b/tree/main/plugins/x", "github.com/a/b/tree/main/plugins/x"],
    ["https://github.com/a/b/blob/main/skills/x/SKILL.md", "github.com/a/b/tree/main/skills/x/SKILL.md"],
  ])("%s → %s", (input, want) => {
    const r = parseRepoInput(input);
    expect(r).not.toBeNull();
    expect(formatRepo(r!)).toBe(want);
    expect(parseRepoInput(want)).toEqual(r!.refPath ? { ...r, refPath: r!.refPath } : r);
  });

  it.each(["", "skills", "https://gitlab.com/a/b", "a b/c", "../etc"])("rejects %j", (input) => {
    expect(parseRepoInput(input)).toBeNull();
  });
});
