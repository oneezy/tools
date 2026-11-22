# 📋 spec: Develop shared plugins safely across projects

Product behavior and test boundaries confirmed on 2026-10-17. Harness compatibility remains an explicit verification gate.

## Problem Statement

Justin's skills Library has been copied into the tools monorepo and is usable through local loose-skill links. He now wants to develop real Plugins, retaining their normal names, from any participating project while editing one shared source. Marketplace installations must remain available elsewhere, and local development must not change cloud behavior.

The current watcher reconciles loose-skill links; it does not provide watched development-plugin builds, project-scoped plugin replacement, or verified reload behavior across Claude Code and Codex Desktop. An updated file, a successful build, an installed Plugin and an updated conversation are different states that the current development experience must not conflate.

The imported Library also contains workflows, scripts, tests and documentation from its former standalone repository. Some skill instructions still target the old repository's workflows. Deleting apparent duplicates or moving promotion workflows into the monorepo unchanged could lose behavior or broaden a release to unrelated tools.

## Solution

Extend Skills Sync with project-scoped development Plugins backed by one editable Library and shared development output. A globally available launcher lets a participating project access the same source through links and start or reuse one terminal-owned watcher. Project-installed Plugins take precedence over matching marketplace Plugins only in that local project. Unrelated external Plugins remain available.

Keep development output separate from release packages. Preserve the last successful development build on failures or watcher shutdown, and clearly report when a Harness needs a reload or fresh chat. Switching development mode off restores the project's prior selection without uninstalling marketplace Plugins or overwriting unrelated settings.

Reconcile the imported automation through a preservation-first migration: trace its consumers, retain useful behavior and tests, adapt or consolidate verified replacements, and remove leftovers only after their dependencies are accounted for. This spec does not authorize a change to production promotion policy or choose a new distribution repository implicitly.

## User Stories

1. As a skill author, I want one editable Library, so that I never have to reconcile competing source copies.
2. As a developer, I want to open that Library through a link in another project, so that I can edit skills without switching editor workspaces.
3. As a developer, I want edits through any participating project to reach the original source, so that every participating project uses the same work.
4. As a developer, I want a development launcher available from any local project, so that I do not need to navigate back to the tools checkout to start it.
5. As a developer, I want project setup to be explicit, so that installing the launcher does not activate development Plugins everywhere.
6. As a developer, I want the project's installed Plugins to determine its selection, so that setup does not activate the whole Library automatically.
7. As a developer, I want normal Plugin names during development, so that commands and skill references do not require development-only prefixes.
8. As a developer, I want a Project plugin to replace its matching marketplace copy in that project, so that only one competing version can be selected and run.
9. As a developer, I want marketplace Plugins to remain installed, so that other projects and a later switch back can keep using them.
10. As a developer, I want external Plugins without a matching Project plugin to remain available, so that development does not disable unrelated capabilities.
11. As a cloud user, I want ChatGPT.com, Claude.ai and cloud-hosted projects to retain their normal installed Plugins, so that local development settings do not affect cloud work.
12. As a developer, I want one watcher per shared Library, so that opening several projects does not create competing rebuild processes.
13. As a developer, I want the first terminal to visibly own the watcher, so that I know where it runs and how to stop it.
14. As a developer, I want later launches to reuse the existing watcher and identify its owner, so that its lifetime is predictable.
15. As a developer, I want closing the owning terminal to stop the watcher, so that no unnoticed background service continues running.
16. As a developer, I want watcher shutdown to retain the last successful development output, so that stopping rebuilds does not silently switch plugin versions.
17. As a developer, I want to see that the watcher is stopped, so that I know subsequent edits have not been built.
18. As a skill author, I want changed content to rebuild only affected development output, so that saves stay efficient.
19. As a skill author, I want identical saves to do no work, so that the watcher does not repeatedly rebuild unchanged content.
20. As a skill author, I want additions, renames, removals and supporting-file edits reflected in development output, so that structural changes behave consistently with content edits.
21. As a developer, I want generated output excluded from source watching, so that a build cannot trigger itself indefinitely.
22. As a developer, I want a replacement built and validated before activation, so that a failed first build leaves the existing project configuration intact.
23. As a developer, I want later build failures to retain the last successful build, so that invalid edits do not distribute partial Plugins.
24. As a developer, I want a clear build failure report without silent marketplace fallback, so that I know which version is actually available.
25. As a developer, I want supported reload behavior automated and unsupported reloads explained, so that I can refresh a Plugin without guessing.
26. As a developer, I want conversations left running unless I choose to reload or restart them, so that development does not interrupt active work.
27. As a developer, I want installation status distinguished from actual loaded-plugin status, so that a successful filesystem change is not misreported as successful chat refresh.
28. As a maintainer, I want release generation separate from development output, so that preparing a release neither redirects development projects nor introduces duplicate active Plugins.
29. As a developer, I want explicit switch-off to restore the previous project selection, so that experimentation is reversible.
30. As a developer, I want setup and switch-off to preserve unrelated files, settings and later manual edits, so that participating projects remain under my control.
31. As a developer, I want incompatible configuration or unsupported Harness behavior reported before activation, so that the tool does not force an unsafe replacement.
32. As a maintainer, I want ordinary Skills Sync operations to respect active development projects, so that normal synchronization does not reintroduce competing released copies.
33. As a maintainer, I want every copied workflow and script traced to its callers, so that migration does not remove a dependency mistaken for a duplicate.
34. As a user of Oneezy merge and release skills, I want their intended merge, promotion and publication behavior preserved and tested separately, so that a successful merge is not mistaken for a successful Plugin release.
35. As a maintainer, I want imported tests retained and included in relevant validation, so that moving automation does not silently reduce coverage.
36. As a maintainer, I want historical decisions explicitly reconciled with development mode, so that future agents understand the exception instead of restoring outdated behavior.
37. As a maintainer, I want Harness adapters informed by Vercel's Skills CLI and verified against primary Harness documentation and runtime behavior, so that familiar installation conventions are reused without assuming loose-skill support proves Plugin support.

