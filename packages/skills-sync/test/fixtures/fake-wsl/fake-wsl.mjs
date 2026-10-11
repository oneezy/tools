// A stand-in for wsl.exe, named to the CLI through SKILLS_SYNC_WSL_EXE (a Node script, so it runs on any host and the
// real distros of the machine running the tests are never touched). `-l -q` lists the distros FAKE_WSL_DISTROS names
// (comma-separated) as wsl.exe prints them: UTF-16LE, CRLF line ends. `-d <distro> -- bash -lic <command>` appends
// [distro, command] to FAKE_WSL_LOG (one JSON array per line) and answers for the distro: one in FAKE_WSL_NO_NODE has
// no npx (bash's "command not found", exit 127); one in FAKE_WSL_FAIL fails (exit 1); any other prints FAKE_WSL_OUTPUT,
// or a sync's own summary line (an empty --json object when the command asked for --json), and exits 0.
import fs from "node:fs";

const args = process.argv.slice(2);
const list = (v) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
if (args[0] === "-l" && args[1] === "-q") {
  const text = list(process.env.FAKE_WSL_DISTROS)
    .map((d) => d + "\r\n")
    .join("");
  process.stdout.write(Buffer.from(text, "utf16le"));
  process.exit(0);
}
if (args[0] === "-d") {
  const distro = args[1];
  const command = args[args.indexOf("-lic") + 1] ?? "";
  if (process.env.FAKE_WSL_LOG) fs.appendFileSync(process.env.FAKE_WSL_LOG, JSON.stringify([distro, command]) + "\n");
  if (list(process.env.FAKE_WSL_NO_NODE).includes(distro)) {
    process.stderr.write("bash: line 1: npx: command not found\n");
    process.exit(127);
  }
  if (list(process.env.FAKE_WSL_FAIL).includes(distro)) {
    process.stderr.write(`fixture failure in ${distro}\n`);
    process.exit(1);
  }
  const words = command.split(/\s+/);
  const fallback = words.includes("--json")
    ? JSON.stringify({ plan: words.includes("--plan"), actions: [] })
    : `${words.includes("--plan") ? "plan: 0 would change" : "0 changed"}, 2 already right, 0 left alone`;
  process.stdout.write((process.env.FAKE_WSL_OUTPUT ?? fallback) + "\n");
  process.exit(0);
}
process.stderr.write(`fake wsl: unhandled ${args.join(" ")}\n`);
process.exit(2);
