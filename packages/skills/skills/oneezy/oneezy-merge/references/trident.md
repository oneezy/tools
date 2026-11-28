# Trident: landing on next and the next move

In layerdbiz/tridentcubed, `next` is the integration branch, and `dev` takes all of `next` by fast-forward on Justin's word. Two sections of that repo own the rules, and they win over this file wherever the two differ:

- `AGENTS.md`, **Where work lands**: how work lands on `next`, how `dev` takes `next`, and that `main` stays untouched.
- `apps/app/AGENTS.md`, **Releases and What's New**: the `What's New:` lines, the **highlights** (`apps/app/src/lib/releases/highlights.ts`, keyed by version), and the release a push to `dev` makes.

Read both sections in the checkout before the first git call. Done when you can name the version `next` leads to and the push that moves it.

## Landing on next

Every pull request this skill lands in Trident goes into `next`, with the base, merge method and title that **Where work lands** gives; that replaces the squash of `references/modes.md` step 4. A commit that carries a `What's New:` line also updates the highlights of the version `next` leads to, in the same pull request, as **Releases and What's New** describes. Done when every `What's New:` line the PR adds is folded into those highlights, or the report names the lines that are seen only on next.app and so leave them alone.

## The next move

`into dev`, "move next to dev" and "next to dev" in Trident mean the **next move**: `dev` takes `origin/next` by fast-forward. It replaces steps 1 to 5 of `references/modes.md`. Justin's message that started the skill is the move's yes, unless step 3 hands the highlights back to him.

1. **Land this session's own work on `next` first**, if it has any, as in Landing on next. Done when `origin/next` contains it.
2. **Dry-run the release**, one shell call: `git fetch origin next dev --tags`, then `node apps/app/scripts/release.ts --branch dev --head origin/next --dry-run`, which prints the version on its first line and then its highlights, and `git log v<newest release>..origin/next` (the newest `v*` tag without `-next`), whose `What's New:` lines are the work to tell. Done when each `What's New:` line is marked told (the printed highlights carry it) or missing, or the dry run says the version has no highlights.
3. **Highlights missing or a line missing**: write or refresh them on a branch cut from `origin/next` and land it as in Landing on next. Tell Justin, in one line, to read Coming to dev on next.app, give him the line that starts the move again in a code block (`/oneezy-merge into dev`), and stop. His next yes in this session is the yes; then start again at step 2.
4. **Move**, one shell call: when `git rev-list --count origin/next..origin/dev` is above 0, merge `origin/dev` into `next` and push `next`. Then `git push origin origin/next:dev`. Done when `origin/dev` and `origin/next` name the same commit.
5. **Wait** for the checks on `dev`'s new head as in `references/modes.md` step 3; the release workflow is among them. Keep the tag and the GitHub release it made for the report.
6. **Report**: run `/oneezy-status`. The Git line names the fast-forward of `dev` to its commit, the tag and GitHub release, and that Coming to dev on next.app now waits for the version after it.

Budget: at most six calls before the report, besides the landing calls of steps 1 and 3, each wait loop counting as one.
