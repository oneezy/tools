"""Terminal interface. The Ubuntu worker does not need prompt_toolkit."""
from __future__ import annotations
import json
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

HEADINGS = ["Tool", "Windows", "WSL", "Latest available version", "Status / action"]


def clean(value):
    # Metadata and command output are untrusted terminal text.
    return "".join(c if c in "\n\t" or ord(c) >= 32 and ord(c) != 127 else "?" for c in str(value))


def compact_location(row):
    path = str(row.get("path") or "").replace("\\", "/")
    if not path:
        return ""
    if row.get("owner") in ("vp-global", "npm-global", "pnpm-global"):
        return row["owner"]
    if "WindowsApps" in path:
        return "Windows app package"
    if "/.vite-plus/" in path:
        return "~/.vite-plus"
    if "/.local/" in path:
        return "~/.local"
    if "/.codex/" in path or "/OpenAI/Codex/" in path:
        return "Codex/bin"
    if "/.herdr/" in path:
        return "~/.herdr"
    return "/".join(path.rstrip("/").split("/")[-2:])


def platform_cell(row):
    if not row:
        return "not inspected"
    if row["state"] == "not-applicable":
        return "not applicable"
    if row["state"] == "unavailable":
        return row["status"]
    value = row.get("installed") or ("absent" if row["state"] == "missing" else "unknown")
    location = compact_location(row)
    return value + ("\n" + location if location else "")


def logical_rows(rows):
    output = []
    for id in dict.fromkeys(r["id"] for r in rows):
        group = {r["host"]: r for r in rows if r["id"] == id}
        title = next(iter(group.values()))["name"]
        latest, actions = [], []
        for host, label in (("windows", "Win"), ("wsl", "WSL")):
            row = group.get(host)
            if not row or row["state"] == "not-applicable":
                continue
            release = row.get("release")
            if release:
                scope = release["scope"]
                latest.append(label + ": " + release["version"] +
                              (" [cached APT]" if not release["fresh"] else " [" + scope + "]"))
            else:
                latest.append(label + ": not checked")
            status = row["status"]
            if status == "Installed / latest not checked":
                status = "Installed; check latest"
            if status == "Missing":
                status = "Missing; select Install"
            if row.get("operation"):
                status = row["operation"]["status"]
                if row["operation"].get("restart_required"):
                    status += "; restart required"
            actions.append(label + ": " + status)
        if latest and all("not checked" in v for v in latest):
            latest = ["not checked"]
        output.append((id, [title, platform_cell(group.get("windows")), platform_cell(group.get("wsl")),
                            "\n".join(latest) or "not applicable", "\n".join(actions) or "No applicable platform"]))
    return output


def table_lines(rows, width=150, marked=()):
    width = max(64, min(width, 200))
    usable = width - 16
    widths = [max(8, int(usable * ratio)) for ratio in (.18, .18, .18, .20)]
    widths.append(usable - sum(widths))
    border = "+" + "+".join("-" * (w + 2) for w in widths) + "+"
    lines, starts = [border], {}
    def add(cells):
        wrapped = [[part for line in clean(cell).split("\n")
                    for part in (textwrap.wrap(line, w, break_long_words=True, break_on_hyphens=False) or [""])]
                   for cell, w in zip(cells, widths)]
        for i in range(max(map(len, wrapped))):
            lines.append("| " + " | ".join((v[i] if i < len(v) else "").ljust(w) for v, w in zip(wrapped, widths)) + " |")
    add(HEADINGS)
    lines.append(border)
    for id, cells in logical_rows(rows):
        starts[id] = len(lines)
        if id in marked:
            cells[0] = "[x] " + cells[0]
        add(cells)
        lines.append(border)
    return lines, starts


def table_text(rows, width=None):
    return "\n".join(table_lines(rows, width or shutil.get_terminal_size((150, 40)).columns)[0])


def detail_text(rows):
    lines = []
    for row in rows:
        lines += [row["name"] + " / " + row["host"], "-" * 60]
        for key in ("state", "status", "installed", "owner", "route", "scope", "channel", "path", "resolved_path",
                    "package_identity", "prefix", "node", "pin", "manifest", "installed_at", "observed_at",
                    "release_source", "detail", "release_error"):
            if row.get(key) is not None:
                lines.append(key.replace("_", " ").title() + ": " + str(row[key]))
        for key, heading in (("release", "Selected release check"), ("history", "Previous check (history only)")):
            if row.get(key):
                summary = {k: v for k, v in row[key].items() if k != "metadata"}
                lines += [heading + ":", json.dumps(summary, indent=2)]
        if row.get("operation"):
            lines += ["Last operation:", json.dumps(row["operation"], indent=2)]
        if row.get("alternatives"):
            lines += ["Other installation owners:", json.dumps(row["alternatives"], indent=2)]
        lines.append("")
    return clean("\n".join(lines))


