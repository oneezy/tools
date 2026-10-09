// Explicit handoff of Skills/Status's historical loose links to verified native plugins.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hasLinkedParent, isLink, lexists, linkTarget, samePath, toHash } from "./fs.js";
import { pluginDependency } from "./install.js";
import type { Harness } from "./harnesses.js";
import type { Library } from "./library.js";
import type { Action, Report } from "./plan.js";

export interface AliasLink {
  path: string;
  expectedTarget: string;
  agent: string;
  skill: string;
}
interface RecordLink extends AliasLink {
  backup: string;
  replacement: string;
  files: Array<{ name: string; hash: string }>;
  state: "prepared" | "migrated" | "rolled-back";
}
interface Receipt {
  version: 1;
  kind: "skills-sync-aliases";
  library: string;
  links: RecordLink[];
}
type Resolver = typeof pluginDependency;
class VerificationError extends Error {
  constructor(
    message: string,
    readonly diagnostic?: Action["diagnostic"],
  ) {
    super(message);
  }
}
const diagnosticOf = (error: unknown) => (error instanceof VerificationError ? error.diagnostic : undefined);

export function aliasLinks(platform: string): AliasLink[] {
  const win = platform === "win32";
  const api = win ? path.win32 : path.posix;
  const home = win ? "C:\\Users\\Justin" : "/home/justin";
  const library = win ? "V:\\dev\\skills" : "/mnt/v/dev/skills";
  return [
    { folder: ".agents", agent: "codex" },
    { folder: ".claude", agent: "claude-code" },
  ].flatMap(({ folder, agent }) =>
    ["oneezy-skills", "oneezy-status"].map((skill) => ({
      path: api.join(home, folder, "skills", skill),
      expectedTarget: api.join(library, "skills", "oneezy", skill),
      agent,
      skill,
    })),
  );
}

function select(manifest: unknown, allowed: AliasLink[]): AliasLink[] {
  const input = manifest as { version?: number; links?: Array<{ path: string; expectedTarget: string }> };
  if (input?.version !== 1 || !Array.isArray(input.links) || !input.links.length)
    throw new Error("Explicit version 1 Skills/Status alias manifest required");
  const seen = new Set<string>();
  return input.links.map((item) => {
    const match =
      item && typeof item.path === "string" && typeof item.expectedTarget === "string"
        ? allowed.find((a) => samePath(a.path, item.path) && samePath(a.expectedTarget, item.expectedTarget))
        : undefined;
    if (!match || seen.has(path.resolve(match.path)))
      throw new Error("Migration is limited to the exact historical Skills/Status aliases and expected targets");
    seen.add(path.resolve(match.path));
    return match;
  });
}

