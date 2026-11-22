# Capability discovery

Use current runtime discovery when a requested source is absent from the source-routing table or the user asks which relevant capabilities are available. Do not keep or publish a snapshot of another account's installed plugins, skill catalog, connection identifiers, or session history.

1. Identify the source needed for the selected meeting, project, and period. Respect the user's source exclusions.
2. Check the current host's available skills and tools. Follow catalog pagination when the host supports it; distinguish a bounded search result from a complete list.
3. Read only the selected dependency's current instructions and invocation policy. Preserve explicit-only restrictions and the user's authorization boundaries.
4. Check whether the required tool is exposed, then use a relevant read to verify source access. A repository file, installed plugin, loaded skill, exposed tool, and successful account read establish different things.
5. If the capability is missing, use the host's plugin discovery when available. Do not install, reconnect, change permissions, or run skill sync solely to prepare a meeting.
6. State the specific limit: missing skill, missing tool, explicit user invocation, required connection, denied access, or incomplete evidence. Continue with an honest coverage note when the missing source does not block the report.

Use the current host's selector for a plugin or bundled skill. A printed mention is a reference, not execution or installation. Do not assume a Page or Space automatically inherits a plugin because the plugin is installed in the account.

For this library's own skills, resolve current source under `skills/oneezy/<skill>/`. For third-party skills, read the current `skills-sync.json`, `skills-sync.lock.json`, and the selected installed or generated package rather than a static inventory. Do not silently replace a loaded skill with a different repository copy.
