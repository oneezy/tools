// A stand-in for a terminal window: `node fake-terminal.mjs <log file> <command> [args...]` runs the command as its
// child, in its own working folder and environment, with the child's stdout and stderr appended to <log file> (so what
// the command printed stays readable after the terminal is gone), and lives exactly as long as the child does, exiting
// with its code. A test closes the "window" by killing this process; the command is then left without its terminal,
// the way closing a real window leaves it on Windows (no signal reaches it from a killed parent).
import { spawn } from "node:child_process";
import fs from "node:fs";

const [log, command, ...args] = process.argv.slice(2);
const out = fs.openSync(log, "a");
const child = spawn(command, args, { stdio: ["ignore", out, out] });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