function backupRoot(item: AliasLink): string {
  return path.join(path.dirname(path.dirname(item.path)), ".skills-sync-alias-backups");
}
function checkBackup(item: RecordLink): void {
  if (
    !samePath(path.dirname(item.backup), backupRoot(item)) ||
    !path.basename(item.backup).startsWith(`${item.skill}-`) ||
    hasLinkedParent(path.dirname(item.backup)) ||
    !isLink(item.backup) ||
    !samePath(linkTarget(item.backup) ?? "", item.expectedTarget)
  )
    throw new Error("Preserved alias backup ownership changed; left alone");
}
function readReceipt(file: string, allowed: AliasLink[]): Receipt {
  if (hasLinkedParent(file) || isLink(file)) throw new Error("Linked receipt path is refused");
  const receipt = JSON.parse(fs.readFileSync(file, "utf8")) as Receipt;
  if (
    receipt.version !== 1 ||
    receipt.kind !== "skills-sync-aliases" ||
    typeof receipt.library !== "string" ||
    !Array.isArray(receipt.links)
  )
    throw new Error("Invalid Skills/Status alias receipt");
  if (receipt.links.length) select({ version: 1, links: receipt.links }, allowed);
  for (const item of receipt.links)
    if (
      !allowed.some((a) => samePath(a.path, item.path) && a.agent === item.agent && a.skill === item.skill) ||
      typeof item.backup !== "string" ||
      typeof item.replacement !== "string" ||
      !Array.isArray(item.files) ||
      !["prepared", "migrated", "rolled-back"].includes(item.state)
    )
      throw new Error("Invalid alias ownership record");
  return receipt;
}
function save(file: string, receipt: Receipt): void {
  if (hasLinkedParent(file) || isLink(file)) throw new Error("Linked receipt path is refused");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  fs.renameSync(temporary, file);
}
function skillFiles(dir: string, relative = ""): string[] {
  return fs
    .readdirSync(path.join(dir, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink() || isLink(path.join(dir, name)))
        throw new Error("Linked replacement source file is refused");
      return entry.isDirectory() ? skillFiles(dir, name) : [name];
    })
    .sort();
}
function verifiedReplacement(
  lib: Library,
  item: AliasLink,
  hosts: Harness[],
  resolve: Resolver,
): { replacement: string; files: RecordLink["files"] } {
  const host = hosts.find((h) => h.id === item.agent && samePath(path.join(h.userSkills, item.skill), item.path));
  const own = lib.scanOwn().skills.find((s) => s.name === item.skill);
  if (!host || !own || hasLinkedParent(own.dir)) throw new Error("Selected host or reviewed skill is unavailable");
  const names = skillFiles(own.dir);
  let diagnostic: Action["diagnostic"];
  const replacement = resolve(
    lib,
    host,
    item.skill,
    names.filter((n) => n !== "SKILL.md"),
    false,
    item.expectedTarget,
    (failed) => {
      diagnostic = failed;
    },
  );
  if (!replacement)
    throw new VerificationError(
      "Enabled native replacement, source, version or exact skill files are unverified; alias retained",
      diagnostic,
    );
  const files = names.map((name) => ({ name, hash: toHash(fs.readFileSync(path.join(replacement, name))) }));
  return { replacement, files };
}

export function migrateAliases(
  lib: Library,
  manifest: unknown,
  allowed: AliasLink[],
  hosts: Harness[],
  receiptFile: string,
  report: Report,
  plan: boolean,
  resolve: Resolver = pluginDependency,
): void {
  const selected = select(manifest, allowed);
  const receipt: Receipt = lexists(receiptFile)
    ? readReceipt(receiptFile, allowed)
    : { version: 1, kind: "skills-sync-aliases", library: lib.root, links: [] };
  if (!samePath(receipt.library, lib.root)) throw new Error("Receipt belongs to a different reviewed library");
  // Skills chains to Status: preflight every selected alias on a host before changing either one's discovery.
  const prepared = new Map<string, ReturnType<typeof verifiedReplacement>>();
  const blocked = new Map<string, Map<string, unknown>>();
  for (const item of selected) {
    try {
      if (hasLinkedParent(path.dirname(item.path))) throw new Error("Linked alias parent is refused");
      const prior = receipt.links.find((r) => samePath(r.path, item.path));
      const verified = verifiedReplacement(lib, item, hosts, resolve);
      if (prior && prior.state !== "rolled-back") {
        checkBackup(prior);
        if (lexists(item.path)) throw new Error("Migrated destination changed; preserve later work");
        if (
          !samePath(prior.replacement, verified.replacement) ||
          JSON.stringify(prior.files) !== JSON.stringify(verified.files)
        )
          throw new Error("Verified replacement changed since the receipt; reconcile before retry");
      } else if (!isLink(item.path) || !samePath(linkTarget(item.path) ?? "", item.expectedTarget))
        throw new Error("Expected historical alias target changed; left alone");
      prepared.set(item.path, verified);
    } catch (error) {
      const failures = blocked.get(item.agent) ?? new Map<string, unknown>();
      failures.set(item.path, error);
      blocked.set(item.agent, failures);
    }
  }
  for (const item of selected) {
    try {
      const failures = blocked.get(item.agent);
      if (failures) {
        const failure = failures.get(item.path) ?? [...failures.values()][0];
        throw new VerificationError(`Host alias prerequisites failed: ${failure}`, diagnosticOf(failure));
      }
      if (hasLinkedParent(path.dirname(item.path))) throw new Error("Linked alias parent is refused");
      const prior = receipt.links.find((r) => samePath(r.path, item.path));
      const verified = prepared.get(item.path)!;
      if (prior && prior.state !== "rolled-back") {
        checkBackup(prior);
        if (lexists(item.path)) throw new Error("Migrated destination changed; preserve later work");
        if (
          !samePath(prior.replacement, verified.replacement) ||
          JSON.stringify(prior.files) !== JSON.stringify(verified.files)
        )
          throw new Error("Verified replacement changed since the receipt; reconcile before retry");
        if (!plan && prior.state === "prepared") {
          prior.state = "migrated";
          save(receiptFile, receipt);
        }
        report.add({
          kind: "skip",
          path: item.path,
          target: verified.replacement,
          note: `native plugin active; preserved backup ${prior.backup}`,
        });
        continue;
      }
      if (!isLink(item.path) || !samePath(linkTarget(item.path) ?? "", item.expectedTarget))
        throw new Error("Expected historical alias target changed; left alone");
      const record: RecordLink = {
        ...item,
        ...verified,
        backup: path.join(backupRoot(item), `${item.skill}-${randomUUID()}`),
        state: "prepared",
      };
      if (hasLinkedParent(record.backup)) throw new Error("Linked backup parent is refused");
      if (plan) {
        report.add({
          kind: "move",
          path: item.path,
          target: record.backup,
          note: `explicit native migration; verified replacement ${verified.replacement}; backup required`,
        });
        continue;
      }
      fs.mkdirSync(backupRoot(item), { recursive: true });
      receipt.links = receipt.links.filter((r) => !samePath(r.path, item.path));
      receipt.links.push(record);
      save(receiptFile, receipt);
      // Verify the replacement and old target again immediately before changing discovery.
      const rechecked = verifiedReplacement(lib, item, hosts, resolve);
      if (
        !isLink(item.path) ||
        !samePath(linkTarget(item.path) ?? "", item.expectedTarget) ||
        !samePath(rechecked.replacement, verified.replacement) ||
        JSON.stringify(rechecked.files) !== JSON.stringify(verified.files) ||
        hasLinkedParent(record.backup) ||
        hasLinkedParent(path.dirname(item.path))
      )
        throw new Error("Alias migration precondition changed; left alone");
      fs.renameSync(item.path, record.backup);
      checkBackup(record);
      if (lexists(item.path)) throw new Error("Alias migration readback failed");
      record.state = "migrated";
      save(receiptFile, receipt);
      report.add({
        kind: "move",
        path: item.path,
        target: record.backup,
        note: `native replacement ${record.replacement}; receipt ${receiptFile}`,
      });
    } catch (error) {
      report.add({
        kind: "conflict",
        path: item.path,
        note: String(error),
        ...(diagnosticOf(error) ? { diagnostic: diagnosticOf(error) } : {}),
      });
    }
  }
}

