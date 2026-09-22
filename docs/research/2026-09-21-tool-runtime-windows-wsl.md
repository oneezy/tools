# Tool runtime and home side across Windows and WSL

Ticket: oneezy/tools#2 (part of map #1). Date: 2026-09-21.

## Question

Every tool in `clis/` must work on this Windows PC, on the Ubuntu WSL distro, and later on remote Linux hosts. Today every tool is PowerShell 7 on Windows reaching into WSL with `wsl -d`. Decide, from primary sources and local probes: (1) whether a tool lives on the Windows side, the WSL side, or runs natively on both; (2) which runtime is easiest across all hosts: PowerShell 7, Python, or Node; (3) which direction is easier, Windows driving WSL or WSL driving Windows (interop, path translation, console TUI support such as arrow keys in both directions).

## Summary

1. Runtime: **Python 3, standard library only for the core** (`msvcrt` on Windows, `termios`/`tty` on Linux for the picker; `subprocess` + JSON for workers). It is the only one of the three already present on both sides of this PC and on stock Ubuntu; pwsh and node are absent in WSL and each is an extra install on every Linux host.
2. Home side: **Windows**, because the `.cmd` entry point, the Windows console, the harness binaries (`claude`, `codex`) and the repos (`V:\dev`) all live there, and a Windows console is the only place `wsl.exe` gives WSL a real terminal.
3. Direction: **Windows drives WSL** with `wsl.exe -d <distro> --exec ...` (no shell, no quoting layer), `wslpath` for paths, JSON over stdin/stdout. The reverse direction works for piped RPC but its console attachment depends on the Windows console that launched the session, and `cmd.exe` cannot even use a `\\wsl.localhost` working directory.
4. The same Python code runs natively on a Linux host with no bridge: one `host` module decides "local" or "via wsl.exe" at startup.
5. Keep `wsl --` (default shell) out of programmatic calls, set `WSL_UTF8=1` before calling `wsl.exe`, and treat `/mnt/v` as slow: workers should read repo files from the side that owns them.

## Findings

### F1. What exists on each side today (local probe, 2026-09-21)

Windows: pwsh 7.6.6, Python 3.12.8, Node v24.21.0, WSL 2.7.11.0, gh 2.96.0, claude 2.1.278, codex-cli 0.155.1. Windows Terminal has the auto-generated WSL profile `Ubuntu-26.04` (source `Microsoft.WSL`, no explicit commandline).

WSL `Ubuntu-26.04` (kernel 6.18.33.2-microsoft-standard-WSL2, systemd on, default user `justin`): python3 3.14.4, gh 2.97.0, git 2.53.0, `script`, `tmux`. **Missing: pwsh, node, npm, bun, deno, claude, codex, pip3.** Python modules present: `curses`, `termios`, `tty`, `select`, `rich`; missing: `prompt_toolkit`, `textual`, `questionary`, `urwid`, `blessed`.

Windows Python modules: `msvcrt` ok, `rich` ok; **`curses` missing** (`No module named '_curses'`), `prompt_toolkit`, `textual`, `questionary` missing (the apps-sync tool expects them in its own `.venv`, see `clis/apps-sync-cli/Apps Sync.ps1`).

Interop is on: `/proc/sys/fs/binfmt_misc/WSLInterop` is `enabled`; `/etc/wsl.conf` has no `[interop]` section, so defaults apply (`enabled=true`, `appendWindowsPath=true`, [wsl-config]). From WSL, `cmd.exe`, `pwsh.exe` (`/mnt/c/Program Files/PowerShell/7/pwsh.exe`), `powershell.exe`, `wt.exe`, `explorer.exe` resolve on `$PATH`.

Source: probe scripts run in this session (`wsl.exe -d Ubuntu-26.04 --exec sh probe1.sh`, Windows `python -c`, `node -e`, `Get-Command`).

### F2. Windows driving WSL: `wsl.exe` semantics

