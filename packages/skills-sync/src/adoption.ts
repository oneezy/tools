// Explicit migration of the four historical Brain links, never a broad ownership override.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isLink, linkTarget, samePath, makeLink, removeLink, lexists, hasLinkedParent, toHash } from "./fs.js";
import { instructionDependencies } from "./entrypoints.js";
import type { Library } from "./library.js";
import type { Report } from "./plan.js";
export interface BrainLink {
  path: string;
  expectedTarget: string;
}
interface ReceiptLink extends BrainLink {
  target: string;
  backup: string;
  state: "prepared" | "adopted" | "rolled-back";
}
interface Receipt {
  version: 1;
  library: string;
  files: Array<{ name: string; hash: string }>;
  links: ReceiptLink[];
}
export function brainLinks(platform: string): BrainLink[] {
  const api = platform === "win32" ? path.win32 : path.posix;
  const home = platform === "win32" ? "C:\\Users\\Justin" : "/home/justin";
  const expectedTarget =
    platform === "win32"
      ? "V:\\dev\\skills\\skills\\oneezy\\oneezy-brain"
      : "/mnt/v/dev/skills/skills/oneezy/oneezy-brain";
  return [".agents", ".claude"].map((name) => ({
    path: api.join(home, name, "skills", "oneezy-brain"),
    expectedTarget,
  }));
}
function selected(manifest: unknown, allowed: BrainLink[]): BrainLink[] {
  const input = manifest as { version?: number; links?: BrainLink[] };
  if (input?.version !== 1 || !Array.isArray(input.links) || !input.links.length)
    throw new Error("Explicit version 1 Brain links manifest required");
  const seen = new Set<string>();
  for (const item of input.links) {
    if (
      !item ||
      typeof item.path !== "string" ||
      typeof item.expectedTarget !== "string" ||
      !allowed.some((a) => samePath(a.path, item.path) && samePath(a.expectedTarget, item.expectedTarget)) ||
      seen.has(path.resolve(item.path))
    )
      throw new Error("Adoption is limited to the exact historical Brain links and expected targets");
    seen.add(path.resolve(item.path));
  }
  return input.links;
}
function save(file: string, receipt: Receipt): void {
  if (hasLinkedParent(file)) throw new Error("Linked receipt path is refused");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  fs.renameSync(temp, file);
}
function readReceipt(file: string): Receipt {
  if (hasLinkedParent(file)) throw new Error("Linked receipt path is refused");
  const r = JSON.parse(fs.readFileSync(file, "utf8")) as Receipt;
  if (r.version !== 1 || !Array.isArray(r.links) || !Array.isArray(r.files) || typeof r.library !== "string")
    throw new Error("Invalid Brain receipt");
  return r;
}
export function adoptBrain(
  lib: Library,
  manifest: unknown,
  allowed: BrainLink[],
  receiptFile: string,
  report: Report,
  plan: boolean,
): void {
  const links = selected(manifest, allowed);
  const own = lib.scanOwn().skills.find((s) => s.name === "oneezy-brain");
  if (!own) throw new Error("Reviewed Brain is missing");
  if (hasLinkedParent(own.dir)) throw new Error("Reviewed Brain source has a linked parent");
  const dependency = instructionDependencies(lib).find((d) => d.skill === "oneezy-brain");
  const files = ["SKILL.md", ...(dependency?.files ?? [])].map((name) => ({
    name,
    hash: toHash(fs.readFileSync(path.join(own.dir, name))),
  }));
  const receipt: Receipt = lexists(receiptFile)
    ? readReceipt(receiptFile)
    : { version: 1, library: lib.root, files, links: [] };
  if (!samePath(receipt.library, lib.root)) throw new Error("Receipt belongs to a different reviewed library");
  if (JSON.stringify(receipt.files) !== JSON.stringify(files))
    throw new Error("Reviewed dependency hashes differ from the adoption receipt");
  for (const item of links) {
    try {
      const previous = receipt.links.find((a) => samePath(a.path, item.path));
      const target = linkTarget(item.path);
      if (previous?.state === "adopted" && target && samePath(target, own.dir)) {
        if (
          !samePath(path.dirname(previous.backup), path.dirname(item.path)) ||
          !path.basename(previous.backup).startsWith(".oneezy-brain.skills-sync-backup-") ||
          !isLink(previous.backup) ||
          !samePath(linkTarget(previous.backup) ?? "", item.expectedTarget)
        )
          throw new Error("Preserved backup ownership changed; left alone");
        report.add({ kind: "skip", path: item.path, target: own.dir, note: `adopted; backup ${previous.backup}` });
        continue;
      }
      if (!isLink(item.path) || !target || !samePath(target, item.expectedTarget))
        throw new Error("Expected historical link target changed; left alone");
      if (hasLinkedParent(path.dirname(item.path))) throw new Error("Linked destination parent is refused");
      if (plan) {
        report.add({
          kind: "relink",
          path: item.path,
          target: own.dir,
          note: `explicit adoption; was ${target}; backup required`,
        });
        continue;
      }
      const record: ReceiptLink = {
        ...item,
        target: own.dir,
        backup: path.join(path.dirname(item.path), `.oneezy-brain.skills-sync-backup-${randomUUID()}`),
        state: "prepared",
      };
      if (previous && previous.state !== "rolled-back")
        throw new Error("Incomplete previous adoption; reconcile receipt before retry");
      receipt.links = receipt.links.filter((a) => !samePath(a.path, item.path));
      receipt.links.push(record);
      save(receiptFile, receipt);
      // Immediately before mutation, recheck source bytes and the exact expected old link.
      if (
        !samePath(linkTarget(item.path) ?? "", item.expectedTarget) ||
        files.some((f) => toHash(fs.readFileSync(path.join(own.dir, f.name))) !== f.hash)
      )
        throw new Error("Adoption precondition changed; left alone");
      fs.renameSync(item.path, record.backup);
      try {
        makeLink(own.dir, item.path);
        if (!samePath(linkTarget(item.path) ?? "", own.dir)) throw new Error("Adoption readback failed");
      } catch (error) {
        if (isLink(item.path) && samePath(linkTarget(item.path) ?? "", own.dir)) removeLink(item.path);
        if (!lexists(item.path)) fs.renameSync(record.backup, item.path);
        record.state = "rolled-back";
        save(receiptFile, receipt);
        throw error;
      }
      record.state = "adopted";
      save(receiptFile, receipt);
      report.add({
        kind: "relink",
        path: item.path,
        target: own.dir,
        note: `explicit adoption; was ${target}; backup ${record.backup}; receipt ${receiptFile}`,
      });
    } catch (error) {
      report.add({ kind: "conflict", path: item.path, note: String(error) });
    }
  }
}
export function rollbackBrain(receiptFile: string, allowed: BrainLink[], report: Report, plan: boolean): void {
  const receipt = readReceipt(receiptFile);
  selected({ version: 1, links: receipt.links.map(({ path, expectedTarget }) => ({ path, expectedTarget })) }, allowed);
  for (const item of receipt.links) {
    try {
      if (item.state === "rolled-back") {
        report.add({ kind: "skip", path: item.path, note: "already rolled back" });
        continue;
      }
      if (
        !samePath(path.dirname(item.backup), path.dirname(item.path)) ||
        !path.basename(item.backup).startsWith(".oneezy-brain.skills-sync-backup-") ||
        hasLinkedParent(path.dirname(item.path)) ||
        !isLink(item.backup) ||
        !samePath(linkTarget(item.backup) ?? "", item.expectedTarget)
      )
        throw new Error("Backup ownership changed; left alone");
      if (lexists(item.path) && (!isLink(item.path) || !samePath(linkTarget(item.path) ?? "", item.target)))
        throw new Error("Adopted link changed; preserve later work");
      if (!plan) {
        if (lexists(item.path)) removeLink(item.path);
        fs.renameSync(item.backup, item.path);
        if (!samePath(linkTarget(item.path) ?? "", item.expectedTarget)) throw new Error("Rollback readback failed");
        item.state = "rolled-back";
        save(receiptFile, receipt);
      }
      report.add({
        kind: "relink",
        path: item.path,
        target: item.expectedTarget,
        note: "restored exact preserved historical link",
      });
    } catch (error) {
      report.add({ kind: "conflict", path: item.path, note: String(error) });
    }
  }
}
