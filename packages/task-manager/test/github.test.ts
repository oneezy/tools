import { describe, expect, it } from "vite-plus/test";
import {
  authenticate,
  GitHub,
  GitHubError,
  optional,
} from "../../skills/skills/oneezy/oneezy-task-manager/scripts/github.ts";
import { optionsWithIds } from "../../skills/skills/oneezy/oneezy-task-manager/scripts/project.ts";

describe("auth and transport", () => {
  it("uses explicit tokens without invoking gh or switching accounts", async () => {
    const env = { GH_TOKEN: "chosen-token", GITHUB_TOKEN: "other" };
    const token = await authenticate(
      "organization",
      env,
      async () => {
        throw new Error("must not invoke gh");
      },
      async (_url, options) => {
        expect(options?.headers).toMatchObject({ Authorization: "Bearer chosen-token" });
        return Response.json({ login: "authorized-user" });
      },
    );
    expect(token).toBe("chosen-token");
    expect(env.GH_TOKEN).toBe("chosen-token");
  });
  it("rejects gh falling back to a different local user", async () => {
    await expect(
      authenticate(
        "acme",
        {},
        async (file, args) => {
          expect([file, ...args]).toEqual(["gh", "auth", "token", "--user", "acme"]);
          return "secret";
        },
        async () => Response.json({ login: "someone-else" }),
      ),
    ).rejects.toThrow("another account");
  });
  it("read-only transport refuses all mutations before any request", async () => {
    let requests = 0;
    const api = new GitHub("secret", true, async () => {
      requests++;
      return Response.json({ data: {} });
    });
    await expect(api.rest("POST", "repos/acme/widgets/issues", {})).rejects.toThrow("Read-only");
    await expect(api.graphql("mutation { anything }")).rejects.toThrow("Read-only");
    await expect(api.rest("GET", "graphql")).rejects.toThrow("REST endpoint");
    expect(requests).toBe(0);
    await api.graphql("query { viewer { login } }");
    expect(requests).toBe(1);
  });
  it("paginates REST collections and fails on GraphQL partial errors", async () => {
    const paths: string[] = [];
    const api = new GitHub("secret", true, async (url) => {
      const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      paths.push(address);
      return address.includes("&page=2")
        ? Response.json([100])
        : Response.json(
            Array.from({ length: 100 }, (_, n) => n),
            {
              headers: {
                link: '<https://api.github.com/repos/acme/widgets/issues?state=all&per_page=100&page=2>; rel="next"',
              },
            },
          );
    });
    expect((await api.pages("repos/acme/widgets/issues?state=all")).length).toBe(101);
    expect(paths[1]).toContain("&page=2");
    const errorApi = new GitHub("secret", false, async () =>
      Response.json({ data: {}, errors: [{ message: "denied" }] }),
    );
    await expect(errorApi.graphql("query { viewer { login } }")).rejects.toThrow("denied");
  });
  it("only treats 404 as optional; permission/network errors are not absence", async () => {
    await expect(
      optional(async () => {
        throw new GitHubError("missing", 404);
      }),
    ).resolves.toBeUndefined();
    await expect(
      optional(async () => {
        throw new GitHubError("forbidden", 403);
      }),
    ).rejects.toThrow("forbidden");
    await expect(
      optional(async () => {
        throw new Error("network");
      }),
    ).rejects.toThrow("network");
  });
  it("keeps existing option IDs by name when repairing order", () => {
    expect(
      optionsWithIds(
        {
          id: "F",
          name: "Status",
          dataType: "SINGLE_SELECT",
          options: [{ id: "done-id", name: "Done", color: "GRAY", description: "" }],
        },
        [
          { name: "Todo", color: "GRAY", description: "" },
          { name: "Done", color: "GREEN", description: "merged" },
        ],
      ),
    ).toEqual([
      { name: "Todo", color: "GRAY", description: "" },
      { id: "done-id", name: "Done", color: "GREEN", description: "merged" },
    ]);
  });
});
