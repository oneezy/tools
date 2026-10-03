"""Safety and behavior tests. No test installs or updates real software."""
from copy import deepcopy
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import software_manager as m
import updater_inventory as inv
import updater_ui as ui


def evidence(version="1.0.0", state="installed"):
    return dict(id="test", name="Test CLI", host=m.HOST, installed=version, path="/test",
                owner="native", state=state, status="Installed / latest not checked" if version else "Missing",
                detail="", identity={"owner": "native", "path": "/test"}, release=None, history=None)


def release(version="2.0.0"):
    return dict(version=version, source={"kind": "json", "url": "https://example.invalid/release"},
                fresh=True, scope="publisher", channel="stable", checked_at="2026-09-21T00:00:00Z", metadata={})


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.root_patch = patch.object(m, "ROOT", self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.tool = dict(id="test", name="Test CLI", source={"kind": "json", "url": "https://example.invalid/release"},
                         hosts={m.HOST: dict(provider="native", path="/test", updateArgs=["install", "{version}"])})
        self.catalog = dict(tools=[self.tool], wslDistro="Ubuntu-26.04")

    def plan(self, version="1.0.0", state="installed", action="update"):
        with patch.object(m.Snapshot, "detect", return_value=evidence(version, state)):
            return m.plan_local(self.catalog, ["test"], action, {"test": release()})

    def run_plan(self, plan, detections, outcome=None):
        with patch.object(m.Snapshot, "detect", side_effect=detections), patch.object(m, "execute_item",
                return_value=outcome or {}) as execute:
            data = m.execute_local(self.catalog, plan)
            return data["results"], execute.call_count

    def test_local_scan_cannot_call_network_or_mutation(self):
        with patch.object(m.Snapshot, "detect", return_value=evidence()), \
             patch.object(m, "ReleaseClient", side_effect=AssertionError("network client")), \
             patch.object(m, "execute_item", side_effect=AssertionError("mutation")):
            rows = m.local_scan(self.catalog)["rows"]
        self.assertEqual(rows[0]["status"], "Installed / latest not checked")
        self.assertIsNone(rows[0]["release"])

    def test_cached_target_never_makes_local_scan_current(self):
        r = self.tool["hosts"][m.HOST]
        m.atomic_json(self.root / "logs" / ("release-history-" + m.HOST + ".json"),
                      {m.history_key(self.tool, r): release("1.0.0")})
        with patch.object(m.Snapshot, "detect", return_value=evidence()):
            row = m.local_scan(self.catalog)["rows"][0]
        self.assertEqual(row["status"], "Installed / latest not checked")
        self.assertIsNone(row["release"])
        self.assertEqual(row["history"]["version"], "1.0.0")

    def test_explicit_release_check_updates_and_saves_scope(self):
        with patch.object(m.Snapshot, "detect", return_value=evidence()), \
             patch.object(m.ReleaseClient, "check", return_value=release()):
            row = m.local_scan(self.catalog, "check-latest")["rows"][0]
        self.assertEqual(row["status"], "Update available")
        self.assertEqual(row["release"]["scope"], "publisher")
        self.assertTrue(m.read_history())

    def test_failed_check_is_not_current(self):
        with patch.object(m.Snapshot, "detect", return_value=evidence()), \
             patch.object(m.ReleaseClient, "check", side_effect=OSError("offline")):
            row = m.local_scan(self.catalog, "check-latest")["rows"][0]
        self.assertEqual(row["status"], "Latest check failed")
        self.assertIsNone(row["release"])

    def test_check_failure_is_isolated(self):
        other = deepcopy(self.tool)
        other["id"] = "other"
        self.catalog["tools"].append(other)
        with patch.object(m.Snapshot, "detect", side_effect=[evidence(), evidence()]), \
             patch.object(m.ReleaseClient, "check", side_effect=[OSError("offline"), release()]):
            rows = m.local_scan(self.catalog, "check-latest")["rows"]
        self.assertEqual([r["status"] for r in rows], ["Latest check failed", "Update available"])

    def test_current_and_newer_are_skipped(self):
        for version in ("2.0.0", "3.0.0"):
            self.assertEqual(self.plan(version)[0]["status"], "Skipped")

    def test_update_does_not_install_missing(self):
        self.assertEqual(self.plan(None, "missing")[0]["status"], "Skipped")

    def test_install_does_not_update_installed(self):
        self.assertEqual(self.plan(action="install")[0]["status"], "Skipped")

    def test_explicit_missing_install_has_concrete_download(self):
        self.tool["hosts"][m.HOST]["installUrl"] = "https://example.invalid/install"
        plan = self.plan(None, "missing", "install")
        self.assertEqual(plan[0]["status"], "Ready")
        self.assertEqual(plan[0]["downloads"][0]["url"], "https://example.invalid/install")

    def test_no_target_means_no_plan(self):
        with patch.object(m.Snapshot, "detect", return_value=evidence()):
            plan = m.plan_local(self.catalog, ["test"], "update", {})
        self.assertEqual(plan[0]["status"], "Blocked")

    def test_holds_block_even_explicit_install(self):
        self.tool["hosts"][m.HOST]["hold"] = True
        self.assertEqual(self.plan(None, "missing", "install")[0]["status"], "Blocked")

    def test_recheck_skips_target_met_during_confirmation(self):
        rows, count = self.run_plan(self.plan(), [evidence("2.0.0")])
        self.assertEqual((rows[0]["status"], count), ("Skipped", 0))

    def test_recheck_missing_never_installs(self):
        rows, count = self.run_plan(self.plan(), [evidence(None, "missing")])
        self.assertEqual((rows[0]["status"], count), ("Skipped", 0))

    def test_recheck_owner_change_blocks_mutation(self):
        changed = evidence()
        changed["identity"]["owner"] = "npm-global"
        rows, count = self.run_plan(self.plan(), [changed])
        self.assertEqual((rows[0]["status"], count), ("Failed", 0))

    def test_tampered_commands_cannot_execute(self):
        plan = self.plan()
        plan[0]["commands"] = [["unsafe"]]
        rows, count = self.run_plan(plan, [evidence()])
        self.assertEqual((rows[0]["status"], count), ("Failed", 0))

    def test_exit_zero_does_not_prove_update(self):
        rows, count = self.run_plan(self.plan(), [evidence(), evidence()])
        self.assertEqual(rows[0]["status"], "Needs attention")
        self.assertTrue(rows[0]["deferred"])

    def test_update_verifies_actual_version(self):
        rows, count = self.run_plan(self.plan(), [evidence(), evidence("2.0.0")])
        self.assertEqual((rows[0]["status"], rows[0]["after"], count), ("Updated", "2.0.0", 1))

    def test_failed_command_still_records_actual_after(self):
        rows, _ = self.run_plan(self.plan(), [evidence(), evidence("2.0.0")], {"error": "exit 5"})
        self.assertEqual((rows[0]["status"], rows[0]["after"]), ("Failed", "2.0.0"))

    def test_restart_requirement_is_structured(self):
        rows, _ = self.run_plan(self.plan(), [evidence(), evidence("2.0.0")], {"restart_required": True})
        self.assertEqual(rows[0]["status"], "Updated")
        self.assertTrue(rows[0]["restart_required"])

    def test_cancel_preserves_report_and_skips_remaining(self):
        plan = self.plan() * 2
        with patch.object(m.Snapshot, "detect", side_effect=[evidence(), evidence("1.5.0")]), \
             patch.object(m, "execute_item", side_effect=KeyboardInterrupt):
            rows = m.execute_local(self.catalog, plan)["results"]
        self.assertEqual([r["status"] for r in rows], ["Cancelled", "Skipped"])
        saved = next((self.root / "logs").glob("operation-*.json"))
        self.assertEqual(len(json.loads(saved.read_text())["results"]), 2)
        self.assertTrue(saved.with_suffix(".log").exists())

    def test_installer_cancel_is_not_success_even_if_version_changed(self):
        rows, _ = self.run_plan(self.plan(), [evidence(), evidence("2.0.0")], {"cancelled": True})
        self.assertEqual(rows[0]["status"], "Cancelled")

    def test_publisher_missing_digest_blocks_before_download(self):
        recipe = {"asset": "tool.exe"}
        target = release()
        target["metadata"] = {"assets": [{"name": "tool.exe", "browser_download_url": "https://example.invalid/tool.exe"}]}
        with self.assertRaisesRegex(ValueError, "digest"):
            m.asset_for(self.tool, recipe, target)

    def test_git_fourth_component_and_prerelease_numeric_order(self):
        self.assertGreater(m.version_key("2.55.0.windows.5"), m.version_key("2.55.0.3"))
        self.assertGreater(m.version_key("1.0.0-beta.10"), m.version_key("1.0.0-beta.2"))
        self.assertGreater(m.version_key("1.0.0"), m.version_key("1.0.0-rc.9"))

    @unittest.skipIf(inv.WINDOWS, "Debian comparison is native Linux")
    def test_debian_epoch_and_revision_are_preserved(self):
        self.assertEqual(m.compare("1:2.53.0-1ubuntu2", "1:2.53.0-1ubuntu1", {"kind": "apt"}), 1)
        self.assertEqual(m.compare("2:1.0.0-1", "1:9.0.0-1", {"kind": "apt"}), 1)

    def test_cached_apt_candidate_never_claims_fresh_current(self):
        row, target = evidence("2.0.0"), release()
        target.update(fresh=False, scope="APT cached indexes")
        m.attach_release(row, target)
        self.assertEqual(row["status"], "Cached candidate / inspect")

    def test_unknown_id_rejected_before_scan(self):
        with patch.object(m, "local_scan", side_effect=AssertionError("scan")):
            with self.assertRaisesRegex(ValueError, "Unknown tools"):
                m.collect(self.catalog, only=["typo"])

    def test_bridge_uses_exec_and_rejects_docker_desktop(self):
        self.assertIn("--exec", m.bridge_args(self.catalog))
        self.catalog["wslDistro"] = "docker-desktop"
        with self.assertRaises(ValueError):
            m.bridge_args(self.catalog)

    def test_wsl_failure_has_a_state_for_each_tool(self):
        with patch.object(m, "wsl_path", side_effect=TimeoutError("WSL timeout")):
            rows = m.wsl_scan(self.catalog, "check")["rows"]
        self.assertEqual(len(rows), 1)
        expected = "WSL unavailable" if m.HOST == "wsl" else "Platform not applicable"
        self.assertEqual(rows[0]["status"], expected)

    def test_real_fake_program_update_and_verification(self):
        version_file = self.root / "fake-version.txt"
        version_file.write_text("1.0.0")
        script = self.root / "fake-updater.py"
        script.write_text("from pathlib import Path\nimport sys\nPath(sys.argv[1]).write_text('2.0.0')\n")
        self.tool["hosts"][m.HOST].update(path=sys.executable, updateArgs=[str(script), str(version_file)])
        def detect(_):
            row = evidence(version_file.read_text())
            row.update(path=sys.executable, identity={"owner": "native", "path": sys.executable})
            return row
        with patch.object(m.Snapshot, "detect", side_effect=detect), contextlib.redirect_stdout(io.StringIO()):
            plan = m.plan_local(self.catalog, ["test"], "update", {"test": release()})
            result = m.execute_local(self.catalog, plan)["results"][0]
        self.assertEqual((result["status"], result["before"], result["after"]), ("Updated", "1.0.0", "2.0.0"))
        self.assertEqual(result["exit_codes"], [0])

    def test_real_fake_program_failure_does_not_erase_other_results(self):
        script = self.root / "fake-failure.py"
        script.write_text("raise SystemExit(5)\n")
        self.tool["hosts"][m.HOST].update(path=sys.executable, updateArgs=[str(script)])
        def detect(_):
            row = evidence()
            row.update(path=sys.executable, identity={"owner": "native", "path": sys.executable})
            return row
        with patch.object(m.Snapshot, "detect", side_effect=detect), contextlib.redirect_stdout(io.StringIO()):
            plan = m.plan_local(self.catalog, ["test"], "update", {"test": release()})
            second = dict(plan[0], status="Skipped", detail="Target already met")
            results = m.execute_local(self.catalog, plan + [second])["results"]
        self.assertEqual([r["status"] for r in results], ["Failed", "Skipped"])
        self.assertEqual(results[0]["exit_codes"], [5])

    def test_same_check_can_share_http_response_without_network(self):
        client = m.ReleaseClient({"https://example.invalid/version": '{"version":"1.2.3"}'})
        with patch.object(m.urllib.request, "urlopen", side_effect=AssertionError("duplicate request")):
            self.assertEqual(client.get("https://example.invalid/version"), {"version": "1.2.3"})

    def test_worker_crash_retains_completed_and_marks_remaining(self):
        plan = self.plan()
        a, b, c = [dict(plan[0], id=id) for id in ("a", "b", "c")]
        results = m.reconcile_worker([a, b, c], [dict(a, status="Updated"), dict(b, status="Running")], 1)
        self.assertEqual([r["status"] for r in results], ["Updated", "Needs attention", "Needs attention"])

    def test_redirected_update_never_executes(self):
        with patch.object(m, "load_catalog", return_value=self.catalog), \
             patch.object(m, "collect", return_value={"rows": [evidence()]}), \
             patch.object(m, "make_plan", return_value=self.plan()), \
             patch.object(sys.stdin, "isatty", return_value=False), \
             patch.object(m, "execute_plan") as execute, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.main(["--mode", "update", "--only", "test"]), 2)
        execute.assert_not_called()

    def test_blocked_cli_plan_returns_nonzero_without_prompting(self):
        with patch.object(m, "load_catalog", return_value=self.catalog), \
             patch.object(m, "collect", return_value={"rows": [evidence()]}), \
             patch.object(m, "make_plan", return_value=[dict(self.plan()[0], status="Blocked")]), \
             patch("builtins.input", side_effect=AssertionError("prompt")), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.main(["--mode", "update", "--only", "test"]), 2)