## Implementation Decisions

### Confirmed behavior and ownership

- The Library remains a permanent workspace package. All authoring links resolve to that source. Generated output and Harness installation caches are not authoring locations.
- Skills Sync owns project setup, source-link reconciliation, watched development packaging, Harness integration, status and reversal. Reuse its existing Library, build, plan/apply and Harness-driver boundaries where they fit.
- Global availability describes launcher availability for the local user; it does not mean global activation of development Plugins. Only explicitly participating projects change behavior.
- Project Plugin selection is authoritative locally. Disable or shadow only the corresponding released copy within that project. Do not automatically activate every configured Library Plugin or disable unrelated capabilities.
- Keep normal Plugin identities. Determine exact matching through verified Harness identity rules, not approximate display-name matching.
- Claude Code and Codex are the initial supported Harnesses on Windows. Codex Desktop must be validated independently of standalone CLI success.
- One watcher builds development output for the shared Library. It is owned by its first terminal, reused by later launches, and stops with its owning terminal. No implicit ownership transfer, detached replacement or startup service.
- Stopping the watcher leaves successful output and project selection in place. Restarting the watcher reconciles source changes made while it was stopped.
- Debounce filesystem events, compare inputs, rebuild affected Plugins and skip unchanged output. Watch the canonical source so edits through any alias are observed. Do not watch generated destinations as inputs.
- Validate replacement output before exposing it. An unsuccessful first build leaves existing project configuration unchanged. Later failures retain the last successful development build and report stale output.
- Development and release packaging have separate destinations and activation behavior. Release generation does not overwrite or activate development output; development does not publish releases or change marketplace versions.
- Source editing, generation, installation, loading and invocation must have distinguishable status. Use supported refresh mechanisms; otherwise request reload or a fresh chat without interrupting conversations.
- Keep enough ownership and previous-state information to reverse project changes. Merge only owned configuration entries, verify the state before reversal and preserve unrelated or subsequently edited values. The precise storage format is not yet selected.
- Normal machine synchronization must respect development selection while retaining released behavior elsewhere. Project configuration and machine-specific links must not be committed in a form that changes cloud sessions.

### Import and automation preservation

- Inventory imported workflows, actions, scripts, tests, configuration, skill instructions and documentation, and trace their inbound and outbound dependencies before deciding their disposition.
- Classify each candidate as retained, relocated with adaptations, consolidated, or removable after replacement verification. Similar names alone do not establish duplicate behavior.
- Keep executable helper logic with its owning package when appropriate. Activate repository workflows only through an explicit, tested migration; do not mechanically move all imported automation to the repository root.
- Preserve the distinction between Git merge/promotion and Plugin publication. Do not broaden old standalone-library promotion rules to the entire monorepo.
- Retain release and command-report tests and connect them to the relevant workspace validation before removing their old location.
- Reconcile the imported ADRs on release-only installation and centralized settings with the approved local development exception. Preserve their historical rationale rather than silently rewriting it.
- The distribution destination and eventual release-command design remain unresolved. Any migration depending on them is blocked on that decision; the existing release route remains in place meanwhile.

### Compatibility gates, not assumed decisions

- Prove whole-plugin link loading, same-name precedence and reload behavior in the installed Claude Code runtime.
- Prove Codex Desktop local Plugin installation, cache refresh, project-scoped precedence and the effect of actual marketplace/account origins. Current project exclusion entries and loose-skill installation are not sufficient evidence.
- One editable source does not imply one physical copy inside every Harness. Determine supported installation-cache behavior experimentally; all editable project aliases must still resolve to the source.
- An inactive installed entry may remain visible in plugin-management UI. Verify and report that behavior; acceptance requires no competing active/invocable duplicate. If the requested project-only suppression cannot be achieved through supported controls, return to the user before implementing a substitute.
- Do not bypass these gates by changing account settings, modifying Harness caches through unsupported mechanisms, renaming Plugins or silently leaving duplicate versions active.
- Command spelling and alias locations remain implementation details to settle consistently with the existing development commands; this spec does not claim that the proposed global flags already exist.

