# Capability routing

Before resolving a Oneezy dependency, read `capabilities/contract.md` and only this host’s adapter: `capabilities/chatgpt.md`, `capabilities/claude.md` or `capabilities/codex.md`. For an inventory, management action or missing source, inspect `capabilities/catalog.json` and refresh its dated evidence through current discovery.

This catalog lives in oneezy/skills. It covers Oneezy’s dependencies, not every installed account plugin. Source presence, installation, loading and successful actions are distinct. Private plugin metadata is not a public dependency lookup. The standalone Meeting and bundled Meeting deliveries have separate identities; both must be verified for a future rollout.

Edit the contract/catalog/adapters here once. `node scripts/oneezy-capabilities.mjs --write` generates packaged copies under each authored Oneezy skill’s `references/capabilities/`. Run `node --test scripts/oneezy-capabilities.test.mjs`, the generator without --write, and canonical build/check. The generator preserves upstream sources and other groups. It does not connect, install, upload, delete or schedule anything. Preserve the contract/adapters split when refining instructions.
