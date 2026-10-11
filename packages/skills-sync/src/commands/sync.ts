// sync, the default machine command: read the latest release, probe this machine, compute what each harness should
// have (desired.ts) and apply it, or show it with --plan; nothing else is looked for, no library, no local file. Today
// that is the managed block in each harness's global instructions file (ADR-0011) and a cleanup line per block an older
// skills-sync left in a repository; the per-harness plugin and link work arrives in src/forms/ with tools#149, #150 and
// #153. Outside the cloud, GitHub being unreachable is one red line, not a stop: the block needs no release and is
// written anyway. In the cloud the release is not read at all: the block is the whole sync there, and a session start
// must not go red (or print) over a GitHub it cannot reach. The caller prints the report (cli.ts's printer, so sync's output and the old library-based run's read the same) and sets
// the exit code from it: 1 when an action failed or anything is red.
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
  /** only these harness ids (--agents); every detected one when unset */
  agents?: string[];
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
  if (!machine.cloud)
    try {
      release = await latestRelease(github(env), options.repo);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  const report = new Report();
  if (error) report.add({ kind: "conflict", path: options.repo, note: `latest release not read: ${error}` });
  report.merge(desired(release, machine, FORMS, { agents: options.agents, plan: options.plan }));
  apply(report, options.plan);
  return { report, release, error, machine };
}

/** What sync adds to the report's --json beside the actions: the release it read (or why not) and the session kind. */
export function syncFacts(r: SyncResult): Record<string, unknown> {
  return {
    release: r.release
      ? {
          repo: r.release.repo,
          tag: r.release.tag,
          number: r.release.number,
          commit: r.release.commit,
          tool: r.release.tool,
        }
      : null,
    ...(r.error ? { error: r.error } : {}),
    cloud: r.machine.cloud,
  };
}