## Testing Decisions

Confirmed test boundaries:

1. **Primary automated boundary: the Skills Sync command and its observable result.** Extend the existing temporary-machine fixture and run the built CLI with a shared Library, an opted-in project, a second opted-in project, a normal project, temporary user homes and controlled Harness executables. Assert real file/link targets, generated content, configuration preservation, process lifetime, reported status and exit codes. Avoid tests that merely mirror internal helper calls.
2. **Real-Harness acceptance boundary: Plugin discovery and invocation in a project.** Verify Claude Code and Codex Desktop separately with a harmless Play Plugin. Demonstrate source edit through a project alias, successful development build, necessary reload and changed skill behavior. Compare a participating project with a normal project and verify that account/cloud configuration remains unchanged. Fake Harness results cannot satisfy this boundary.
3. **Migration compatibility at existing packaging and automation entrypoints.** Reuse artifact-generation tests, the imported release-record and command-report tests, capability-preservation tests, and existing workflow validation. Verify the caller-to-command-to-artifact chain against isolated repositories or dry-run fixtures before any production workflow activation. No real promotion or publication is part of testing by default.

Required scenarios:

- Editing the same source through either participating project produces equivalent output, with one watcher and no duplicate processing from alias paths.
- Identical saves and generated-file writes cause no rebuild; changed content and structural edits update the affected output.
- The owning terminal's exit stops the watcher; later project terminals do not keep it alive secretly. Last successful output stays usable and stopped status is clear. Restart catches up on changes.
- First-build failure leaves existing Plugin selection intact. Later failure preserves prior valid output. Recovery publishes only complete validated output.
- A Project plugin wins over its matching marketplace copy, while unrelated external Plugins remain available and a non-participating project still uses the released version.
- Normal synchronization and release packaging do not override active development selection.
- Explicit switch-off restores prior selection while preserving installed marketplace copies, unrelated settings, source files and subsequent manual edits. Repeated setup and switch-off are idempotent.
- Unsupported configuration, ambiguous plugin identity or an unachievable project override reports a conflict instead of applying a partial change.
- Release migration preserves required helpers, tests and consumers and does not introduce unapproved automatic promotion or a second release publisher.

Prior art includes the existing development-install tests for links, conflicts and idempotence; filesystem watcher tests for unchanged saves and structural changes; the temporary-machine CLI fixture with fake Harnesses and GitHub; artifact isolation tests; and the imported release/report tests. These are reusable testing facilities, not proof that the new Plugin behavior already works.

## Out of Scope

- Cloud development links, syncing unreleased local edits to cloud hosts, and changing ChatGPT.com or Claude.ai account Plugin enablement.
- Other Harnesses, WSL, remote hosts and Linux runtime support in this first delivery; retain portable script conventions rather than introducing avoidable Windows-only package scripts.
- Detached services, Windows startup integration, automatic watcher ownership transfer or forced chat restarts.
- Development-only Plugin name prefixes, wholesale skill renaming and the Oneezy help menu.
- Uninstalling unrelated Plugins, replacing complete Harness settings files or treating caches as editable source.
- Selecting a distribution repository, completing release automation, or authorizing commits, pushes, merges, promotion, publication or destructive cleanup through this spec alone.
- Rebuilding the Skills Viewer or expanding its static workflow analysis; retain its working local development behavior.

## Further Notes

The product behavior was confirmed through the grill-with-docs interview on 2026-10-17. The current implementation still exposes loose skills and is not the completed Plugin workflow described here.

The initial audit found that the copied Library automation is nested and inactive in tools, while the standalone skills repository still has registered workflows. Some skill instructions explicitly dispatch those standalone workflows. The imported task-manager file is a caller of the tools implementation, and the two similarly named CLI-install actions differ. These findings require a migration plan; they do not justify deletion or activation by relocation.

Follow the requested flow: publish this spec after test-boundary confirmation, then use to-tickets to review and publish dependency-linked implementation slices. Compatibility proof and migration preservation are explicit gates in that breakdown. Do not create a separate Wayfinder detour or unrelated investigation-ticket hierarchy without agreement.

Primary references for compatibility validation:

- [Claude Plugin loading and precedence](https://code.claude.com/docs/en/plugins/loading)
- [Claude Plugin development and reload](https://code.claude.com/docs/en/plugins/create)
- [OpenAI Plugin packaging and local installation](https://developers.openai.com/plugins/build/plugins)
- [Vercel Skills CLI installation conventions](https://github.com/vercel-labs/skills)

Published documentation and local configuration can guide the design, but installed-version runtime tests must establish the supported behavior before claiming completion.
