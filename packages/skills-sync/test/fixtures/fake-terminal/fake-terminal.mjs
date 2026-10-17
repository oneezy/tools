// A stand-in for a terminal: `node fake-terminal.mjs <log file> <shell|node> <command> [args...]` runs the command as
// its child, in its own working folder and environment, with the child's stdout and stderr appended to <log file> (so
// what the command printed stays readable after the terminal is gone), and lives exactly as long as the child does,
// exiting with its code. A test closes the terminal by killing this process outright.
//
// The second argument says what kind of parent it stands for, which matters on Windows only. libuv puts every child a
// Node process spawns into that process's job object, made with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so when a Node
// parent dies, Windows kills its children with it.
// - shell: a parent that is not Node (pwsh, cmd, the console host). Its children are in no such job, so killing it
//   leaves the command running without its parent. Spawned with `detached` on Windows, which is how libuv leaves a child
//   out of its job; elsewhere a plain child, as a shell's child is.
// - node: a Node parent, such as pnpm running a package script. Killing it on Windows kills the command too.
import { spawn } from "node:child_process";
import fs from "node:fs";

const [log, kind, command, ...args] = process.argv.slice(2);
const out = fs.openSync(log, "a");
const detached = kind === "shell" && process.platform === "win32";
const child = spawn(command, args, { stdio: ["ignore", out, out], detached });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