def plan_text(plan):
    lines = ["PREFLIGHT PLAN", "Only Ready entries will execute. {download} is a new temporary directory.",
             "No application will be force-closed and no restart will be requested automatically.", ""]
    for item in plan:
        target = item.get("target") or {}
        lines += [f'{item["name"]} / {item["host"]}: {item["status"]}',
                  f'  Action: {item["action"]} | Before: {item.get("before") or "absent/unknown"} | Target: {target.get("version", "not checked")}',
                  "  Owner/location: " + json.dumps(item.get("identity")),
                  f'  Source: {target.get("scope", "none")} | Channel: {target.get("channel", "unknown")} | Checked: {target.get("checked_at", "never")}',
                  "  " + item.get("detail", "")]
        if target.get("limitation"):
            lines.append("  " + target["limitation"])
        if target.get("index_times"):
            lines.append("  Index timestamps: " + json.dumps(target["index_times"]))
        for asset in item.get("downloads", []):
            lines += ["  Download: " + asset["url"], "  SHA-256: " + str(asset.get("sha256")),
                      "  Expected signer: " + (asset.get("signer") or "publisher checksum/bootstrap")]
        for command in item.get("commands", []):
            lines.append("  Command: " + subprocess.list2cmdline(command))
        if item.get("environment"):
            lines.append("  Environment: " + json.dumps(item["environment"]))
        lines += ["  " + note for note in item.get("limitations", [])]
        lines += ["  Elevation may be needed: " + str(item.get("elevation", False)), ""]
    return clean("\n".join(lines))


