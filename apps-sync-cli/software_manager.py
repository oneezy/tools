"""Manual Windows/Ubuntu software manager. Launch and local inspection are offline."""
from __future__ import annotations
import argparse
import contextlib
from copy import deepcopy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import uuid
from updater_inventory import Snapshot, HOST, WINDOWS, stamp, expand, read_json, extract_version

ROOT = Path(__file__).resolve().parent
FAILURES = {"Failed", "Unknown", "Environment mismatch", "WSL unavailable", "Needs attention", "Cancelled", "Latest check failed"}


def load_catalog():
    catalog = read_json(ROOT / "software-catalog.json")
    ids = [t["id"] for t in catalog["tools"]]
    if len(ids) != len(set(ids)):
        raise ValueError("Catalog IDs must be unique")
    if not catalog["wslDistro"].startswith("Ubuntu"):
        raise ValueError("Only an explicitly configured Ubuntu workstation is supported")
    return catalog


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def history_key(tool, recipe, host=HOST):
    return json.dumps([host, tool["id"], recipe["provider"], recipe.get("channel", "stable"),
                       recipe.get("source", tool["source"])], sort_keys=True)


def read_history(host=HOST):
    try:
        data = read_json(ROOT / "logs" / ("release-history-" + host + ".json"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def version_key(value):
    value = extract_version(value)
    base, _, pre = value.partition("-")
    nums = tuple(int(p) for p in base.split("."))
    identifiers = tuple((0, int(p)) if p.isdigit() else (1, p) for p in pre.split(".")) if pre else ()
    return nums + (0,) * (4 - len(nums)) + (0 if pre else 1, identifiers)


def compare(a, b, source):
    if source["kind"] == "apt":
        for op, value in (("eq", 0), ("gt", 1), ("lt", -1)):
            result = subprocess.run(["/usr/bin/dpkg", "--compare-versions", a, op, b],
                                    capture_output=True, timeout=5)
            if result.returncode == 0:
                return value
            if result.returncode != 1:
                raise ValueError("Invalid Debian version comparison")
        raise ValueError("Could not compare Debian versions")
    ka, kb = version_key(a), version_key(b)
    return (ka > kb) - (ka < kb)


class ReleaseClient:
    """Constructed only by an explicit check-latest action."""
    def __init__(self, responses=None):
        self.cache = dict(responses or {})

    def get(self, url, raw=False):
        if not url.startswith("https://"):
            raise ValueError("Release discovery requires HTTPS")
        if url not in self.cache:
            request = urllib.request.Request(url, headers={"User-Agent": "Personal-App-Updater/2", "Cache-Control": "no-cache"})
            with urllib.request.urlopen(request, timeout=20) as response:
                if not response.url.startswith("https://"):
                    raise ValueError("Release redirected away from HTTPS")
                self.cache[url] = response.read(8 * 1024 * 1024).decode("utf-8")
        return self.cache[url] if raw else json.loads(self.cache[url])

    def check(self, tool, recipe):
        source = recipe.get("source", tool["source"])
        result = dict(source=source, checked_at=stamp(), channel=source.get("channel", recipe.get("channel", "stable")),
                      scope="publisher", fresh=True, metadata={})
        kind = source["kind"]
        if kind == "manual":
            raise ValueError("No verified release-discovery route; inspect manual guidance")
        if kind == "apt":
            output = subprocess.run(["/usr/bin/apt-cache", "policy", source["package"]], capture_output=True,
                                    text=True, timeout=10, env=dict(os.environ, LC_ALL="C"))
            match = re.search(r"Candidate:\s*(\S+)", output.stdout)
            if output.returncode or not match or match[1] == "(none)":
                raise ValueError("No APT candidate in local indexes")
            files = list(Path("/var/lib/apt/lists").glob("*InRelease"))
            result.update(version=match[1], scope="APT cached indexes", fresh=False,
                          index_times={p.name: dt.datetime.fromtimestamp(p.stat().st_mtime, dt.timezone.utc).isoformat() for p in files},
                          limitation="Indexes were not refreshed. This is not freshly verified repository or publisher latest.")
        elif kind == "winget":
            output = subprocess.run(["winget", "show", "--exact", "--id", source["id"], "--source", "winget",
                                     "--accept-source-agreements", "--disable-interactivity"],
                                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45)
            match = re.search(r"^Version:\s*(\S+)", output.stdout, re.M)
            if output.returncode or not match:
                raise ValueError("WinGet check failed or output is not English: " + output.stderr[-400:])
            result.update(version=extract_version(match[1]), scope="WinGet catalog",
                          limitation="Publisher latest was not independently checked.")
        else:
            data = self.get(source["url"], raw=kind == "text")
            value = data
            if kind != "text":
                for part in source.get("field", "version").split("."):
                    value = value[part]
                result["metadata"] = data
            result["version"] = extract_version(value)
        return result


def attach_release(row, release):
    row["release"] = release
    if row["status"] == "Blocked / manual attention" or row["state"] in ("unknown", "mismatch"):
        return row
    if row["state"] == "missing":
        row["status"] = "Missing"
    elif not release["fresh"]:
        row["status"] = "Cached candidate / inspect"
    else:
        order = compare(row["installed"], release["version"], release["source"])
        row["status"] = "Update available" if order < 0 else "Newer installed" if order > 0 else (
            "Catalog current" if release["scope"] == "WinGet catalog" else "Current")
    return row


def local_scan(catalog, mode="check", only=(), responses=None):
    snapshot, history = Snapshot(catalog), read_history()
    client = ReleaseClient(responses) if mode == "check-latest" else None
    rows = []
    for tool in catalog["tools"]:
        if only and tool["id"] not in only:
            continue
        row, recipe = snapshot.detect(tool), tool["hosts"].get(HOST)
        if recipe:
            identity = history_key(tool, recipe)
            row["history"] = history.get(identity)
            if client:
                try:
                    release = client.check(tool, recipe)
                    attach_release(row, release)
                    history[identity] = release
                except Exception as error:
                    row["release_error"] = str(error)
                    if row["status"] != "Blocked / manual attention":
                        row["status"] = "Latest check failed"
        rows.append(row)
    if client:
        atomic_json(ROOT / "logs" / ("release-history-" + HOST + ".json"), history)
    data = dict(timestamp=stamp(), host=HOST, rows=rows)
    if client:
        data["_responses"] = client.cache
    if mode == "inventory":
        data["discovery"] = snapshot.discoveries()
    return data


def bridge_args(catalog):
    if not catalog["wslDistro"].startswith("Ubuntu"):
        raise ValueError("Only the configured Ubuntu workstation can be inspected")
    return ["wsl.exe", "-d", catalog["wslDistro"], "--cd", "~", "--exec"]


def wsl_path(catalog, path):
    result = subprocess.run(bridge_args(catalog) + ["wslpath", "-a", str(path)],
                            capture_output=True, text=True, timeout=8)
    if result.returncode:
        raise ValueError(result.stderr.strip() or "Could not translate project path")
    return result.stdout.strip()


def unavailable_rows(catalog, host, status, only=(), detail=""):
    return [dict(id=t["id"], name=t["name"], host=host, installed=None, path=None,
                 state="unavailable" if host in t["hosts"] else "not-applicable",
                 status=status if host in t["hosts"] else "Platform not applicable", detail=detail,
                 release=None, history=None)
            for t in catalog["tools"] if not only or t["id"] in only]


def wsl_scan(catalog, mode, only=(), responses=None):
    try:
        args = bridge_args(catalog) + ["/usr/bin/python3", "-B", wsl_path(catalog, ROOT / "software_manager.py"),
                                      "--worker", "--mode", mode, "--only", ",".join(only)]
        output = subprocess.run(args, input=json.dumps({"responses": responses or {}}),
                                capture_output=True, text=True, encoding="utf-8",
                                errors="replace", timeout=45 if mode != "check-latest" else 600)
        if output.returncode:
            raise ValueError(output.stderr[-1000:] or "Ubuntu worker failed")
        return json.loads(output.stdout)
    except Exception as error:
        return dict(host="wsl", rows=unavailable_rows(catalog, "wsl", "WSL unavailable", only, str(error)))


def collect(catalog, mode="check", target="all", only=()):
    unknown = set(only) - {t["id"] for t in catalog["tools"]}
    if unknown:
        raise ValueError("Unknown tools: " + ", ".join(sorted(unknown)))
    data = dict(timestamp=stamp(), mode=mode, rows=[], discoveries={})
    if WINDOWS and mode == "check-latest" and target == "all":
        # Share this explicit check's successful HTTP responses across environments.
        # APT/WinGet checks remain environment-specific. Disk history is never a seed.
        local = local_scan(catalog, mode, only)
        remote = wsl_scan(catalog, mode, only, local.get("_responses"))
        data["rows"] = local["rows"] + remote["rows"]
        return data
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {}
        for host in ("windows", "wsl"):
            if target not in ("all", host) or (not WINDOWS and host == "windows"):
                data["rows"].extend(unavailable_rows(catalog, host, "Not inspected", only))
            else:
                futures[host] = pool.submit(local_scan if host == HOST else wsl_scan, catalog, mode, only)
        for host, future in futures.items():
            try:
                result = future.result()
                data["rows"].extend(result["rows"])
                if "discovery" in result:
                    data["discoveries"][host] = result["discovery"]
            except Exception as error:
                data["rows"].extend(unavailable_rows(catalog, host, "Unknown", only, str(error)))
    return data


def catalog_digest(catalog):
    return hashlib.sha256(json.dumps(catalog, sort_keys=True).encode()).hexdigest()


def find_tool(catalog, id):
    return next(t for t in catalog["tools"] if t["id"] == id)


def asset_for(tool, recipe, release):
    data = release["metadata"]
    if recipe.get("asset"):
        matches = [a for a in data.get("assets", []) if re.fullmatch(recipe["asset"], a["name"])]
        if len(matches) != 1:
            raise ValueError("Release must contain exactly one matching installer")
        asset = matches[0]
        digest = asset.get("digest", "")
        if not re.fullmatch(r"sha256:[a-fA-F0-9]{64}", digest):
            raise ValueError("Publisher SHA-256 digest missing; automatic installation blocked")
        url, checksum, name = asset["browser_download_url"], digest.split(":")[1], asset["name"]
    else:
        url = data[recipe["urlField"]]
        checksum = data.get(recipe.get("hashField", "sha256hash"))
        name = Path(urllib.parse.urlparse(url).path).name
        if not checksum and not recipe.get("signer"):
            raise ValueError("No checksum or expected signer")
    if not url.startswith("https://") or Path(name).name != name or not name:
        raise ValueError("Invalid publisher installer URL/name")
    return dict(url=url, sha256=checksum, filename=name, signer=recipe.get("signer", ""))


def build_commands(tool, recipe, row, release, action):
    wanted, provider = release["version"], recipe["provider"]
    missing = row["state"] == "missing"
    result = dict(commands=[], downloads=[], limitations=[], elevation=False, restart="Never requested automatically")
    if provider == "native":
        if missing:
            url = recipe.get("installUrl")
            if not url:
                raise ValueError("No reviewed installation route")
            name = "install.ps1" if WINDOWS else "install.sh"
            result["downloads"] = [dict(url=url, filename=name, sha256=None, signer="")]
            result["commands"] = [["pwsh", "-NoProfile", "-File", "{download}/" + name] if WINDOWS else ["/bin/bash", "{download}/" + name]]
            result["commands"][0] += [a.replace("{version}", wanted) for a in recipe.get("installArgs", [])]
            result["limitations"].append("Publisher bootstrap may discover/download a newer release; target is a minimum.")
        else:
            result["commands"] = [[row["path"]] + [a.replace("{version}", wanted) for a in recipe["updateArgs"]]]
            result["limitations"].append("Native vendor updater may contact release services and stage replacement.")
    elif provider in ("vp-global", "npm-global", "pnpm"):
        config = Snapshot({"tools": []}).config()
        node = config.get("defaultNodeVersion")
        if not node:
            raise ValueError("No explicit Vite Node default; refusing on-demand runtime resolution")
        runtime = Path.home() / ".vite-plus/js_runtime/node" / node
        node_exe = runtime / ("node.exe" if WINDOWS else "bin/node")
        if not node_exe.is_file():
            raise ValueError("Configured Node runtime is not installed")
        result["environment"] = {"VP_NODE_VERSION": node}
        if provider == "pnpm":
            manager = str(expand(recipe["vp"]))
            result["commands"] = [[manager, "env", "install", "pnpm@" + wanted], [manager, "env", "default", "pnpm@" + wanted]]
        elif provider == "vp-global":
            result["commands"] = [[str(expand(recipe["managerPath"])), "install", "-g", tool["package"] + "@" + wanted]]
            result["limitations"].append("Vite Plus retains ownership. Package lifecycle scripts may run.")
        else:
            npm_version = (config.get("defaultPackageManagerVersions") or {}).get("npm")
            npm = (Path.home() / ".vite-plus/package_manager/npm" / npm_version / "npm/bin/npm-cli.js"
                   if npm_version else runtime / ("node_modules/npm/bin/npm-cli.js" if WINDOWS else "lib/node_modules/npm/bin/npm-cli.js"))
            if not npm.is_file():
                raise ValueError("Pinned npm runtime unavailable; no shim will be invoked")
            prefix = row.get("prefix") or str(runtime)
            result["commands"] = [[str(node_exe), str(npm), "install", "--global", "--prefix", prefix,
                                   "--no-audit", "--no-fund", tool["package"] + "@" + wanted]]
    elif provider == "apt":
        result["commands"] = [["sudo", "apt-get", "install"] + ([] if missing else ["--only-upgrade"]) +
                              ["--no-remove", recipe["package"] + "=" + wanted]]
        result["elevation"] = True
        result["limitations"].append("Exact cached APT candidate; dependencies may be needed. APT shows its transaction before confirmation.")
    elif provider == "winget":
        result["commands"] = [["winget", "install" if missing else "upgrade", "--exact", "--id", recipe["id"],
                               "--version", wanted, "--source", "winget", "--interactive",
                               "--accept-source-agreements", "--accept-package-agreements"]]
        if recipe.get("scope"):
            result["commands"][0] += ["--scope", recipe["scope"]]
        result["limitations"].append("WinGet discovers metadata during execution; publisher freshness is unverified.")
    elif provider == "publisher":
        asset = asset_for(tool, recipe, release)
        result["downloads"] = [asset]
        result["commands"] = [["pwsh", "-NoProfile", "-File", str(ROOT / "Run-Installer.ps1"),
                              "-Installer", "{download}/" + asset["filename"], "-ExpectedSigner", asset["signer"],
                              "-ResultPath", "{download}/installer-result.json",
                              "-InstallerArgumentsJson", json.dumps(recipe.get("installerArgs", []))]]
        result["elevation"] = row.get("scope", recipe.get("scope")) == "machine"
        result["limitations"].append("Interactive setup may request elevation or app closure. No process is force-closed.")
    else:
        raise ValueError(recipe.get("note", "Manual update required"))
    return result


def plan_local(catalog, selections, action, releases):
    snapshot, plan = Snapshot(catalog), []
    for id in selections:
        tool = find_tool(catalog, id)
        recipe, row = tool["hosts"].get(HOST), snapshot.detect(tool)
        item = dict(id=id, name=tool["name"], host=HOST, action=action, before=row.get("installed"),
                    identity=row.get("identity"), evidence=row, status="Blocked", detail="",
                    target=releases.get(id), catalog_digest=catalog_digest(catalog), planned_at=stamp())
        try:
            if not recipe:
                raise ValueError("Platform not applicable")
            if recipe.get("hold") or recipe["provider"] == "manual":
                raise ValueError(recipe.get("note", "Manual attention needed"))
            if row["state"] not in ("installed", "missing"):
                raise ValueError(row["detail"] or row["status"])
            if action == "update" and row["state"] == "missing":
                item.update(status="Skipped", detail="Missing installation: update never installs")
            elif action == "install" and row["state"] != "missing":
                item.update(status="Skipped", detail="Already installed: select Update instead")
            elif not item["target"]:
                raise ValueError("Check latest first; no selected target")
            elif row.get("installed") and compare(row["installed"], item["target"]["version"], item["target"]["source"]) >= 0:
                item.update(status="Skipped", detail="Installed version meets or exceeds selected target")
            elif recipe.get("scope") and row.get("scope") and recipe["scope"] != row["scope"]:
                raise ValueError("Installation scope differs from recipe; migration must be reviewed")
            else:
                item.update(build_commands(tool, recipe, row, item["target"], action), status="Ready")
        except Exception as error:
            item["detail"] = str(error)
        plan.append(item)
    return plan


def wsl_rpc(catalog, mode, payload):
    args = bridge_args(catalog) + ["/usr/bin/python3", "-B", wsl_path(catalog, ROOT / "software_manager.py"),
                                  "--worker", "--mode", mode]
    result = subprocess.run(args, input=json.dumps(payload), capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=45)
    if result.returncode:
        raise ValueError(result.stderr[-1000:])
    return json.loads(result.stdout)


def make_plan(catalog, rows, selections, action):
    plan = []
    for host in ("windows", "wsl"):
        ids = [id for h, id in selections if h == host]
        if not ids:
            continue
        releases = {r["id"]: r.get("release") for r in rows if r["host"] == host}
        try:
            if host == HOST:
                items = plan_local(catalog, ids, action, releases)
            elif WINDOWS:
                items = wsl_rpc(catalog, "plan", dict(selections=ids, action=action, releases=releases))
            else:
                raise ValueError("Manage Windows installations from Windows")
            plan.extend(items)
        except Exception as error:
            plan.extend(dict(id=id, host=host, name=find_tool(catalog, id)["name"], status="Blocked",
                             detail=str(error), action=action) for id in ids)
    return plan


@contextlib.contextmanager
def lock():
    path = ROOT / (".operation-windows.lock" if WINDOWS else ".operation-wsl.lock")
    with path.open("a+b") as handle:
        handle.seek(0)
        if WINDOWS:
            import msvcrt
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise RuntimeError("Another update is in progress") from error
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def fetch_asset(asset, folder):
    url, name = asset["url"], asset["filename"]
    if not url.startswith("https://") or Path(name).name != name:
        raise ValueError("Unsafe download URL or filename")
    target = Path(folder) / name
    digest = hashlib.sha256()
    request = urllib.request.Request(url, headers={"User-Agent": "Personal-App-Updater/2"})
    with urllib.request.urlopen(request, timeout=60) as response, target.open("wb") as output:
        if not response.url.startswith("https://"):
            raise ValueError("Download redirected away from HTTPS")
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            digest.update(chunk)
    if asset.get("sha256") and digest.hexdigest().lower() != asset["sha256"].lower():
        raise ValueError("SHA-256 mismatch; installer not executed")
    return target


def execute_item(item):
    env = dict(os.environ)
    for key in ("VP_NODE_VERSION", "VP_PNPM_VERSION", "VP_PACKAGE_MANAGER"):
        env.pop(key, None)
    env.update(item.get("environment", {}))
    result = dict(exit_codes=[], restart_required=False, deferred=False)
    with tempfile.TemporaryDirectory(prefix="app-updater-") as folder:
        for asset in item.get("downloads", []):
            fetch_asset(asset, folder)
        for command in item["commands"]:
            args = [arg.replace("{download}", folder) for arg in command]
            print("Running: " + subprocess.list2cmdline(args), flush=True)
            process = subprocess.run(args, cwd=Path.home(), env=env)
            result["exit_codes"].append(process.returncode)
            outcome = Path(folder) / "installer-result.json"
            if outcome.exists():
                result.update(read_json(outcome))
            if process.returncode:
                result["error"] = "Command exited " + str(process.returncode)
                break
    return result


def runtime_state():
    path = Path.home() / ".vite-plus/config.json"
    if not path.exists():
        return None
    config = read_json(path)
    return {k: config.get(k) for k in ("defaultNodeVersion", "defaultPackageManagerVersions")}


def verify_after(catalog, tool):
    row = Snapshot(catalog).detect(tool)
    recipe = tool["hosts"][HOST]
    args = None
    if row["state"] == "installed" and recipe.get("verifyArgs"):
        args = [row.get("resolved_path") or row["path"]] + recipe["verifyArgs"]
    if row["state"] == "installed" and recipe["provider"] == "pnpm":
        root = Path.home() / ".vite-plus/package_manager/pnpm" / row["installed"] / "pnpm/bin"
        native = root / ("pnpm.native.exe" if WINDOWS else "pnpm")
        if native.is_file():
            args = [str(native), "--version"]  # Physical package executable, never the Vite shim.
    if args:
        output = subprocess.run(args, cwd=Path.home(), capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=15)
        if output.returncode:
            raise ValueError("Post-update version probe failed: " + output.stderr[-400:])
        row["installed"] = extract_version(output.stdout)
        row["verification"] = "Actual executable --version after explicit operation"
    return row


def write_report(data, label="operation", path=None):
    path = Path(path) if path else ROOT / "logs" / (dt.datetime.now().strftime("%Y%m%d-%H%M%S-") + label + "-" + uuid.uuid4().hex[:8] + ".json")
    atomic_json(path, data)
    lines = [label.upper(), "Timestamp: " + data.get("timestamp", stamp())]
    for item in data.get("results", []):
        lines += ["", f'{item["host"]} / {item.get("name", item["id"])}: {item["status"]}',
                  f'Before: {item.get("before")} | Target: {(item.get("target") or {}).get("version")} | After: {item.get("after")}',
                  "Detail: " + item.get("detail", ""), "Restart required: " + str(item.get("restart_required", False))]
        lines += ["Command: " + subprocess.list2cmdline(c) for c in item.get("commands", [])]
    if "rows" in data:
        from updater_ui import table_text
        lines += [table_text(data["rows"], 150)]
    path.with_suffix(".log").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def execute_local(catalog, plan, report_path=None):
    results, cancelled = [], False
    data = dict(timestamp=stamp(), results=results)
    report_path = report_path or ROOT / "logs" / ("operation-" + HOST + "-" + uuid.uuid4().hex + ".json")
    with lock():
        for original in plan:
            item = deepcopy(original)
            results.append(item)
            attempted = False
            try:
                if cancelled:
                    item.update(status="Skipped", detail="Previous operation cancelled")
                    continue
                if item["status"] != "Ready":
                    continue
                if item["host"] != HOST or item["catalog_digest"] != catalog_digest(catalog):
                    raise ValueError("Environment or catalog changed; create a new plan")
                catalog_path = ROOT / "software-catalog.json"
                if catalog_path.exists() and catalog_digest(read_json(catalog_path)) != item["catalog_digest"]:
                    raise ValueError("Catalog file changed after planning; review a new plan")
                tool, target = find_tool(catalog, item["id"]), item["target"]
                recipe = tool["hosts"][HOST]
                fresh = Snapshot(catalog).detect(tool)
                item["rechecked"] = fresh
                if fresh["state"] == "installed" and compare(fresh["installed"], target["version"], target["source"]) >= 0:
                    item.update(status="Skipped", detail="Recheck: selected target already met", after=fresh["installed"])
                    continue
                if item["action"] == "update" and fresh["state"] == "missing":
                    item.update(status="Skipped", detail="Installation disappeared; update will not install", after=None)
                    continue
                if fresh.get("identity") != item["identity"] or fresh["state"] != item["evidence"]["state"]:
                    raise ValueError("Installation owner, path, runtime, or presence changed; review a new plan")
                current = build_commands(tool, recipe, fresh, target, item["action"])
                for field in ("commands", "downloads", "environment"):
                    if current.get(field) != item.get(field):
                        raise ValueError("Execution recipe changed; review a new plan")
                attempted = True
                item["status"] = "Running"
                item["runtime_before"] = runtime_state()
                write_report(data, path=report_path)
                item.update(execute_item(item))
                item.update(status="Cancelled" if item.get("cancelled") else "Failed" if item.get("error") else "Needs attention",
                            detail=item.get("error") or "")
                cancelled = item["status"] == "Cancelled"
            except KeyboardInterrupt:
                cancelled = True
                item.update(status="Cancelled", detail="Interrupted. Installer may still be completing; inspect before retrying.")
            except Exception as error:
                item.update(status="Failed", detail=str(error))
            finally:
                if attempted:
                    try:
                        after = verify_after(catalog, find_tool(catalog, item["id"]))
                        item.update(after=after.get("installed"), after_evidence=after)
                        if item["status"] not in ("Cancelled", "Failed"):
                            if after["state"] == "installed" and compare(after["installed"], item["target"]["version"], item["target"]["source"]) >= 0:
                                item["status"] = "Installed" if item["action"] == "install" else "Updated"
                            else:
                                item.update(status="Needs attention", deferred=True, detail="Selected version not detected. Replacement may be deferred, cancelled, or require app closure/restart.")
                    except Exception as error:
                        item.update(status="Needs attention", detail="Post-operation detection failed: " + str(error))
                    try:
                        item["runtime_after"] = runtime_state()
                        before_runtime, after_runtime = deepcopy(item.get("runtime_before")), deepcopy(item["runtime_after"])
                        if item["id"] == "pnpm":
                            for value in (before_runtime, after_runtime):
                                if value and value.get("defaultPackageManagerVersions"):
                                    value["defaultPackageManagerVersions"].pop("pnpm", None)
                        if before_runtime != after_runtime:
                            item["runtime_changed"] = True
                            item["status"] = "Needs attention"
                            item["detail"] += " Vendor operation changed runtime defaults unexpectedly; inspect the report. No automatic rollback."
                    except Exception as error:
                        item["runtime_check_error"] = str(error)
                write_report(data, path=report_path)
    return data


def execute_plan(catalog, plan):
    results, cancelled = [], False
    for host in ("windows", "wsl"):
        items = [p for p in plan if p["host"] == host]
        if not items:
            continue
        if cancelled:
            results.extend(dict(p, status="Skipped", detail="Previous operation cancelled") for p in items)
            continue
        report_path = None
        try:
            if host == HOST:
                data = execute_local(catalog, items)
            else:
                token = uuid.uuid4().hex
                plan_path, report_path = ROOT / "logs" / ("wsl-plan-" + token + ".json"), ROOT / "logs" / ("wsl-result-" + token + ".json")
                atomic_json(plan_path, items)
                args = bridge_args(catalog) + ["/usr/bin/python3", "-B", wsl_path(catalog, ROOT / "software_manager.py"),
                        "--worker", "--mode", "execute", "--plan", wsl_path(catalog, plan_path),
                        "--result", wsl_path(catalog, report_path)]
                completed = subprocess.run(args)
                data = read_json(report_path)
                data["results"] = reconcile_worker(items, data.get("results", []), completed.returncode)
            results.extend(data["results"])
            cancelled = any(r["status"] == "Cancelled" for r in data["results"])
        except (Exception, KeyboardInterrupt) as error:
            partial = []
            if report_path and report_path.exists():
                try:
                    partial = read_json(report_path).get("results", [])
                except (OSError, ValueError):
                    pass
            results.extend(reconcile_worker(items, partial, 1, str(error)))
            cancelled = isinstance(error, KeyboardInterrupt)
    data = dict(timestamp=stamp(), results=results)
    data["report"] = str(write_report(data))
    return data


def reconcile_worker(plan, results, exit_code, error=""):
    """A crashed/unavailable worker must not erase completed or unstarted entries."""
    completed = {(r["host"], r["id"]): r for r in results}
    output = []
    for item in plan:
        row = deepcopy(completed.get((item["host"], item["id"])))
        if row is None:
            row = dict(item, status="Needs attention", detail="No worker result; execution could not be verified. Inspect before retrying.")
        elif row["status"] in ("Running", "Ready"):
            row.update(status="Needs attention", detail="Worker ended without verification; an installer may still be completing.")
        if exit_code or error:
            row["worker_error"] = error or "Worker exited " + str(exit_code)
        output.append(row)
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["menu", "check", "inventory", "check-latest", "update", "install", "plan", "execute"], default="menu")
    parser.add_argument("--target", choices=["all", "windows", "wsl"], default="all" if WINDOWS else "wsl")
    parser.add_argument("--only", default="")
    parser.add_argument("--plain", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--result", type=Path)
    args = parser.parse_args(argv)
    catalog = load_catalog()
    only = [s.strip() for s in args.only.split(",") if s.strip()]
    if args.worker:
        if WINDOWS:
            raise ValueError("Worker mode is Ubuntu-only")
        if args.mode == "plan":
            request = json.load(sys.stdin)
            data = plan_local(catalog, request["selections"], request["action"], request["releases"])
        elif args.mode == "execute" and args.plan and args.result:
            data = execute_local(catalog, read_json(args.plan), args.result)
        elif args.mode in ("check", "check-latest", "inventory"):
            request = json.load(sys.stdin) if args.mode == "check-latest" else {}
            data = local_scan(catalog, args.mode, only, request.get("responses"))
            data.pop("_responses", None)
        else:
            raise ValueError("Invalid worker operation")
        print(json.dumps(data))
        return 0
    from updater_ui import ManagerUI, table_text, plan_text
    if args.mode == "menu":
        ManagerUI(catalog, plain=args.plain, target=args.target).run()
        return 0
    if args.mode in ("plan", "execute"):
        raise ValueError("Internal worker modes are not public execution shortcuts")
    if args.mode in ("update", "install"):
        if not only:
            raise ValueError("Select explicit tool IDs with --only")
        data = collect(catalog, "check", args.target, only)
        for row in data["rows"]:
            row["release"] = row.get("history")
        selections = [(r["host"], r["id"]) for r in data["rows"] if r["host"] in
                      (["windows", "wsl"] if args.target == "all" else [args.target])]
        plan = make_plan(catalog, data["rows"], selections, args.mode)
        print(plan_text(plan))
        if not any(item["status"] == "Ready" for item in plan):
            return 2 if any(item["status"] == "Blocked" for item in plan) else 0
        if not sys.stdin.isatty() or not sys.stdout.isatty():
            print("Plan only: interactive confirmation is required to execute.")
            return 2
        if input("Execute this exact plan? Type UPDATE to continue: ").strip() != "UPDATE":
            return 0
        data = execute_plan(catalog, plan)
        print(json.dumps(data, indent=2))
        return int(any(r["status"] in FAILURES or r["status"] == "Blocked" for r in data["results"]))
    data = collect(catalog, args.mode, args.target, only)
    if args.result:
        atomic_json(args.result, data)
    if args.json:
        print(json.dumps(data, indent=2))
    else:
        print(table_text(data["rows"]))
        if data["discoveries"]:
            print(json.dumps(data["discoveries"], indent=2))
    return int(any(r["status"] in FAILURES for r in data["rows"]))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Exception, KeyboardInterrupt) as error:
        print("Manager stopped: " + str(error), file=sys.stderr)
        sys.exit(1)
