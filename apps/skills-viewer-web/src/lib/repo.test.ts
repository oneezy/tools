import { describe, expect, it } from "vite-plus/test";
import { formatRepo, parseRepoInput } from "./repo.ts";

describe("parseRepoInput", () => {
  it.each([
    ["mattpocock/skills", { owner: "mattpocock", repo: "skills" }],
    ["  mattpocock/skills/ ", { owner: "mattpocock", repo: "skills" }],
    ["https://github.com/mattpocock/skills", { owner: "mattpocock", repo: "skills" }],
    ["github.com/mattpocock/skills.git", { owner: "mattpocock", repo: "skills" }],
    ["git@github.com:oneezy/skills.git", { owner: "oneezy", repo: "skills" }],
    ["https://www.github.com/a/b?tab=readme#top", { owner: "a", repo: "b" }],
    ["https://github.com/a/b/tree/dev", { owner: "a", repo: "b", ref: "dev" }],
    ["https://github.com/a/b/tree/main/plugins/x", { owner: "a", repo: "b", ref: "main", subpath: "plugins/x" }],
    ["https://github.com/a/b/blob/main/skills/x/SKILL.md", { owner: "a", repo: "b", ref: "main", subpath: "skills/x" }],
  ])("%s", (input, want) => {
    expect(parseRepoInput(input)).toEqual(want);
  });

  it.each(["", "skills", "https://gitlab.com/a/b", "a b/c", "../etc/passwd", "a/b/tree/main/../../x"])("rejects %j", (input) => {
    expect(parseRepoInput(input)).toBeNull();
  });
});

describe("formatRepo", () => {
  it("round-trips", () => {
    for (const s of ["a/b", "a/b/tree/dev", "a/b/tree/main/plugins/x"]) {
      expect(formatRepo(parseRepoInput(s)!)).toBe(s);
    }
  });
});
