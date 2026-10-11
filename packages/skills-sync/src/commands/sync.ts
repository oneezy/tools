// sync, the default machine command: read the latest release, probe this machine, compute what each harness should
// have (desired.ts) and apply it, or show it with --plan; nothing else is looked for, no library, no local file, nothing
// of its own left on the machine (ADR-0012). Today that is the managed block in each harness's global instructions file
// (ADR-0011; its text the release's SHARED.md), a cleanup line per block an older skills-sync left in a repository, a
// note per leftover of the old tool, and whatever each harness's form in src/forms/ asks for. GitHub being unreachable
// keeps every block as it is with one line saying so; outside the cloud it is also one red line, the plugins', not a
// stop. In the cloud the release is read for the block alone, the block being the whole sync there, and a GitHub it
// cannot reach is that one line and nothing red: a session start must not go red over it. The caller prints the
// report (cli.ts's printer, shared with every command) and sets the exit code from it: 1 when an action failed or
// anything is red. On Windows the caller also runs this same sync inside every WSL distro (wsl.ts).
import { releaseSource } from "../block.js";
import { desired, type FormFn } from "../desired.js";
import { claudeCode } from "../forms/claude-code.js";
import { codex } from "../forms/codex.js";
import { hermes } from "../forms/hermes.js";
import { github } from "../github.js";
import { harnessTable } from "../harnesses.js";
import { probe, type Machine } from "../machine.js";
import { apply, Report } from "../plan.js";
import { latestRelease, type Release } from "../release.js";

/** The form modules by harness id; a harness without one (Goose) gets the block and nothing more. */
export const FORMS: Record<string, FormFn> = { "claude-code": claudeCode, codex, hermes };

export interface SyncOptions {
  /** the release repo, owner/repo */
  repo: string;
  /** show the plan, write nothing */
  plan: boolean;
  env?: NodeJS.ProcessEnv;
  /** where the run happens; a repository there is looked at for old blocks */
  cwd?: string;
}

export interface SyncResult {
  report: Report;
  release: Release | null;
  /** why the release could not be read, when it could not */
  error: string | null;
  machine: Machine;
}

export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const env = options.env ?? process.env;
  const machine = probe(harnessTable(undefined, env), env, options.cwd);
  let release: Release | null = null;
  let error: string | null = null;
  const gh = github(env);
  try {
    release = await latestRelease(gh, options.repo);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const report = new Report();
  // the plugins' red line; in the cloud there are no plugins to judge, and the block's own line says it all
  if (error && !machine.cloud)
    report.add({ kind: "conflict", path: options.repo, note: `latest release not read: ${error}` });
  report.merge(
    await desired(release, machine, FORMS, {
      plan: options.plan,
      github: release ? gh : null,
      releaseError: error,
    }),
  );
  apply(report, options.plan);
  return { report, release, error, machine };
}

/** The global block's text this run had: its release and sha256 (fallback: the built-in text), or why there was none. */
function sharedFacts(r: SyncResult): Record<string, unknown> {
  const text = releaseSource(r.release, r.error);
  return text.ok
    ? { release: text.source.release, sha256: text.source.sha256, fallback: text.source.fallback }
    : { error: text.reason };
}

/**
 * What sync adds to the report's --json beside the actions: the release it read (or why not), the block's text
 * (`shared`) and the session kind.
 */
export function syncFacts(r: SyncResult): Record<string, unknown> {
  return {
    release: r.release
      ? {
          repo: r.release.repo,
          tag: r.release.tag,
          number: r.release.number,
          commit: r.release.commit,
          tool: r.release.tool,
          config: r.release.config,
        }
      : null,
    ...(r.error ? { error: r.error } : {}),
    shared: sharedFacts(r),
    cloud: r.machine.cloud,
    oldLibrary: r.machine.oldLibrary,
    oldLocalFile: r.machine.oldLocalFile,
  };
}