class InventoryTests(unittest.TestCase):
    def test_windows_mount_is_not_native_linux(self):
        with patch.object(inv, "WINDOWS", False):
            with self.assertRaisesRegex(ValueError, "Environment mismatch"):
                inv.native_path("/mnt/c/Windows/tool.exe")

    def test_native_probe_never_executes_shim(self):
        tool = dict(id="unknown", name="Unknown", source={"kind": "manual"},
                    hosts={inv.HOST: dict(provider="native", path=sys.executable)})
        with patch.object(inv, "WINDOWS", False), patch.object(inv.subprocess, "run", side_effect=AssertionError("process")):
            row = inv.Snapshot({"tools": [tool]}).detect(tool)
        self.assertIn(row["state"], ("unknown", "mismatch"))

    def test_pnpm_without_default_does_not_invoke_shim(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            shim = root / "pnpm"
            shim.write_bytes(b"shim")
            tool = dict(id="pnpm", name="pnpm", hosts={inv.HOST: dict(provider="pnpm", path=str(shim))})
            snapshot = inv.Snapshot({"tools": [tool]})
            snapshot.vp = root
            with patch.object(snapshot, "config", return_value={}), \
                 patch.object(inv.subprocess, "run", side_effect=AssertionError("shim")):
                row = snapshot.detect(tool)
            self.assertEqual(row["state"], "unknown")
            self.assertIn("No global default", row["detail"])

    def test_passive_path_version_excludes_architecture(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "0.155.1-x86_64-pc-windows-msvc" / "codex"
            path.parent.mkdir()
            path.write_bytes(b"not run")
            tool = dict(id="codex", name="Codex CLI", hosts={inv.HOST: dict(provider="native", path=str(path), versionFromPath=True)})
            self.assertEqual(inv.Snapshot({"tools": [tool]}).detect(tool)["installed"], "0.155.1")

    def test_global_owner_mismatch_does_not_rename_tool(self):
        tool = dict(id="copilot", name="GitHub Copilot CLI", package="@github/copilot",
                    hosts={inv.HOST: dict(provider="vp-global")})
        snapshot = inv.Snapshot({"tools": [tool]})
        with patch.object(snapshot, "globals", return_value={"packages": [
                dict(name="@github/copilot", version="1.0.0", owner="npm-global", path=str(Path.home()))], "errors": []}):
            row = snapshot.detect(tool)
        self.assertEqual(row["name"], "GitHub Copilot CLI")
        self.assertEqual(row["state"], "mismatch")

    def test_duplicate_globals_require_owner_review(self):
        tool = dict(id="x", name="Tool", package="x", hosts={inv.HOST: dict(provider="vp-global")})
        snapshot = inv.Snapshot({"tools": [tool]})
        with patch.object(snapshot, "globals", return_value={"packages": [
                dict(name="x", owner="vp-global"), dict(name="x", owner="pnpm-global")], "errors": []}):
            row = snapshot.detect(tool)
        self.assertEqual(row["state"], "mismatch")
        self.assertEqual(len(row["alternatives"]), 2)

    def test_shared_scan_is_reused_and_errors_cached(self):
        snapshot = inv.Snapshot({"tools": []})
        reader = Mock(return_value={"x": 1})
        self.assertEqual(snapshot.once("scan", reader), snapshot.once("scan", reader))
        reader.assert_called_once()


class PresentationTests(unittest.TestCase):
    def test_one_logical_row_per_tool_and_differences_are_information(self):
        a, b = evidence(), evidence("3.0.0")
        a["host"], b["host"] = "windows", "wsl"
        rows = ui.logical_rows([a, b])
        self.assertEqual(len(rows), 1)
        self.assertIn("1.0.0", rows[0][1][1])
        self.assertIn("3.0.0", rows[0][1][2])
        self.assertNotIn("mismatch", rows[0][1][4])

    def test_checked_and_unchecked_platforms_do_not_share_universal_latest(self):
        a, b = evidence(), evidence()
        a["host"], b["host"] = "windows", "wsl"
        a["release"] = release()
        text = ui.logical_rows([a, b])[0][1][3]
        self.assertIn("Win: 2.0.0", text)
        self.assertIn("WSL: not checked", text)

    def test_distinct_platform_states(self):
        rows = [dict(evidence(None), host="windows", state="missing", status="Missing"),
                dict(evidence(None), host="wsl", state="unavailable", status="WSL unavailable")]
        text = ui.table_text(rows, 150)
        self.assertIn("absent", text)
        self.assertIn("WSL unavailable", text)
        rows[1].update(state="not-applicable", status="Platform not applicable")
        self.assertIn("not applicable", ui.table_text(rows))

    def test_table_adapts_without_ansi_in_plain_output(self):
        for width in (64, 80, 90, 120, 160):
            text = ui.table_text([evidence()], width)
            self.assertTrue(all(len(line) <= width for line in text.splitlines()))
            self.assertNotIn("\x1b", text)

    def test_terminal_control_characters_are_not_rendered(self):
        self.assertNotIn("\x1b", ui.clean("\x1b[2J"))

    def test_redirected_default_scans_once_and_never_prompts(self):
        instance = ui.ManagerUI({"tools": [{"id": "test"}]}, plain=True)
        instance.interactive = False
        with patch.object(instance, "scan", side_effect=lambda: instance.rows.append(evidence())) as scan, \
             patch("builtins.input", side_effect=AssertionError("prompt")), contextlib.redirect_stdout(io.StringIO()):
            instance.run()
        scan.assert_called_once_with()


try:
    from prompt_toolkit.input import create_pipe_input
    from prompt_toolkit.output import DummyOutput
    from prompt_toolkit.application import create_app_session
    HAS_UI = True
except ImportError:
    HAS_UI = False


@unittest.skipUnless(HAS_UI, "UI dependency deliberately absent from the Ubuntu worker")
class KeyboardTests(unittest.TestCase):
    def instance(self):
        instance = ui.ManagerUI({"tools": [{"id": "a"}, {"id": "b"}]}, plain=True)
        instance.rich = True
        instance.rows = [dict(evidence(), id="a"), dict(evidence(), id="b")]
        return instance

    def drive(self, keys, function):
        with create_pipe_input() as pipe:
            with create_app_session(input=pipe, output=DummyOutput()):
                pipe.send_text(keys)
                return function()

    def test_arrows_space_and_inspect(self):
        instance = self.instance()
        self.assertEqual(self.drive("\x1b[B i", instance.dashboard), "inspect")
        self.assertEqual(instance.index, 1)
        self.assertEqual(instance.marked, {"b"})

    def test_menu_down_enter_chooses_highlighted_action(self):
        instance = self.instance()
        answer = self.drive("\x1b[B\r", lambda: instance.choose("Action", [("a", "First"), ("b", "Second")]))
        self.assertEqual(answer, "b")

    def test_confirmation_defaults_to_cancel(self):
        instance = self.instance()
        answer = self.drive("\r", lambda: instance.choose("Execute?", [(False, "Cancel"), (True, "Execute")]))
        self.assertIs(answer, False)

    def test_installation_checklist_requires_explicit_selection(self):
        instance = self.instance()
        instance.ids = ["a"]
        instance.rows = [dict(evidence(None, "missing"), id="a", host="windows")]
        answer = self.drive(" \t\r", lambda: instance.select_installations("install"))
        self.assertEqual(answer, [("windows", "a")])

    def test_details_return_on_enter(self):
        instance = self.instance()
        self.assertIsNone(self.drive("\r", lambda: instance.show("Details", "Local path and version")))

    def test_escape_and_q_exit_without_mutation(self):
        self.assertEqual(self.drive("q", self.instance().dashboard), "exit")


if __name__ == "__main__":
    unittest.main()
