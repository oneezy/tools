#!/usr/bin/env python3
"""Historical GitHub Brain reader. Current Brain operations use Drive.

Only --historical-read tree|agenda|find is enabled. The legacy implementation
below is retained for provenance; all GitHub writes are refused.

Everything runs through `gh api` REST calls; nothing else is required. No GraphQL
and no `gh issue`: cloud sessions block both. The brain lives in
one repo (default oneezy/brain) as a tree of issues: Brain > area > category >
entry. Categories are sub-issues of their area, entries are sub-issues of their
category. Every entry carries labels so the agenda is one label query.

Subcommands:
  tree                      print the area and category tree with counts
  remember                  create an entry under a category and read it back
  agenda                    rank open entries and print the report block
  find <text>               list open entries whose title contains text
  done <number> [--note]    close an entry
  trash <number>            close an entry with the comment "trashed"
  move <number> --area A --category C   re-file an entry
  update <number> [--list L] [--title T] [--body-file P]  revise an open entry

Always pass --json to get machine output; default output is Markdown.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

REPO = os.environ.get("BRAIN_REPO", "oneezy/brain")
ROOT_TITLE = "Brain"
AREAS = ("personal", "work", "ai")
LISTS = ("inbox", "next-action", "waiting-for", "someday-maybe", "reference", "calendar")
PRIORITIES = ("critical", "high", "medium", "low")
SUB_ISSUE_CAP = 100
DUE_RE = re.compile(r"^\s*Due:\s*(\d{4}-\d{2}-\d{2})", re.I | re.M)


def gh(*args: str, input_text: str | None = None) -> str:
    proc = subprocess.run(
        ["gh", *args], capture_output=True, text=True, encoding="utf-8", input=input_text
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise SystemExit(proc.returncode)
    return proc.stdout


def api(path: str, method: str = "GET", **fields) -> object:
    if method != "GET":
        raise SystemExit('Historical Brain access is read-only; GitHub writes are disabled.')
    args = ["api", "--method", "GET", "-H", "Accept: application/vnd.github+json", path]
    for key, value in fields.items():
        args += ["-F" if isinstance(value, int) else "-f", f"{key}={value}"]
    out = gh(*args)
    return json.loads(out) if out.strip() else None


def sub_issues(number: int) -> list[dict]:
    items: list[dict] = []
    page = 1
    while True:
        batch = api(f"repos/{REPO}/issues/{number}/sub_issues?per_page=100&page={page}")
        items.extend(batch or [])
        if not batch or len(batch) < 100:
            return items
        page += 1


def list_issues(query: str) -> list[dict]:
    """Every issue (pull requests dropped) matching a REST list query such as "labels=brain&state=open"."""
    items: list[dict] = []
    page = 1
    while True:
        batch = api(f"repos/{REPO}/issues?{query}&per_page=100&page={page}") or []
        items.extend(i for i in batch if "pull_request" not in i)
        if len(batch) < 100:
            return items
        page += 1


def issue_number(url: str | None) -> int | None:
    return int(url.rstrip("/").rsplit("/", 1)[-1]) if url else None


def close_issue(number: int, comment: str) -> None:
    api(f"repos/{REPO}/issues/{number}/comments", "POST", body=comment)
    api(f"repos/{REPO}/issues/{number}", "PATCH", state="closed", state_reason="completed")


def label_names(issue: dict) -> set[str]:
    return {lab["name"] if isinstance(lab, dict) else lab for lab in issue.get("labels", [])}


def find_root() -> dict:
    for issue in list_issues("labels=brain&state=open"):
        if issue["title"] == ROOT_TITLE and "category" not in label_names(issue):
            return issue
    raise SystemExit(f"No open issue titled {ROOT_TITLE!r} with label brain in {REPO}")


def load_tree() -> dict:
    """Return {area: {"number": n, "categories": {title: {"number": n, "count": c, "children": {...}}}}}."""
    root = find_root()
    tree: dict = {"root": root["number"], "areas": {}}
    for area in sub_issues(root["number"]):
        area_key = next((a for a in AREAS if a in label_names(area)), area["title"].lower())
        cats: dict = {}
        for cat in sub_issues(area["number"]):
            if cat["state"] != "open":
                continue
            entry = {"number": cat["number"], "count": cat.get("sub_issues_summary", {}).get("total", 0), "children": {}}
            if "category" in label_names(cat) and entry["count"] and cat["title"] in ("Clients",):
                for child in sub_issues(cat["number"]):
                    if "category" in label_names(child) and child["state"] == "open":
                        entry["children"][child["title"]] = {
                            "number": child["number"],
                            "count": child.get("sub_issues_summary", {}).get("total", 0),
                            "children": {},
                        }
            cats[cat["title"]] = entry
        tree["areas"][area_key] = {"number": area["number"], "title": area["title"], "categories": cats}
    return tree


def resolve_category(tree: dict, area: str, category: str) -> tuple[int, str]:
    """Find a category by title path ("Clients/Trident" or "Health"), case-insensitive.

    Returns (issue number, resolved title path). Opens "Title (2)" when the category is full.
    """
    area_node = tree["areas"].get(area)
    if not area_node:
        raise SystemExit(f"Unknown area {area!r}; areas are {', '.join(tree['areas'])}")
    parts = [p.strip() for p in category.split("/") if p.strip()]
    level = area_node["categories"]
    parent_number = area_node["number"]
    path: list[str] = []
    node = None
    for part in parts:
        match = next((t for t in level if t.lower() == part.lower()), None)
        if match is None:
            raise SystemExit(
                f"Unknown category {part!r} under {area}/{'/'.join(path) or '-'}; "
                f"choices: {', '.join(level)}"
            )
        node = level[match]
        path.append(match)
        parent_number = node["number"]
        level = node["children"]
    if node is None:
        raise SystemExit("Category path is empty")
    if node["count"] >= SUB_ISSUE_CAP:
        base = re.sub(r" \(\d+\)$", "", path[-1])
        n = 2
        while f"{base} ({n})" in (level or {}):
            n += 1
        title = f"{base} ({n})"
        area_label = area
        created = create_issue(title, f"Overflow of {path[-1]}; same category, more room.", ["brain", area_label, "category"])
        grandparent = tree["areas"][area]["number"] if len(path) == 1 else None
        if grandparent is None:
            grandparent = resolve_category(tree, area, "/".join(path[:-1]))[0]
        link(grandparent, created)
        return created, "/".join(path[:-1] + [title])
    return parent_number, "/".join(path)


def create_issue(title: str, body: str, labels: list[str]) -> int:
    out = gh("api", f"repos/{REPO}/issues", "--method", "POST", "--input", "-",
             input_text=json.dumps({"title": title, "body": body, "labels": labels}))
    return json.loads(out)["number"]


def link(parent: int, child: int) -> None:
    child_id = api(f"repos/{REPO}/issues/{child}")["id"]
    api(f"repos/{REPO}/issues/{parent}/sub_issues", "POST", sub_issue_id=child_id)


def unlink(parent: int, child: int) -> None:
    child_id = api(f"repos/{REPO}/issues/{child}")["id"]
    api(f"repos/{REPO}/issues/{parent}/sub_issue", "DELETE", sub_issue_id=child_id)


def open_entries() -> list[dict]:
    issues = list_issues("labels=brain&state=open")
    by_number = {i["number"]: i for i in issues}

    def parent_of(issue: dict | None) -> dict | None:
        number = issue_number((issue or {}).get("parent_issue_url"))
        if number is None:
            return None
        if number not in by_number:
            by_number[number] = api(f"repos/{REPO}/issues/{number}")
        return by_number[number]

    slim = []
    for issue in issues:
        parent = parent_of(issue)
        grand = parent_of(parent)
        slim.append({
            "number": issue["number"], "title": issue["title"], "body": issue.get("body"),
            "url": issue["html_url"], "createdAt": issue["created_at"], "updatedAt": issue["updated_at"],
            "labels": issue["labels"],
            "parent": {"title": parent["title"], "parent": {"title": grand["title"]} if grand else None} if parent else None,
        })
    issues = slim
    entries = []
    for issue in issues:
        issue["labels"] = [{"name": name} for name in sorted(label_names(issue))]
        names = label_names(issue)
        if "category" in names or issue["title"] == ROOT_TITLE:
            continue
        parent = issue.get("parent") or {}
        grand = parent.get("parent") or {}
        crumbs = [t for t in (grand.get("title"), parent.get("title")) if t and t not in ("Personal", "Work", "AI")]
        issue["where"] = "/".join(crumbs)
        issue["area"] = next((a for a in AREAS if a in names), None)
        issue["list"] = next((l for l in LISTS if l in names), "inbox")
        issue["priority"] = next((p for p in PRIORITIES if f"priority:{p}" in names), None)
        m = DUE_RE.search(issue.get("body") or "")
        issue["due"] = m.group(1) if m else None
        entries.append(issue)
    return entries


def rank(entry: dict, today: dt.date) -> tuple:
    due = dt.date.fromisoformat(entry["due"]) if entry["due"] else None
    days = (due - today).days if due else None
    if days is not None and days < 0:
        tier = 0
    elif days is not None and days <= 3:
        tier = 1
    elif entry["priority"] == "critical":
        tier = 2
    elif days is not None and days <= 14:
        tier = 3
    elif entry["priority"] == "high":
        tier = 4
    elif entry["list"] == "waiting-for":
        updated = dt.datetime.fromisoformat(entry["updatedAt"].replace("Z", "+00:00")).date()
        tier = 5 if (today - updated).days >= 14 else 7
    else:
        tier = 6 if entry["priority"] == "medium" else 8
    return (tier, days if days is not None else 10**6, PRIORITIES.index(entry["priority"]) if entry["priority"] else 9, entry["number"])


def fmt_line(entry: dict, today: dt.date) -> str:
    where = f"{entry['where']}: " if entry.get("where") else ""
    bits = [f"[#{entry['number']}]({entry['url']}) {where}{entry['title']}"]
    if entry["due"]:
        days = (dt.date.fromisoformat(entry["due"]) - today).days
        when = "past due" if days < 0 else ("due today" if days == 0 else f"due in {days} day{'s' if days != 1 else ''}")
        bits.append(f"{entry['due']}, {when}")
    tags = [entry["area"] or "?", entry["list"]] + ([f"priority:{entry['priority']}"] if entry["priority"] else [])
    return f"{', '.join(bits)} `{' '.join(tags)}`"


def cmd_tree(args) -> None:
    tree = load_tree()
    if args.json:
        print(json.dumps(tree, indent=2))
        return
    print(f"Brain #{tree['root']}")
    for area, node in tree["areas"].items():
        print(f"- {node['title']} #{node['number']}")
        for title, cat in node["categories"].items():
            print(f"  - {title} #{cat['number']} ({cat['count']})")
            for ctitle, child in cat["children"].items():
                print(f"    - {ctitle} #{child['number']} ({child['count']})")


def cmd_remember(args) -> None:
    tree = load_tree()
    area = args.area.lower()
    category = args.category or "Inbox"
    parent, path = resolve_category(tree, area, category)
    labels = ["brain", area, args.list]
    if args.priority:
        labels.append(f"priority:{args.priority}")
    body_lines = []
    if args.due:
        body_lines.append(f"Due: {args.due}")
        if args.list == "inbox":
            labels[2] = "calendar"
    if args.body:
        body_lines.append(args.body)
    stamp = dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z")
    body_lines.append(f"Captured {stamp} via {args.via or 'oneezy-brain'}.")
    number = create_issue(args.title, "\n\n".join(body_lines), labels)
    link(parent, number)
    issue = api(f"repos/{REPO}/issues/{number}")
    result = {
        "number": number, "url": issue["html_url"], "title": issue["title"],
        "filed_under": f"{tree['areas'][area]['title']}/{path}", "labels": sorted(label_names(issue)),
        "due": args.due,
    }
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Remembered [#{number}]({result['url']}) {result['title']} under {result['filed_under']} `{' '.join(result['labels'])}`")


def cmd_agenda(args) -> None:
    today = dt.date.today()
    entries = open_entries()
    if args.area:
        entries = [e for e in entries if e["area"] == args.area.lower()]
    entries.sort(key=lambda e: rank(e, today))
    if args.json:
        print(json.dumps(entries[: args.limit], indent=2, default=str))
        return
    urgent = [e for e in entries if rank(e, today)[0] <= 2][: args.limit]
    coming = [e for e in entries if rank(e, today)[0] in (3, 4) and e not in urgent][: args.limit]
    waiting = [e for e in entries if e["list"] == "waiting-for" and e not in urgent and e not in coming][:3]
    inbox = [e for e in entries if e["list"] == "inbox"]
    print(f"# Brain agenda {today.isoformat()}")
    print()
    print(f"### Do now ({len(urgent)})")
    print()
    print("\n".join(f"- {fmt_line(e, today)}" for e in urgent) or "- nothing past due or critical")
    print()
    print(f"### Coming up ({len(coming)})")
    print()
    print("\n".join(f"- {fmt_line(e, today)}" for e in coming) or "- nothing within two weeks")
    print()
    print(f"### Waiting on others ({len(waiting)})")
    print()
    print("\n".join(f"- {fmt_line(e, today)}" for e in waiting) or "- nothing")
    print()
    print(f"### Inbox ({len(inbox)} unclarified), open entries ({len(entries)})")


def cmd_find(args) -> None:
    needle = " ".join(args.text).lower()
    hits = [e for e in open_entries() if needle in e["title"].lower() or needle in (e.get("body") or "").lower()]
    if args.json:
        print(json.dumps(hits, indent=2, default=str))
        return
    today = dt.date.today()
    print("\n".join(f"- {fmt_line(e, today)}" for e in hits) or "no match")


def cmd_done(args) -> None:
    note = args.note or "done"
    close_issue(args.number, note)
    print(f"Closed #{args.number} ({note})")


def cmd_trash(args) -> None:
    close_issue(args.number, "trashed")
    print(f"Trashed #{args.number}")


def cmd_move(args) -> None:
    tree = load_tree()
    issue = api(f"repos/{REPO}/issues/{args.number}")
    old_parent = (issue.get("parent") or {}).get("number")
    new_parent, path = resolve_category(tree, args.area.lower(), args.category)
    if old_parent and old_parent != new_parent:
        unlink(old_parent, args.number)
    if old_parent != new_parent:
        link(new_parent, args.number)
    old_area = next((a for a in AREAS if a in label_names(issue)), None)
    if old_area and old_area != args.area.lower():
        api(f"repos/{REPO}/issues/{args.number}/labels/{old_area}", "DELETE")
        gh("api", f"repos/{REPO}/issues/{args.number}/labels", "--method", "POST", "--input", "-",
           input_text=json.dumps({"labels": [args.area.lower()]}))
    print(f"Moved #{args.number} to {tree['areas'][args.area.lower()]['title']}/{path}")


def cmd_update(args) -> None:
    """Revise one existing entry, preserving every label outside the GTD list."""
    if not any((args.list, args.title is not None, args.body_file is not None)):
        raise SystemExit("Specify --list, --title, or --body-file")
    issue = api(f"repos/{REPO}/issues/{args.number}")
    names = label_names(issue)
    current_lists = names.intersection(LISTS)
    if (issue.get("state") != "open" or "brain" not in names or "category" in names
            or any(name.startswith("wayfinder:") for name in names)
            or sum(area in names for area in AREAS) != 1
            or len(current_lists) != 1
            or issue.get("title", "").lower() in (ROOT_TITLE.lower(), *AREAS)):
        raise SystemExit(f"#{args.number} is not an open Brain entry with one area and one GTD list")
    if args.expect_updated_at and issue.get("updated_at") != args.expect_updated_at:
        raise SystemExit(f"#{args.number} changed since it was read; inspect it again before updating")

    changes: dict = {}
    if args.list and args.list not in current_lists:
        changes["labels"] = sorted((names - current_lists) | {args.list})
    if args.title is not None:
        title = args.title.strip()
        if not title or "\n" in title or "\r" in title:
            raise SystemExit("--title must be one nonempty line")
        if title != issue["title"]:
            changes["title"] = title
    if args.body_file is not None:
        body = Path(args.body_file).read_text(encoding="utf-8").strip()
        if not body:
            raise SystemExit("--body-file must contain a nonempty body")
        if body != (issue.get("body") or "").strip():
            changes["body"] = body
    if not changes:
        raise SystemExit(f"#{args.number} already has the requested values; no update made")

    gh("api", f"repos/{REPO}/issues/{args.number}", "--method", "PATCH", "--input", "-",
       input_text=json.dumps(changes))
    updated = api(f"repos/{REPO}/issues/{args.number}")
    for field in ("title", "body"):
        if field in changes and updated.get(field) != changes[field]:
            raise SystemExit(f"#{args.number} was patched but {field} did not verify; inspect it")
    if "labels" in changes and label_names(updated) != set(changes["labels"]):
        raise SystemExit(f"#{args.number} was patched but labels did not verify; inspect it")
    if updated.get("state") != "open":
        raise SystemExit(f"#{args.number} was patched but is no longer open; inspect it")
    result = {
        "number": updated["number"], "url": updated["html_url"], "title": updated["title"],
        "state": updated["state"], "labels": sorted(label_names(updated)),
        "due": (DUE_RE.search(updated.get("body") or "") or [None, None])[1],
        "body": updated.get("body") or "",
    }
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Updated [#{result['number']}]({result['url']}) {result['title']} `{' '.join(result['labels'])}`")


def main(argv: list[str] | None = None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv.pop(0) != '--historical-read' or not argv or argv[0] not in {'tree', 'agenda', 'find'}:
        raise SystemExit('GitHub Brain routing is retired. Use oneezy-brain for current Drive state. Explicit historical reads: brain.py --historical-read tree|agenda|find. Writes are disabled.')
    parser = argparse.ArgumentParser(prog="brain.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("tree"); p.add_argument("--json", action="store_true"); p.set_defaults(fn=cmd_tree)

    p = sub.add_parser("remember")
    p.add_argument("--area", required=True, choices=AREAS)
    p.add_argument("--category", help='category title, or a path like "Clients/Trident"; default Inbox')
    p.add_argument("--title", required=True)
    p.add_argument("--body")
    p.add_argument("--list", default="inbox", choices=LISTS)
    p.add_argument("--priority", choices=PRIORITIES)
    p.add_argument("--due", help="YYYY-MM-DD; switches an inbox entry to calendar")
    p.add_argument("--via", help="harness or channel name for the capture stamp")
    p.add_argument("--json", action="store_true"); p.set_defaults(fn=cmd_remember)

    p = sub.add_parser("agenda"); p.add_argument("--area", choices=AREAS); p.add_argument("--limit", type=int, default=5)
    p.add_argument("--json", action="store_true"); p.set_defaults(fn=cmd_agenda)

    p = sub.add_parser("find"); p.add_argument("text", nargs="+"); p.add_argument("--json", action="store_true"); p.set_defaults(fn=cmd_find)
    p = sub.add_parser("done"); p.add_argument("number", type=int); p.add_argument("--note"); p.set_defaults(fn=cmd_done)
    p = sub.add_parser("trash"); p.add_argument("number", type=int); p.set_defaults(fn=cmd_trash)
    p = sub.add_parser("move"); p.add_argument("number", type=int); p.add_argument("--area", required=True, choices=AREAS)
    p.add_argument("--category", required=True); p.set_defaults(fn=cmd_move)
    p = sub.add_parser("update"); p.add_argument("number", type=int); p.add_argument("--list", choices=LISTS)
    p.add_argument("--title"); p.add_argument("--body-file", help="UTF-8 file with the complete revised body")
    p.add_argument("--expect-updated-at", help="refuse if the issue changed since this GitHub timestamp")
    p.add_argument("--json", action="store_true"); p.set_defaults(fn=cmd_update)

    args = parser.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