class ManagerUI:
    def __init__(self, catalog, plain=False, target="all"):
        self.catalog, self.plain, self.target = catalog, plain, target
        self.rows, self.marked, self.index = [], set(), 0
        self.notice = "Local inventory only. Latest releases have not been checked."
        self.ids = [t["id"] for t in catalog["tools"]]
        self.interactive = sys.stdin.isatty() and sys.stdout.isatty()
        self.rich = self.interactive and not plain and os.environ.get("TERM") != "dumb"
        if self.rich:
            try:
                import prompt_toolkit
            except ImportError:
                self.rich = False
                self.notice += " Keyboard library unavailable; numbered menu enabled."

    def scan(self, mode="check", only=()):
        from software_manager import collect
        print("Scanning local installation records..." if mode != "check-latest" else
              "Checking selected release sources (APT uses dated cached indexes)...", flush=True)
        data = collect(self.catalog, mode, self.target, only)
        if only:
            replacements = {(r["host"], r["id"]): r for r in data["rows"]}
            self.rows = [replacements.pop((r["host"], r["id"]), r) for r in self.rows] + list(replacements.values())
        else:
            self.rows = data["rows"]
        return data

    def choose(self, title, options):
        if self.rich:
            from prompt_toolkit.application import Application
            from prompt_toolkit.key_binding import KeyBindings
            from prompt_toolkit.layout import Layout, HSplit, Window
            from prompt_toolkit.layout.controls import FormattedTextControl
            from prompt_toolkit.data_structures import Point
            index = [0]
            kb = KeyBindings()
            @kb.add("up")
            def up(event):
                index[0] = max(0, index[0] - 1)
            @kb.add("down")
            def down(event):
                index[0] = min(len(options) - 1, index[0] + 1)
            @kb.add("enter")
            def enter(event):
                event.app.exit(result=options[index[0]][0])
            @kb.add("escape")
            @kb.add("c-c")
            def cancel(event):
                event.app.exit(result=None)
            control = FormattedTextControl(lambda: [
                ("reverse" if i == index[0] else "", "  " + clean(label) + "\n")
                for i, (_, label) in enumerate(options)], focusable=True,
                get_cursor_position=lambda: Point(0, index[0]))
            return Application(layout=Layout(HSplit([
                Window(FormattedTextControl(title), height=2), Window(control),
                Window(FormattedTextControl("Up/down: move   Enter: choose   Esc: back"), height=1)])),
                key_bindings=kb, full_screen=True).run()
        print("\n" + title)
        for n, (_, label) in enumerate(options, 1):
            print(f"{n}. {label}")
        answer = input("Number (Enter = back): ").strip()
        return options[int(answer)-1][0] if answer.isdigit() and 1 <= int(answer) <= len(options) else None

    def show(self, title, text):
        if self.rich:
            from prompt_toolkit.application import Application
            from prompt_toolkit.key_binding import KeyBindings
            from prompt_toolkit.layout import Layout, HSplit
            from prompt_toolkit.widgets import TextArea, Label
            from prompt_toolkit.styles import Style
            kb = KeyBindings()
            @kb.add("escape")
            @kb.add("c-c")
            @kb.add("enter")
            def done(event):
                event.app.exit()
            area = TextArea(text=clean(text), read_only=True, scrollbar=True, wrap_lines=True)
            Application(layout=Layout(HSplit([Label(title, style="bold"), area,
                                             Label("Up/down / PageUp / PageDown: scroll    Enter / Esc: return")]), focused_element=area),
                        key_bindings=kb, full_screen=True,
                        style=Style.from_dict({"label": "ansicyan"})).run()
        else:
            print("\n" + title + "\n" + clean(text))
            if self.interactive:
                input("Press Enter to return: ")

    def select_installations(self, action):
        scope = self.marked or {self.ids[self.index]}
        eligible = [r for r in self.rows if r["id"] in scope and r["state"] not in ("not-applicable", "unavailable")]
        options = [((r["host"], r["id"]), f'{r["name"]} / {r["host"]}: {r.get("installed") or r["state"]} [{r["status"]}]')
                   for r in eligible if (r["state"] == "missing" if action == "install" else r["state"] != "missing")]
        if not options:
            self.show("Nothing to select", "No matching installations. Mark tools with Space first; missing tools use Install.")
            return []
        if self.rich:
            from prompt_toolkit.shortcuts import checkboxlist_dialog
            return checkboxlist_dialog(title="Select installations to " + action,
                                       text="Space toggles. No installations are selected automatically. Tab then Enter confirms.",
                                       values=options, default_values=[]).run() or []
        print("\nSelect installations to " + action)
        for n, (_, label) in enumerate(options, 1):
            print(f"{n}. {label}")
        values = input("Numbers separated by commas (empty = cancel): ").split(",")
        return [options[int(v.strip())-1][0] for v in values if v.strip().isdigit() and 1 <= int(v.strip()) <= len(options)]

    def dashboard(self):
        if not self.rich:
            print(table_text(self.rows))
            print(self.notice)
            print("Focused tool: " + self.ids[self.index] + "; marked: " + (", ".join(sorted(self.marked)) or "none"))
            return self.choose("Actions", self.actions())
        from prompt_toolkit.application import Application
        from prompt_toolkit.layout import Layout, HSplit, Window
        from prompt_toolkit.layout.controls import FormattedTextControl
        from prompt_toolkit.data_structures import Point
        from prompt_toolkit.key_binding import KeyBindings
        from prompt_toolkit.styles import Style
        kb = KeyBindings()
        def lines():
            return table_lines(self.rows, max(64, shutil.get_terminal_size((150, 40)).columns), self.marked)
        def fragments():
            text, starts = lines()
            begin = starts.get(self.ids[self.index], 0)
            ordered = sorted(starts.values())
            end = next((v for v in ordered if v > begin), len(text))
            output = []
            for n, line in enumerate(text):
                style = "class:selected" if begin <= n < end else (
                    "class:error" if any(s in line for s in ("Unknown", "Blocked", "Failed", "unavailable", "mismatch")) else
                    "class:good" if any(s in line for s in ("Current", "Updated", "Installed;")) else
                    "class:warning" if any(s in line for s in ("Update available", "Missing", "cached")) else "")
                if line.startswith("+"):
                    style = "class:border"
                output.append((style, line + "\n"))
            return output
        control = FormattedTextControl(fragments, focusable=True,
                     get_cursor_position=lambda: Point(0, lines()[1].get(self.ids[self.index], 0)))
        @kb.add("up")
        def up(event):
            self.index = max(0, self.index-1)
        @kb.add("down")
        def down(event):
            self.index = min(len(self.ids)-1, self.index+1)
        @kb.add(" ")
        def mark(event):
            id = self.ids[self.index]
            self.marked.symmetric_difference_update({id})
        for key, action in (("enter", "actions"), ("i", "inspect"), ("c", "check-selected"),
                            ("r", "refresh"), ("q", "exit"), ("escape", "exit"), ("c-c", "exit")):
            def handler(event, action=action):
                event.app.exit(result=action)
            kb.add(key)(handler)
        title = Window(FormattedTextControl(lambda: [("class:title", " APP UPDATER — Windows + Ubuntu\n"),
                                                      ("", clean(self.notice) + "\n")]), height=2)
        footer = Window(FormattedTextControl(" Up/down: tool   Space: mark   Enter: actions\n I: inspect   C: check marked   R: local refresh   Q: exit"), height=2)
        app = Application(layout=Layout(HSplit([title, Window(control, wrap_lines=False), footer])),
                          key_bindings=kb, full_screen=True,
                          style=Style.from_dict({"title": "ansicyan bold", "border": "ansibrightblack",
                              "selected": "reverse", "error": "ansired", "good": "ansigreen", "warning": "ansiyellow"}))
        action = app.run()
        return self.choose("Actions", self.actions()) if action == "actions" else action

    @staticmethod
    def actions():
        return [("inspect", "Inspect a tool"), ("check-selected", "Check latest for marked/current tool"),
                ("check-all", "Check latest for all tracked tools"), ("update", "Update selected installed tools"),
                ("install", "Install explicitly selected missing tools"), ("refresh", "Refresh local inventory"),
                ("mark", "Select tools"), ("discover", "Review discovered global packages"), ("exit", "Exit")]

    def run(self):
        from software_manager import make_plan, execute_plan, write_report
        self.scan()
        if not self.interactive:
            print(table_text(self.rows))
            print("Local-only report. Use --mode check-latest for explicit release discovery.")
            return
        while True:
            try:
                action = self.dashboard()
                if action == "exit":
                    print(table_text(self.rows))
                    print(self.notice)
                    return
                if action == "mark":
                    if self.rich:
                        from prompt_toolkit.shortcuts import checkboxlist_dialog
                        values = [(t["id"], t["name"]) for t in self.catalog["tools"]]
                        chosen = checkboxlist_dialog(title="Mark tools", values=values, default_values=list(self.marked)).run()
                        if chosen is not None:
                            self.marked = set(chosen)
                    else:
                        print("\n".join(t["id"] + ": " + t["name"] for t in self.catalog["tools"]))
                        ids = input("Tool IDs separated by commas: ").strip()
                        self.marked = set(ids.replace(" ", "").split(",")) & set(self.ids)
                elif action == "inspect":
                    id = self.ids[self.index] if self.rich else self.choose("Inspect tool", [(t["id"], t["name"]) for t in self.catalog["tools"]])
                    if id:
                        self.show("Installation details", detail_text([r for r in self.rows if r["id"] == id]))
                elif action in ("check-selected", "check-all"):
                    self.scan("check-latest", sorted(self.marked or {self.ids[self.index]}) if action == "check-selected" else ())
                    self.notice = "Release checks completed. Inspect a tool for source, timestamp, errors and cached-index limits."
                elif action == "refresh":
                    self.scan()
                    self.notice = "Local inventory refreshed. Previous release checks are history only."
                elif action == "discover":
                    data = self.scan("inventory")
                    self.notice = "Local inventory refreshed; discoveries require review before catalog adoption."
                    self.show("Global packages — review only", json.dumps(data["discoveries"], indent=2) +
                              "\nCandidates are not automatically added. Approve a catalog recipe before management.")
                elif action in ("update", "install"):
                    selected = self.select_installations(action)
                    if not selected:
                        continue
                    plan = make_plan(self.catalog, self.rows, selected, action)
                    self.show("Review the concrete plan", plan_text(plan))
                    if not any(p["status"] == "Ready" for p in plan):
                        self.notice = "Nothing ready. Inspect the plan blockers or Check latest first."
                        continue
                    if self.choose("Execute the reviewed plan?", [(False, "Cancel — make no changes"), (True, "Execute selected operations")]) is not True:
                        continue
                    data = execute_plan(self.catalog, plan)
                    self.scan()
                    for result in data["results"]:
                        row = next((r for r in self.rows if (r["host"], r["id"]) == (result["host"], result["id"])), None)
                        if row is not None:
                            row["operation"] = {k: v for k, v in result.items() if k not in ("evidence", "rechecked", "after_evidence", "target")}
                    self.notice = "Operation report: " + data["report"]
                    self.show("Results", "\n".join(f'{r["name"]} / {r["host"]}: {r["status"]}. {r.get("detail", "")}' for r in data["results"]))
            except (EOFError, KeyboardInterrupt):
                print("Cancelled. No further operations will start.")
                return
            except Exception as error:
                self.show("Action failed", str(error))
