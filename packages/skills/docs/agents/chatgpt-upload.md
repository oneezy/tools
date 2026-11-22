# Updating the ChatGPT plugins

ChatGPT keeps Justin's plugins on his account, and only Plugin Creator inside a ChatGPT chat changes them: no CLI, API or CI run reaches them. After each release he types this in ChatGPT (the website or the desktop app):

```
@oneezy-skills update my ChatGPT plugins to the latest oneezy/skills release
```

**First run only.** The account's oneezy plugin predates this procedure (it was `0.39.0+d92eb6973684`; the procedure ships from 0.46.0), so the line above finds no `chatgpt-update.md` there; `status`'s `chatgpt-update` step gives this line first while that holds. Once, in its place, type:

```
@Plugin Creator update (or create, if I have none) my personal oneezy plugin to the oneezy archive in the latest github.com/oneezy/skills release (its release.json lists the files and sha256s): use update_plugin with expected_release_id, delete only files the release dropped with paths relative to the plugin root, delete nothing if under half the paths match, then read it back and report
```

Then open a new chat and type the line above. `/oneezy-skills` then follows `skills/oneezy/oneezy-skills/references/chatgpt-update.md`: it reads the latest release's `release.json`, diffs every library plugin against the account copy file by file, updates or creates each one, deletes the files the release dropped, reads every copy back and reports each plugin. The release record is the account itself, so nothing is written to `skills-sync.json`.

A PC whose Codex is signed in with ChatGPT verifies the result: Codex lists the account's plugins (`created-by-me-remote`, `workspace-*`), and `npx @oneezy/skills-sync status` shows a ChatGPT section, with a manual step carrying the line above whenever a copy is behind the latest release (oneezy/tools#196).

A business workspace can instead import `github.com/oneezy/skills` once in Admin > Plugins > Import marketplace; it then syncs daily, and Sync now syncs at once.
