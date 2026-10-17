# Shared development plugins

Status: complete behavior summary confirmed by Justin on 2026-10-17; Harness verification pending. Not an implementation spec.
Updated: 2026-10-17.

## Intended experience

Maintain one editable skills Library in the tools workspace. Participating projects expose links to that same source so an edit made through any project reaches the original files. One watcher builds shared development plugin output. Keep normal plugin names; do not add a `dev-` prefix. Initial support is Claude Code and Codex on the local Windows host. Cloud delivery, other hosts, distribution destinations and release automation remain separate work.

## Confirmed choices

From the first grill-with-docs round:

1. The launcher may be available globally, but development Plugins activate only in projects explicitly opted in through setup. Other projects retain released Plugins.
2. The watcher is tied to its terminal. Closing that terminal stops the watcher. Do not introduce a detached background service or automatic Windows startup now.
3. A failed build leaves the last successful build available and reports that the newest edit has not taken effect. Do not distribute partial output or silently fall back to a marketplace version on build failure.
4. Stopping the watcher retains the last development build in opted-in projects until development mode is explicitly switched off. Report the stopped watcher clearly.
5. Development and release have separate generated outputs, with one editable source. The development watcher updates only development plugin output; generating release packages must not redirect development projects or introduce duplicate active Plugins. Confirmed in Q6 after clarifying the meaning of build. Harness-specific cache behavior still requires verification.
6. Matching marketplace Plugins remain installed but are deactivated only in opted-in local projects while their development replacements are active. Do not change account-wide plugin enablement or other projects. ChatGPT.com, Claude.ai and cloud-hosted projects continue using their installed/account-provided Plugins, even when they use the same repository. Development overrides and machine-specific paths must not propagate into the cloud checkout. The mechanism and plugin-management UI behavior require runtime verification.
7. Project installation determines plugin selection; do not automatically activate every Plugin in the shared Library. A Project plugin wins over its matching marketplace copy, which must not appear as a competing active choice in that project. External Plugins without a matching Project plugin remain available. This is project-local precedence, not a marketplace uninstall. Exact identity matching and discovery behavior must be verified per Harness.
8. One watcher serves the shared Library. The first terminal starts and owns it; subsequent project launches reuse it and identify its owner. Closing the owning terminal stops rebuilding for all participating projects, which retain their last successful development output. Do not silently transfer ownership or start a detached replacement.
9. Explicit reload or a fresh chat is acceptable when a Harness requires it. Automate supported refresh behavior and otherwise report reload required. Do not automatically restart or interrupt conversations.
10. Build and validate a Project plugin before activating its override. If its first build fails and no successful development output exists, report the failure and leave the project's existing plugin configuration unchanged. Later failures during active development retain the last successful development build.

## Constraints and evidence to verify

- Editing paths can share one source through links; that does not establish that every Harness can load plugin output directly without a cache copy.
- Claude documents session-local `--plugin-dir` loading, same-name replacement and `/reload-plugins`. Verify the installed Windows runtime with whole-plugin links, source edits and return to released behavior. [Claude loading](https://code.claude.com/docs/en/plugins/loading), [development guide](https://code.claude.com/docs/en/plugins/create).
- Codex documents copying local-marketplace Plugins into its installation cache. Verify cache refresh, Desktop restart requirements, same-name selection, and the scope of local enablement controls. Workspace-managed Plugins have different controls; project configuration alone does not prove account-plugin suppression. [OpenAI plugin guide](https://developers.openai.com/plugins/build/plugins).
- Existing `develop` behavior installs loose-skill links and writes project Codex exclusions; it is not proof of development-plugin replacement.
- Consult Vercel's Skills CLI for harness installation conventions, and verify plugin behavior against each Harness's own documentation and installed runtime.

These are documented mechanisms and outstanding test requirements, not successful runtime tests of the proposed design.

## Verification still required

- Source editing through a project link reaches the original Library; changes trigger one rebuild even with multiple participating projects.
- Whole-plugin Windows links, local loading and same-name precedence in Claude Code, including account-delivered copies.
- Codex Desktop local-plugin installation, installation-cache refresh, same-name precedence and project-scoped control of the plugin origins actually installed on this machine.
- Required reload interaction after edits, additions and removals, in both fresh and existing chats. Distinguish source bytes, generated output, installed cache and the chat's loaded instructions.
- Only one competing plugin is active and offered for invocation in a development project. Determine what remains visible as inactive in plugin management; do not assume that UI hides installed copies.
- A second, non-opted-in project retains its released version. Account/cloud plugin selection is unchanged.
- First-build failure leaves existing selection intact; later build failure retains valid development output. Release generation does not redirect or overwrite development output.
- Project configuration merges and cleanup preserve unrelated settings and later manual changes. Explicit switch-off restores the previous selection.
- Additional launches reuse the watcher; closing its owning terminal stops it without a detached replacement. Stopped status is visible and the last successful output remains available.

Do not promise one physical plugin copy or instantaneous chat refresh where a Harness does not support it. If supported loading/configuration mechanisms cannot satisfy project isolation and single-active-copy behavior, return to the design interview rather than replacing caches or changing account settings to force it.

## Existing decisions to reconcile

The imported Library ADR-0007 prescribes release/account installations and no local Library; ADR-0012 rejects local settings storage. Explicit development mode may need a narrow exception or replacement decision. Do not silently rewrite the historical ADRs or treat this unfinished design as accepted architecture.

Repository tracker and domain-documentation setup already exist. Research results belong in cited notes. Justin chose to-spec followed by to-tickets: capture confirmed behavior in the spec with explicit compatibility and migration gates, then review the ticket breakdown before publishing child tickets. Do not create a separate investigation-ticket hierarchy by default.