export function rollbackAliases(receiptFile: string, allowed: AliasLink[], report: Report, plan: boolean): void {
  const receipt = readReceipt(receiptFile, allowed);
  for (const item of receipt.links) {
    try {
      if (hasLinkedParent(path.dirname(item.path))) throw new Error("Linked alias parent is refused");
      if (item.state === "rolled-back") {
        if (!isLink(item.path) || !samePath(linkTarget(item.path) ?? "", item.expectedTarget))
          throw new Error("Restored destination changed; preserve later work");
        report.add({ kind: "skip", path: item.path, note: "already rolled back" });
        continue;
      }
      if (
        item.state === "prepared" &&
        !lexists(item.backup) &&
        isLink(item.path) &&
        samePath(linkTarget(item.path) ?? "", item.expectedTarget)
      ) {
        if (!plan) {
          item.state = "rolled-back";
          save(receiptFile, receipt);
        }
        report.add({ kind: "skip", path: item.path, note: "prepared migration did not move the original alias" });
        continue;
      }
      checkBackup(item);
      if (lexists(item.path)) throw new Error("Migrated destination changed; preserve later work");
      if (!plan) {
        fs.renameSync(item.backup, item.path);
        if (!samePath(linkTarget(item.path) ?? "", item.expectedTarget))
          throw new Error("Alias rollback readback failed");
        item.state = "rolled-back";
        save(receiptFile, receipt);
      }
      report.add({
        kind: "move",
        path: item.backup,
        target: item.path,
        note: "restored exact preserved alias; native plugin retained",
      });
    } catch (error) {
      report.add({
        kind: "conflict",
        path: item.path,
        note: String(error),
        ...(diagnosticOf(error) ? { diagnostic: diagnosticOf(error) } : {}),
      });
    }
  }
}
