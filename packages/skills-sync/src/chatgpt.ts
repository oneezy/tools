// ChatGPT as a destination (tools#196). ChatGPT's plugins live on Justin's account: no CLI or API reaches them, only
// Plugin Creator inside a ChatGPT chat, which the oneezy-skills skill drives when he types CHATGPT_LINE there. A Codex
// signed in with ChatGPT lists the account's plugins as remote marketplaces with their versions (oneezy/skills
// docs/research/codex-hook-trust-and-account-plugins.md, section 4), so a machine with such a Codex can verify the
// ChatGPT copies without any upload record: status reads them here. The account copies are the ChatGPT destination,
// not a stray duplicate of the library's Codex plugins: nothing tells Justin to uninstall them.
import { pluginsFor } from "./desired.js";
import { compareVersions, plainVersion, versionGap } from "./versions.js";
import type { HarnessState } from "./machine.js";
import type { Release } from "./release.js";

/** What Justin types in ChatGPT to bring its plugins up to the latest release. */
export const CHATGPT_LINE = "@oneezy-skills update my ChatGPT plugins to the latest oneezy/skills release";

/**
 * The oneezy plugin version whose /oneezy-skills first carries the procedure CHATGPT_LINE runs
 * (references/chatgpt-update.md, oneezy/skills ADR-0015). An account copy older than this, or none, cannot follow the
 * line, so Justin first brings oneezy up with CHATGPT_BOOTSTRAP, which asks Plugin Creator directly.
 */
export const CHATGPT_PROCEDURE_SINCE = "0.46.0";
export const CHATGPT_BOOTSTRAP =
  "@Plugin Creator update (or create, if I have none) my personal oneezy plugin to the oneezy archive in the latest github.com/oneezy/skills release (its release.json lists the files and sha256s): use update_plugin with expected_release_id, delete only files the release dropped with paths relative to the plugin root, delete nothing if under half the paths match, then read it back and report";

/** The account's oneezy copy predates the update procedure (or the account has none): the first run needs CHATGPT_BOOTSTRAP. */
export function needsBootstrap(state: ChatgptState): boolean {
  const oneezy = state.plugins.find((p) => p.id === "oneezy");
  if (!oneezy) return false;
  const v = oneezy.marketplace && oneezy.version ? plainVersion(oneezy.version) : null;
  return v === null || compareVersions(v, CHATGPT_PROCEDURE_SINCE) < 0;
}

/**
 * The remote marketplaces through which a signed-in Codex lists the account's own plugins: the ones Justin created
 * (`created-by-me-remote`) and a business workspace's (`workspace-directory`, `workspace-shared-with-me*`). OpenAI's
 * curated directory (`openai-curated-remote`) is not his.
 */
export function isAccountMarketplace(name: string): boolean {
  return /^(created-by-me-remote|workspace-[\w-]+)$/i.test(name);
}

export interface ChatgptPlugin {
  id: string;
  /** the account marketplace Codex lists the copy in; null when the account has no copy */
  marketplace: string | null;
  version: string | null;
  /** the release's version of this plugin */
  latest: string | null;
  current: boolean;
  /** newer than the release (the release job is still running): never behind */
  ahead: boolean;
  /** at the release's version but with other skills: which ones (`skills differ: missing a; extra b`) */
  differ: string | null;
}

export interface ChatgptState {
  /** the account was read through a signed-in Codex */
  checked: boolean;
  /** why it was not, when it was not */
  reason?: string;
  plugins: ChatgptPlugin[];
  /** checked, and every release plugin is on the account at the release (or ahead of it) */
  current: boolean;
}

/**
 * The ChatGPT copies of the release's plugins, judged as sync judges Codex's: by version, or by the skill set when the
 * release's plugin has none. Several account copies of one plugin (personal and workspace): the best one counts.
 */
export function chatgptState(codex: HarnessState | undefined, release: Release | null): ChatgptState {
  const not = (reason: string): ChatgptState => ({ checked: false, reason, plugins: [], current: false });
  if (!codex || !codex.cli) return not("no Codex on this machine to read the ChatGPT account through");
  if (!codex.listed) return not(codex.note ?? "codex cannot list its plugins");
  if (codex.login === null || codex.login === undefined)
    return not("codex did not say how it is signed in (codex login status)");
  if (codex.login !== "chatgpt") return not("Codex on this machine is not signed in with ChatGPT (codex login)");
  if (!release) return not("the latest release was not read");
  const plugins = pluginsFor(release, "chatgpt").map((p): ChatgptPlugin => {
    const copies = codex.installed
      .filter((x) => x.id === p.id && isAccountMarketplace(x.marketplace))
      .map((x) => {
        const gap = versionGap(x, p);
        const skills = x.skills ?? p.skills;
        const missing = p.skills.filter((s) => !skills.includes(s));
        const extra = skills.filter((s) => !p.skills.includes(s));
        const atRelease = gap === "same" || gap === "unversioned";
        const differ =
          atRelease && (missing.length || extra.length)
            ? `skills differ: ${[missing.length ? `missing ${missing.join(", ")}` : "", extra.length ? `extra ${extra.join(", ")}` : ""].filter(Boolean).join("; ")}`
            : null;
        return { x, ahead: gap === "ahead", current: atRelease && !differ, differ };
      })
      .sort((a, b) => Number(b.current || b.ahead) - Number(a.current || a.ahead));
    const best = copies[0];
    return {
      id: p.id,
      marketplace: best?.x.marketplace ?? null,
      version: best?.x.version ?? null,
      latest: p.version,
      current: !!best?.current,
      ahead: !!best?.ahead,
      differ: best?.differ ?? null,
    };
  });
  return { checked: true, plugins, current: plugins.every((p) => p.current || p.ahead) };
}
