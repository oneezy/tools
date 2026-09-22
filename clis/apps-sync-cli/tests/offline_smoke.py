"""Real passive scan under a process/network denylist. Run separately on Windows and Ubuntu."""
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import software_manager as manager
calls = []
forbidden = []


def audit(event, args):
    if event in ("socket.connect", "socket.getaddrinfo", "urllib.Request", "os.system"):
        forbidden.append(event)
        raise AssertionError("Forbidden local-scan side effect: " + event)
    if event == "subprocess.Popen":
        executable, argv = args[0], args[1]
        expected = str(Path(os.environ.get("SystemRoot", "C:/Windows")) /
                       "System32/WindowsPowerShell/v1.0/powershell.exe")
        if executable is None and isinstance(argv, str) and argv.lower().startswith(expected.lower()):
            executable = expected
        # Only the fixed inbox Windows metadata query. Linux must not spawn anything.
        if os.name != "nt" or not str(executable).lower().endswith("windowspowershell\\v1.0\\powershell.exe"):
            forbidden.append(str(executable))
            raise AssertionError("Unexpected inventory process: " + str(executable))
        script = str(argv)
        if "Get-AppxPackage -Name" not in script or "VersionInfo.ProductVersion" not in script:
            forbidden.append("Unrecognized metadata query")
            raise AssertionError("Unrecognized metadata query")
        calls.append(str(executable))


sys.addaudithook(audit)
catalog = manager.load_catalog()
data = manager.local_scan(catalog, "inventory")
assert len(data["rows"]) == len(catalog["tools"])
assert not any(r["release"] or r["status"] in ("Current", "Catalog current") for r in data["rows"])
assert len(calls) <= 1
assert not forbidden, forbidden
print(json.dumps({"host": manager.HOST, "rows": len(data["rows"]), "processes": calls,
                  "network_calls": 0, "states": {r["id"]: r["state"] for r in data["rows"]}}, indent=2))