- "The commands passed into `wsl.exe` are forwarded to the WSL process without modification. File paths must be specified in the WSL format." Binaries run this way "Use the same working directory as the current CMD or PowerShell prompt", "Run as the WSL default user", and "sudo, piping, and file redirection work." [filesystems]
- `--exec, -e <CommandLine>`: "Execute the specified command without using the default Linux shell." `--`: "Pass the remaining command line as is." Added in build 17666 ("Add --exec option for wsl.exe to invoke a single binary without a shell"). `--cd` added in build 21286 "to set current working directory of a command." [release-notes]
- Local probe: `wsl.exe -d Ubuntu-26.04 --cd 'V:\dev\tools' --exec pwd` prints `/mnt/v/dev/tools` (Windows path accepted by `--cd`). `wsl.exe ... --exec sh -c 'exit 7'` gives `$LASTEXITCODE` 7 in pwsh: exit codes pass through.
- Local probe, quoting hazard: `wsl.exe -d X -- sh -c '... $b ...'` from pwsh had `$b` and `$(...)` expanded by the intermediate login shell before `sh` saw them, producing blank output; the same script passed as a file via `--exec sh file` ran correctly. Programmatic calls must use `--exec` with argv, never `--` with a shell string.
- Encoding: `wsl.exe` writes its own messages (`--version`, `-l -v`, errors) as UTF-16LE; `WSL_UTF8=1` switches them to UTF-8 (WSL 0.64.0+). Local probe confirmed: `wsl.exe --version` piped through `od` shows UTF-16 (`W\0S\0L\0...`) without the variable and plain ASCII with it. Third-party tools document the same workaround. [wsl-utf8-vscode] [wsl-utf8-podman] Output of the Linux command itself is bytes as the Linux process wrote them (probe: python3 output read cleanly as UTF-8).
- Console/TTY: WSL interop uses the Windows pseudoconsole: build 17618 "Introduce pseudoconsole functionality for NT interop"; build 18277 "Switch WSL interop to use the official CreatePseudoConsole API"; build 14361 "Greatly enhanced pty / tty support. Applications like TMUX now supported". [release-notes] Windows Terminal "automatically creates Windows Subsystem for Linux (WSL) ... profiles", generated with a `source` property ("Windows.Terminal.Wsl" / "Microsoft.WSL") that "tells the terminal where to find the proper executable" — i.e. a WSL tab is `wsl.exe` under ConPTY, which is the same path a tool takes when it runs `wsl.exe` from a Windows console. [wt-dynamic-profiles] Consequence: a Linux TUI (arrow keys, full-screen) started by a Windows-side tool via `wsl.exe` gets a real Linux pty whenever the tool itself has a Windows console; in this harness (stdin piped) the Linux side correctly reported "stdin NOT tty", which is the expected propagation of a redirected console.
- Filesystem: "For the fastest performance speed, store your files in the WSL file system if you are working in a Linux command line ... If you're working in a Windows command line (PowerShell, Command Prompt), store your files in the Windows file system." `/mnt/<drive>` is DrvFs. [filesystems] The repos live on `V:\` (`/mnt/v`), so WSL-side work on them pays the DrvFs cost.

### F3. WSL driving Windows: interop from Linux

- "WSL can run Windows tools directly from the WSL command line using `[tool-name].exe`." Such apps "Retain the working directory as the WSL command prompt (for the most part -- exceptions are explained below)", "Run as the active Windows user", and "piping, redirects, and even backgrounding work as expected." "Windows tools must include the file extension, match the file case, and be executable." "Parameters are passed to the Windows binary unmodified." [filesystems]
- Working directory, local probe: from `/home`, `cmd.exe /c cd` printed `'\\wsl.localhost\Ubuntu-26.04\home' ... UNC paths are not supported. Defaulting to Windows directory.` and `C:\Windows`; `pwsh.exe` reported `Microsoft.PowerShell.Core\FileSystem::\\wsl.localhost\Ubuntu-26.04\home` (pwsh copes with the UNC cwd, cmd does not). From `/mnt/c/Users/Justin`, `cmd.exe /c cd` printed `C:\Users\Justin`. So a WSL-homed tool that shells out to Windows must either live under `/mnt/<drive>` or pass explicit Windows paths.
- Path translation: `wslpath -w /home/justin` -> `\\wsl.localhost\Ubuntu-26.04\home\justin`; `wslpath -u 'C:\Users\Justin'` -> `/mnt/c/Users/Justin`; `wslpath -w /mnt/v/dev/tools` -> `V:\dev\tools` (local probe). `WSLENV` shares variables across the boundary with flags `/p` (translate path), `/l` (path list), `/u` (only Win32->WSL), `/w` (only WSL->Win32); "WSLENV is case sensitive." [filesystems] Local probe: `MYP=/home/justin WSLENV=MYP/p pwsh.exe -Command '$env:MYP'` printed `\\wsl.localhost\Ubuntu-26.04\home\justin`.
- Encoding: `pwsh.exe` output piped into Linux arrived as UTF-8 with CRLF (`a b c \r \n`, local `od` probe). Nested `wsl.exe` from inside WSL works and needs the same `WSL_UTF8=1`.
- Console attachment is the weak point. Windows processes launched from WSL get their console from the Windows-side host that owns the session. microsoft/WSL#6225: SSH into WSL2, start tmux, run a Windows exe -> no output; workaround is to create the tmux session from a local (Windows-console-owned) WSL terminal and attach to it over SSH. [wsl-6225] Related: tmux-spawned sessions can inherit a dead `WSL_INTEROP` socket so every Windows exe call hangs then fails (`UtilAcceptVsock ... accept4 failed 110`). [wsl-interop-tmux] Local probe in this harness (no visible console): `pwsh.exe` launched from inside a Linux `script(1)` pty still saw `IsInputRedirected = True` and `KeyAvailable` threw "application does not have a console or ... input has been redirected"; `cmd.exe /c mode con` inside the same pty did report a `CON:` device (120 columns). This is consistent with "the Windows exe attaches to whatever console launched wsl.exe", and inconclusive for the interactive case (see Open questions).

### F4. Runtime candidates

**PowerShell 7.** Supported on Ubuntu 26.04 until 2031-04-30, installed from the Microsoft package repository (`packages.microsoft.com`) or a `.deb`; "Installing PowerShell from PMC is the preferred method"; registering PMC can cause ".NET package mix ups" with Ubuntu's own .NET packages. [pwsh-ubuntu] Not installed in WSL today (F1). Non-Windows differences: .NET Core subset, execution policy ignored, case-sensitive filenames, many cmdlets absent (`Get-Service`, `Get-Acl`, `Out-GridView`, CIM), no `sudo` for built-ins. [pwsh-unix] Console key input on Linux has regressed more than once: PowerShell/PowerShell#16443 "ReadKey() functions misread arrow keys as ESC on 7.2.0 / Linux" (closed "Resolution-External"), and dotnet/runtime#75305 "`[System.Console]::ReadKey()` returns escape sequence characters when pressing arrow keys in PowerShell on Linux" (milestone 8.0.0). [pwsh-16443] [dotnet-75305] A picker built on `RawUI.ReadKey` is therefore the riskiest of the three on Linux. Existing tools: `remote-control.ps1` is Windows-only (`Get-CimInstance Win32_Process`, `taskkill`), so its logic would be rewritten regardless.

**Python.** Present on both sides (3.12.8 Windows, 3.14.4 WSL) and on stock Ubuntu. `curses` availability is "Unix" and it is absent from the Windows build (F1); `msvcrt.getch()`/`getwch()` read a keypress without Enter and "If the pressed key was a special function key, this will return `'\000'` or `'\xe0'`; the next call will return the keycode." [py-curses] [py-msvcrt] On Linux, `termios` + `tty.setraw` + `select` read escape sequences (local probe: raw mode set and `select` polled inside a WSL pty; `curses` importable). A stdlib picker is therefore one small key-reader with two branches; every other part (rendering, `subprocess`, JSON, `pathlib`) is identical on both sides. `prompt_toolkit` is an optional upgrade: "Runs on Linux, OS X, OpenBSD and Windows systems", "Pure Python", "the only dependencies are Pygments and wcwidth", builds "full screen applications". [ptk] The apps-sync tool already proves the shape: Python UI on Windows (`updater_ui.py`, prompt_toolkit optional with numbered-menu fallback), stdlib-only worker in WSL invoked as `wsl.exe -d <distro> --cd ~ --exec /usr/bin/python3 -B <wslpath of script> --worker`, JSON in/out (`software_manager.py` `bridge_args`, `wsl_path`, `wsl_scan`).

**Node.** v24 on Windows, absent in WSL (F1). `tty.ReadStream.setRawMode(true)` gives character-by-character input on both platforms; `'io'` mode "is not supported on Windows"; `readline.emitKeypressEvents(stream)` requires raw mode and yields `{name, ctrl, sequence}` key objects, which is enough for a picker. [node-tty] [node-readline] The harnesses no longer pull Node in: Claude Code's native installer is the recommended path on "macOS, Linux, WSL" and "Windows PowerShell"/"CMD", and even the npm package "installs the same native binary ... The installed `claude` binary does not itself invoke Node." [cc-setup] Codex on Windows has a native sandbox ("elevated" preferred) and names WSL for when "your workflow already lives in WSL2". [codex-windows] So Node is an extra runtime to install on every Linux host purely for the tools.

### F5. Where the harnesses and repos are

`claude` and `codex` are installed on Windows and not in WSL (F1). `remote-control.ps1` starts `claude remote-control --name <repo> --spawn worktree` per folder in `V:\dev`, and the map (#1) scopes hosts as "this Windows PC, the Ubuntu WSL distro, a remote machine over SSH, a cloud sandbox" with skills synced "per harness per host". Claude Code docs: native Windows "Windows-native projects and tools", WSL 2 "Linux toolchains or sandboxed command execution"; in WSL "You install and launch `claude` inside the WSL terminal, not from PowerShell or CMD." [cc-setup] A Windows-homed tool that later needs a WSL-side harness session therefore launches it as `wsl.exe -d <distro> --cd <dir> --exec claude ...` inside a Windows console, which is the documented ConPTY path (F2).

## Constraints

- C1. WSL has no pwsh, node, claude or codex today; only python3 (3.14) and gh/git. Nothing may be installed by a tool at launch (apps-sync already states "launch never installs dependencies").
- C2. Python baseline is 3.12 (Windows); WSL is 3.14. Code targets 3.12 syntax and stdlib.
- C3. `curses` does not exist on Windows Python; `msvcrt`/`termios` are the portable pair. `prompt_toolkit` only if a tool ships its own venv.
- C4. Programmatic `wsl.exe` calls use `-d <distro> --exec <argv>` (optionally `--cd`), never `-- <shell string>`; set `WSL_UTF8=1`; translate paths with `wslpath` or `WSLENV=VAR/p`.
- C5. A Linux TUI or interactive harness started from Windows needs the tool to hold a real Windows console (the `.cmd` double-click provides one); a redirected console propagates as "not a tty" into WSL.
- C6. Windows exes run from WSL depend on the console that launched the WSL session; under ssh/tmux-created sessions they can produce no output or hang (#6225, dead `WSL_INTEROP`). `cmd.exe` refuses a `\\wsl.localhost` cwd. Use this direction only for piped, non-interactive calls with explicit Windows paths.
- C7. Repos live on a Windows drive; WSL reaches them through DrvFs at `/mnt/v`, which Microsoft documents as the slow path. Workers on the WSL side should touch WSL-owned files (`~/.claude`, `~/.codex`, `$HOME`), not scan `/mnt/v`.
- C8. The `.cmd` convention is Windows-only; a Linux host needs a sibling entry (`<tool>` shell script or `python3 -m`), same picker, same key bindings.
- C9. PowerShell's Linux console input has a history of arrow-key regressions; a pwsh picker on Linux would need PSReadLine-independent key handling and per-version testing.

## Recommendation

Adopt **Python 3.12+ standard library** as the one runtime for new tools, with **Windows as the home side** and **Windows driving WSL**:

1. One Python package per tool in `clis/<tool>/` with `__main__.py`; `<Tool>.cmd` runs `py -3` or the known interpreter path with `PYTHONUTF8=1` (as `Apps Sync.ps1` does today), and a POSIX `<tool>` script does the same on Linux hosts (C8).
2. A shared `picker` module: rendering + key loop over a 40-line key reader with two branches (`msvcrt.getwch` on Windows, `termios/tty/select` on POSIX), mapping to the picker vocabulary (up/down, space, a, enter, x, r, q). Numbered-menu fallback when stdin is not a tty, as apps-sync does.
3. A shared `host` module: on Windows it exposes `run_wsl(argv, cwd=None)` -> `["wsl.exe","-d",DISTRO,"--cd",cwd,"--exec",*argv]` with `WSL_UTF8=1` and `wslpath` helpers; on Linux it runs the same worker locally. Workers are the same Python file invoked with `--worker`, JSON on stdin/stdout (the apps-sync `bridge_args` pattern, generalised).
4. Harness launches: Windows-side `claude`/`codex` directly; WSL-side ones via `run_wsl(["claude", ...])` in a real console. Never drive Windows from WSL for anything interactive; allow `pwsh.exe`/`cmd.exe` from a WSL worker only for piped queries, and only after `wslpath -w`.
5. Retire pwsh as a tool language once each tool is ported; keep `.cmd` shims. Do not add Node or pwsh to WSL or remote hosts for the tools' sake.

Trade-off accepted: Python has no first-class Windows console API beyond `msvcrt`, so the picker will not get mouse or resize events without `prompt_toolkit`. That is acceptable for the picker convention in `CONTEXT.md`, which is keyboard-only.

## Open questions

- Q1. Interactive Windows exes from a WSL terminal: this session could not run a real console, so "pwsh.exe launched from an Ubuntu tab in Windows Terminal is interactive with arrow keys" is expected from F2/F3 but unverified here. Verify by hand: in the Ubuntu-26.04 tab run `pwsh.exe -NoProfile -Command '[Console]::IsInputRedirected'` (expect `False`). It only matters if a future tool must be homed in WSL.
- Q2. Should the picker vendor `prompt_toolkit` (per-tool venv, richer widgets) or stay stdlib? Decide with the picker ticket; the recommendation above assumes stdlib first.
- Q3. Resolved by probe: the Python launcher is present (`%LOCALAPPDATA%\Programs\Python\Launcher\py.exe`; `py -0p` lists 3.12 as default `*`, plus a pyenv 3.10 and a uv 3.11). The `.cmd` should run `py -3.12` first and fall back to `%LOCALAPPDATA%\Programs\Python\Python312\python.exe`. Remaining question: whether to pin 3.12 or accept `py -3` (which would pick whatever is default that day).
- Q4. Remote hosts: python3 is assumed present on Ubuntu/Debian images and cloud sandboxes; a host without it is out of scope until such a host exists.
- Q5. Whether `claude`/`codex` get installed in WSL at all (skills-sync per harness per host) is a map decision, not this ticket's; the bridge design above works either way.

## Sources

- [filesystems] Microsoft Learn, "Working across file systems" (WSL): https://learn.microsoft.com/en-us/windows/wsl/filesystems (updated 2026-06-02)
- [basic-commands] Microsoft Learn, "Basic commands for WSL": https://learn.microsoft.com/en-us/windows/wsl/basic-commands (2025-12-01)
- [wsl-config] Microsoft Learn, "Advanced settings configuration in WSL" (`[interop]` `enabled`/`appendWindowsPath` defaults `true`): https://learn.microsoft.com/en-us/windows/wsl/wsl-config (2026-04-15)
- [release-notes] Microsoft Learn, "Release Notes for WSL" (builds 17666 `--exec`, 21286 `--cd`, 17618/18277 pseudoconsole, 14361 pty): https://learn.microsoft.com/en-us/windows/wsl/release-notes
- [wsl-utf8-vscode] microsoft/vscode#276253, wsl.exe UTF-16LE vs `WSL_UTF8`: https://github.com/microsoft/vscode/issues/276253
- [wsl-utf8-podman] containers/podman#26527, "Confirm only using UTF8 when interacting with wsl.exe": https://github.com/containers/podman/issues/26527
- [wt-dynamic-profiles] Microsoft Learn, "Windows Terminal Dynamic Profiles": https://learn.microsoft.com/en-us/windows/terminal/dynamic-profiles (2025-11-10)
- [wsl-6225] microsoft/WSL#6225, "run exe with tmux on ssh can't work": https://github.com/microsoft/WSL/issues/6225
- [wsl-interop-tmux] theunisdk/ai-dev#4, tmux-spawned sessions inherit a dead `WSL_INTEROP` socket: https://github.com/theunisdk/ai-dev/issues/4
- [pwsh-ubuntu] Microsoft Learn, "Install PowerShell 7 on Ubuntu": https://learn.microsoft.com/en-us/powershell/scripting/install/install-ubuntu (2026-08-11)
- [pwsh-unix] Microsoft Learn, "PowerShell differences on non-Windows platforms": https://learn.microsoft.com/en-us/powershell/scripting/whats-new/unix-support
- [pwsh-16443] PowerShell/PowerShell#16443, "ReadKey() functions misread arrow keys as ESC on 7.2.0 / Linux": https://github.com/PowerShell/PowerShell/issues/16443
- [dotnet-75305] dotnet/runtime#75305, "`[System.Console]::ReadKey()` returns escape sequence characters when pressing arrow keys in PowerShell on Linux": https://github.com/dotnet/runtime/issues/75305
- [py-curses] Python docs, `curses` ("Availability: Unix"): https://docs.python.org/3/library/curses.html
- [py-msvcrt] Python docs, `msvcrt`: https://docs.python.org/3/library/msvcrt.html
- [ptk] prompt_toolkit documentation: https://python-prompt-toolkit.readthedocs.io/en/master/
- [node-tty] Node.js docs, `tty`: https://nodejs.org/api/tty.html
- [node-readline] Node.js docs, `readline.emitKeypressEvents`: https://nodejs.org/api/readline.html
- [cc-setup] Claude Code docs, "Advanced setup" (system requirements, Windows native vs WSL, native binary): https://code.claude.com/docs/en/setup
- [codex-windows] OpenAI Codex docs, Windows sandbox (redirect target of developers.openai.com/codex/windows): https://learn.chatgpt.com/docs/windows/windows-sandbox
- Local: `clis/apps-sync-cli/software_manager.py` (`bridge_args`, `wsl_path`, `wsl_scan`), `clis/apps-sync-cli/updater_ui.py`, `clis/apps-sync-cli/Apps Sync.ps1`, `clis/remote-sessions-cli/remote-control.ps1`; probe scripts run in this session on 2026-09-21 (pwsh 7.6.6, WSL 2.7.11.0, Ubuntu 26.04).
