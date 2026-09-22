"""Passive installation evidence. Never invoke an application or package-manager shim."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import datetime as dt

WINDOWS = os.name == "nt"
HOST = "windows" if WINDOWS else "wsl"


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def expand(value):
    return Path(os.path.expandvars(os.path.expanduser(value)))


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def extract_version(text):
    match = re.search(r"(?<!\d)(\d+\.\d+\.\d+(?:\.\d+)?(?:-[A-Za-z][A-Za-z0-9.-]*)?)",
                      str(text).replace(".windows.", "."))
    if not match:
        raise ValueError("No recognizable version in local evidence")
    return match.group(1)


def native_path(path):
    """Reject Windows mounts, Windows binaries and wrappers when inspecting Linux."""
    resolved = Path(path).resolve()
    if not WINDOWS:
        if resolved.as_posix().startswith("/mnt/") or resolved.suffix.lower() in (".exe", ".cmd", ".bat"):
            raise ValueError("Environment mismatch: resolves to a Windows/mounted installation")
        if resolved.is_file():
            with resolved.open("rb") as stream:
                if stream.read(2) == b"MZ":
                    raise ValueError("Environment mismatch: Windows executable")
    return resolved


class Snapshot:
    """One snapshot owns all shared scans. No network-capable inventory commands."""
    def __init__(self, catalog):
        self.catalog = catalog
        self.home = Path.home()
        self.vp = self.home / ".vite-plus"
        self.cache = {}
        self.errors = {}

    def once(self, name, reader):
        if name not in self.cache and name not in self.errors:
            try:
                self.cache[name] = reader()
            except Exception as error:
                self.errors[name] = str(error)
        if name in self.errors:
            raise ValueError(self.errors[name])
        return self.cache[name]

    def config(self):
        return self.once("vp-config", lambda: read_json(self.vp / "config.json"))

    def registry(self):
        def scan():
            import winreg
            apps, seen = [], set()
            patterns = [r["registry"] for t in self.catalog["tools"]
                        if (r := t["hosts"].get("windows", {})).get("registry")]
            for hive, scope in ((winreg.HKEY_CURRENT_USER, "user"), (winreg.HKEY_LOCAL_MACHINE, "machine")):
                for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
                    try:
                        root = winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                                             0, winreg.KEY_READ | view)
                    except FileNotFoundError:
                        continue
                    with root:
                        for i in range(winreg.QueryInfoKey(root)[0]):
                            key = winreg.EnumKey(root, i)
                            with winreg.OpenKey(root, key) as item:
                                record = {"scope": scope, "registryKey": key}
                                for field in ("DisplayName", "DisplayVersion", "InstallLocation", "DisplayIcon"):
                                    try:
                                        record[field] = winreg.QueryValueEx(item, field)[0]
                                    except FileNotFoundError:
                                        pass
                            identity = (scope, key)
                            if any(re.search(pattern, record.get("DisplayName", "")) for pattern in patterns) and identity not in seen:
                                apps.append(record)
                                seen.add(identity)
            return apps
        return self.once("registry", scan)

    def windows_metadata(self):
        def scan():
            # One OS metadata query for tracked binaries and exact AppX identities.
            paths = [str(expand(r["path"])) for t in self.catalog["tools"]
                     if (r := t["hosts"].get("windows", {})).get("path")]
            names = [r["appx"] for t in self.catalog["tools"]
                     if (r := t["hosts"].get("windows", {})).get("appx")]
            payload = json.dumps({"paths": paths, "names": names})
            script = r"""
            $ErrorActionPreference='Stop'
            [Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
            [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
            $inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json
            $files=@{}
            foreach($p in $inputData.paths) {
                if(Test-Path -LiteralPath $p -PathType Leaf) {
                    $i=Get-Item -LiteralPath $p
                    $files[$p]=@{version=$i.VersionInfo.ProductVersion;fileVersion=$i.VersionInfo.FileVersion}
                }
            }
            $apps=@()
            foreach($name in $inputData.names) {
                $apps+=@(Get-AppxPackage -Name $name | Select-Object Name,Version,InstallLocation,PackageFullName)
            }
            @{files=$files;apps=@($apps)} | ConvertTo-Json -Depth 5 -Compress
            """
            # Windows PowerShell has the inbox Appx module; no profile or application execution.
            ps = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
            result = subprocess.run([str(ps), "-NoProfile", "-NonInteractive", "-Command", script],
                                    input=payload, capture_output=True, text=True, encoding="utf-8",
                                    errors="replace", timeout=20)
            if result.returncode:
                raise ValueError("Windows metadata query failed: " + result.stderr[-600:])
            return json.loads(result.stdout)
        return self.once("windows-metadata", scan)

    def dpkg(self):
        def scan():
            records = {}
            for block in Path("/var/lib/dpkg/status").read_text().split("\n\n"):
                fields = dict(line.split(": ", 1) for line in block.splitlines()
                              if ": " in line and not line.startswith(" "))
                if fields.get("Status") == "install ok installed":
                    records[fields["Package"]] = fields
            return records
        return self.once("dpkg", scan)

    def globals(self):
        def scan():
            packages, errors = [], []
            root = self.vp / "packages"
            for manifest in list(root.glob("*.json")) + list(root.glob("@*/*.json")):
                try:
                    data = read_json(manifest)
                    target = manifest.with_suffix("") / data["installId"]
                    if not target.is_dir():
                        raise ValueError("Active installation directory is missing")
                    installed_manifest = read_json(target / "node_modules" / data["name"] / "package.json")
                    if installed_manifest["version"] != data["version"]:
                        raise ValueError("Vite ownership record disagrees with installed package manifest")
                    packages.append({"name": data["name"], "version": installed_manifest["version"], "owner": "vp-global",
                                     "path": str(target), "manifest": str(manifest),
                                     "node": data.get("platform", {}).get("node"),
                                     "pin": data.get("versionSpec"), "installed_at": data.get("installedAt")})
                except Exception as error:
                    errors.append(str(manifest) + ": " + str(error))
            try:
                node = self.config().get("defaultNodeVersion")
                runtime = self.vp / "js_runtime/node" / str(node)
                prefix = runtime
                # Read only prefix/global-dir keys; never retain or report authentication fields.
                npmrc = self.home / ".npmrc"
                if npmrc.exists():
                    for line in npmrc.read_text().splitlines():
                        if re.match(r"^\s*prefix\s*=", line, re.I):
                            prefix = expand(line.split("=", 1)[1].strip())
                if os.environ.get("NPM_CONFIG_PREFIX") or os.environ.get("npm_config_prefix"):
                    prefix = expand(os.environ.get("NPM_CONFIG_PREFIX") or os.environ["npm_config_prefix"])
                module_root = prefix / ("node_modules" if WINDOWS else "lib/node_modules")
                self.scan_modules(module_root, "npm-global", packages, node=node, prefix=str(prefix))
                pnpm_roots = [self.home / "AppData/Local/pnpm/global" if WINDOWS
                              else self.home / ".local/share/pnpm/global"]
                if os.environ.get("PNPM_HOME"):
                    pnpm_roots.append(expand(os.environ["PNPM_HOME"]) / "global")
                # A configured global-dir is evidence, not permission to run pnpm.
                if npmrc.exists():
                    for line in npmrc.read_text().splitlines():
                        if re.match(r"^\s*global-dir\s*=", line, re.I):
                            pnpm_roots.append(expand(line.split("=", 1)[1].strip()))
                for base in dict.fromkeys(pnpm_roots):
                    for modules in [base / "node_modules"] + list(base.glob("*/node_modules")):
                        self.scan_modules(modules, "pnpm-global", packages)
            except Exception as error:
                errors.append("Global roots: " + str(error))
            return {"packages": packages, "errors": errors,
                    "scope": "Active Vite manifests; active Node npm prefix; known/configured pnpm globals. Cached runtimes excluded."}
        return self.once("globals", scan)

    @staticmethod
    def scan_modules(root, owner, output, **fields):
        for p in list(root.glob("*/package.json")) + list(root.glob("@*/*/package.json")):
            d = read_json(p)
            output.append(dict(name=d["name"], version=d["version"], owner=owner, path=str(p.parent),
                               runtime_component=d["name"] in ("npm", "corepack"), **fields))

    def detect(self, tool):
        recipe = tool["hosts"].get(HOST)
        row = dict(id=tool["id"], name=tool["name"], host=HOST, installed=None, path=None, owner=None,
                   state="not-applicable", status="Platform not applicable", detail="", observed_at=stamp(),
                   release=None, history=None)
        if recipe is None:
            return row
        row.update(owner=recipe["provider"], state="unknown", status="Unknown",
                   detail=recipe.get("note", ""), channel=recipe.get("channel", "stable"),
                   release_source=recipe.get("source", tool.get("source")))
        try:
            row.update(self.evidence(tool, recipe))
            row["status"] = {"installed": "Installed / latest not checked", "missing": "Missing",
                             "unknown": "Unknown", "mismatch": "Environment mismatch"}[row["state"]]
            if recipe.get("hold") or recipe["provider"] == "manual":
                row["status"] = "Blocked / manual attention"
            row["identity"] = {k: row.get(k) for k in ("owner", "path", "scope", "prefix", "node", "package_identity")}
        except Exception as error:
            row["detail"] = str(error)
            if "Environment mismatch" in str(error):
                row.update(state="mismatch", status="Environment mismatch")
        return row

    def evidence(self, tool, r):
        provider = r["provider"]
        if r.get("appx"):
            apps = [a for a in self.windows_metadata()["apps"] if a["Name"] == r["appx"]]
            if not apps:
                return dict(state="missing", owner="windows-app-package")
            if len(apps) != 1:
                raise ValueError("Multiple registered Windows packages; inspect before updating")
            a = apps[0]
            return dict(state="installed", installed=a["Version"], path=a["InstallLocation"],
                        owner="windows-app-package", scope="user", package_identity=a["Name"],
                        detail=r.get("note", "") + " Version is registered package identity, not the running process.")
        if r.get("registry"):
            matches = [a for a in self.registry() if re.search(r["registry"], a["DisplayName"])]
            if not matches:
                return dict(state="missing")
            if len(matches) != 1:
                raise ValueError("Multiple installation records; ownership/scope is ambiguous")
            a = matches[0]
            location = a.get("InstallLocation") or re.sub(r",[-\d]+$", "", a.get("DisplayIcon", "")).strip('"')
            v = a.get("DisplayVersion")
            return dict(state="installed" if v else "unknown", installed=v, path=location,
                        owner="windows-installer", route=provider,
                        scope=a["scope"], package_identity=a["registryKey"],
                        detail=r.get("note", "") + " Version is registered, not a staged folder or running process.")
        if provider in ("vp-global", "npm-global"):
            inventory = self.globals()
            matches = [p for p in inventory["packages"] if p["name"] == tool["package"]]
            if len(matches) > 1:
                return dict(state="mismatch", alternatives=matches,
                            detail="Multiple global owners; explicitly choose an owner before updating: " +
                            ", ".join(p["owner"] for p in matches))
            if matches:
                p = matches[0]
                native_path(p["path"])
                return dict({k: v for k, v in p.items() if k != "name"}, installed=p["version"],
                            state="installed" if p["owner"] == provider else "mismatch",
                            detail="Existing owner: " + p["owner"])
            if inventory["errors"]:
                raise ValueError("; ".join(inventory["errors"]))
            return dict(state="missing")
        p = expand(r["path"])
        if not p.exists():
            # Broken links are failed evidence, not an explicit missing install.
            if p.is_symlink():
                raise ValueError("Installation symlink is broken")
            return dict(state="missing", path=str(p))
        resolved = native_path(p)
        result = dict(state="installed", path=str(p), resolved_path=str(resolved), scope=r.get("scope", "user"))
        if provider == "pnpm":
            selected = (self.config().get("defaultPackageManagerVersions") or {}).get("pnpm")
            if not selected:
                cached = [d.name for d in (self.vp / "package_manager/pnpm").glob("*") if d.is_dir()]
                return dict(result, state="unknown", detail="No global default. Cached: " + ", ".join(cached) +
                            ". Shim was not invoked; choose a default separately.")
            manifest = self.vp / "package_manager/pnpm" / selected / "pnpm/package.json"
            native = manifest.parent / "bin" / ("pnpm.native.exe" if WINDOWS else "pnpm")
            if manifest.exists():
                result["installed"] = read_json(manifest)["version"]
            elif native.is_file():
                result["installed"] = selected
                result["detail"] = "Configured Vite package version; native executable exists in that version directory."
            else:
                raise ValueError("Configured pnpm version has no installed package/executable")
            result["owner"] = "vite-plus"
        elif tool["id"] == "vite-plus":
            result["installed"] = read_json(self.vp / "current/package.json")["version"]
        elif r.get("dpkg"):
            package = self.dpkg().get(r["dpkg"])
            if not package:
                raise ValueError("Executable exists without the expected dpkg ownership record")
            result.update(installed=package["Version"], owner="apt", scope="system", package_identity=r["dpkg"])
        elif r.get("checkout"):
            import tomllib
            root = expand(r["checkout"])
            data = tomllib.loads((root / "pyproject.toml").read_text())
            result.update(installed=data.get("project", {}).get("version"), owner="source-checkout",
                          detail=r.get("note", ""))
            if not result["installed"]:
                result["state"] = "unknown"
        elif r.get("versionFromPath"):
            # Only the resolved active path, never max(cached release directories).
            components = [re.sub(r"-(?:x86_64|aarch64|i686|arm64).*", "", p) for p in resolved.parts]
            versions = [p for p in components if re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", p)]
            if len(versions) != 1:
                raise ValueError("Active path does not identify exactly one installed release")
            result["installed"] = versions[0]
        elif WINDOWS:
            d = self.windows_metadata()["files"].get(str(p), {})
            result["installed"] = extract_version(d.get("version") or d.get("fileVersion") or "")
            if tool["id"] == "claude":
                result["installed"] = result["installed"].removesuffix(".0")
        else:
            # Intentionally fail closed rather than execute an unaudited binary --version.
            result.update(state="unknown", detail="Installed file found; no passive version evidence. No executable was invoked.")
        return result

    def discoveries(self):
        data = self.globals()
        tracked = {t.get("package") for t in self.catalog["tools"]}
        return dict(data, candidates=[p for p in data["packages"]
                                      if p["name"] not in tracked and not p.get("runtime_component")])
