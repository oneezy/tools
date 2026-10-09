# Automatic Claude cache updates

When a library revision changes, the existing Skills sync workflow must update already-installed Claude plugins through `claude plugin update <id> --scope user`. Native `plugin install` is a no-op for an installed cached plugin. New plugins still use install; Codex retains its native add behavior and in-place Claude plugins keep their fast path.

Verify the resulting enabled plugin matches the current built version/source and resolves a skill before removing owned loose links. Failed commands, unsupported update commands, disabled results and successful responses that leave a stale version must retain loose links and report a concrete conflict. Preserve original command, exit code, stdout and stderr for command failures. Independently eligible plugins and harnesses continue. Verify Brain's exact cache files before updating its managed instructions.

Use command-help capability negotiation, preserve foreign marketplaces, disabled installations, newer-version guards, dirty author checkouts and pinned sources. Plan is read-only; a repeat after success performs no update, installation or instruction changes. Cover stale-cache upgrades, failure and repeat behavior with regression tests and genuine native CLI checks on Windows and WSL using isolated profiles.

This is a held development repair from current dev `377a2d7382b723582ef5f430b93ab952db2d2170`. Preserve published release-16 evidence. Prepare a reviewable PR; do not merge, promote, publish, log in, change credentials, upload cloud plugins or change schedules.
