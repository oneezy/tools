"""Run: python -m unittest discover -s clis/skills-sync-cli/tests  (from the tools repo root)"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import skills_sync as ss  # noqa: E402


def skill(folder: Path, name: str, body: str = "do the thing") -> Path:
    d = folder / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {name} skill\n---\n{body}\n", encoding="utf-8")
    return d


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.dev = base / "dev"
        self.repo = ss.Repo(self.dev / "skills")
        self.home = base / "home"
        skill(self.repo.own, "oneezy-merge")
        skill(self.repo.own, "oneezy-status")
        skill(self.repo.agents, "grilling")  # a third-party copy installed by npx skills
        (self.repo.agents / "grilling" / "agents").mkdir()
        (self.repo.agents / "grilling" / "agents" / "openai.yaml").write_text("policy:\n  allow_implicit_invocation: true\n")
        self.home.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def run_all(self, plan=False):
        r = ss.Report()
        ss.layers(self.repo, r)
        ss.apply(r, plan)
        u = ss.Report()
        ss.user(self.repo, self.home, u)
        ss.apply(u, plan)
        r.actions += u.actions
        return r


class LayersTest(Fixture):
    def test_own_skills_are_linked_into_agents_and_everything_into_claude(self):
        self.run_all()
        for n in ("oneezy-merge", "oneezy-status"):
            self.assertTrue(ss.is_link(self.repo.agents / n))
            self.assertTrue(ss.same_path(ss.real(self.repo.agents / n), self.repo.own / n))
        for n in ("oneezy-merge", "oneezy-status", "grilling"):
            self.assertTrue(ss.is_link(self.repo.claude / n), n)
            self.assertTrue((self.repo.claude / n / "SKILL.md").is_file(), n)
        # the third-party copy stays a real folder
        self.assertFalse(ss.is_link(self.repo.agents / "grilling"))
        gi = (self.repo.agents / ".gitignore").read_text()
        self.assertIn("/oneezy-merge/\n", gi)
        self.assertNotIn("grilling", gi)

    def test_second_run_changes_nothing(self):
        self.run_all()
        r = self.run_all()
        self.assertEqual([a.kind for a in r.changes()], [])
        self.assertEqual(r.conflicts(), [])

    def test_plan_touches_nothing(self):
        r = self.run_all(plan=True)
        self.assertTrue(any(a.kind == "link" for a in r.actions))
        self.assertFalse(self.repo.claude.exists())
        self.assertFalse((self.home / ".claude").exists())

    def test_removed_own_skill_drops_its_links(self):
        self.run_all()
        import shutil

        shutil.rmtree(self.repo.own / "oneezy-status")
        r = self.run_all()
        removed = {str(a.path.name) for a in r.actions if a.kind == "remove"}
        self.assertIn("oneezy-status", removed)
        self.assertFalse(ss.lexists(self.repo.agents / "oneezy-status"))
        self.assertFalse(ss.lexists(self.repo.claude / "oneezy-status"))
        self.assertFalse(ss.lexists(self.home / ".claude" / "skills" / "oneezy-status"))
        self.assertTrue(ss.lexists(self.home / ".claude" / "skills" / "oneezy-merge"))

    def test_stale_copy_in_claude_layer_becomes_a_link(self):
        skill(self.repo.claude, "grilling", body="old copy")
        r = self.run_all()
        self.assertIn("replace-copy", [a.kind for a in r.actions])
        self.assertTrue(ss.is_link(self.repo.claude / "grilling"))

    def test_real_folder_in_agents_with_own_name_is_a_conflict_not_a_deletion(self):
        skill(self.repo.agents, "oneezy-merge", body="someone's copy")
        r = self.run_all()
        self.assertTrue(any(a.kind == "conflict" and a.path.name == "oneezy-merge" for a in r.actions))
        self.assertFalse(ss.is_link(self.repo.agents / "oneezy-merge"))
        self.assertIn("someone's copy", (self.repo.agents / "oneezy-merge" / "SKILL.md").read_text())


class UserTest(Fixture):
    def test_user_folders_get_one_link_per_skill_pointing_at_the_real_folder(self):
        self.run_all()
        for udir in ss.user_dirs(self.home):
            for n in ("oneezy-merge", "oneezy-status", "grilling"):
                self.assertTrue(ss.is_link(udir / n), f"{udir}/{n}")
                t = ss.link_target(udir / n)
                self.assertFalse(ss.is_link(t), "user links point at the real folder, never at another link")
                self.assertTrue(ss.under(t, self.repo.root))

    def test_unmanaged_folders_and_reserved_names_are_left_alone(self):
        udir = self.home / ".claude" / "skills"
        skill(udir, "oneezy-brain", body="not in the repo")
        skill(udir, "grilling", body="a hand-made copy")
        (udir / "synced").mkdir()
        r = self.run_all()
        self.assertFalse(ss.is_link(udir / "oneezy-brain"))
        self.assertFalse(ss.is_link(udir / "grilling"))
        self.assertTrue(any(a.kind == "conflict" and a.path.name == "grilling" for a in r.actions))
        self.assertTrue((udir / "synced").is_dir())

    def test_unlink_removes_only_our_links(self):
        self.run_all()
        udir = self.home / ".agents" / "skills"
        other = self.home / "elsewhere" / "thing"
        skill(other.parent, "thing")
        ss.make_link(other, udir / "thing")
        r = ss.Report()
        ss.unlink(self.repo, self.home, r)
        ss.apply(r, False)
        self.assertFalse(ss.lexists(udir / "grilling"))
        self.assertTrue(ss.is_link(udir / "thing"))
        self.assertTrue(ss.is_link(self.repo.claude / "grilling"), "unlink leaves the repo layers alone")


class ProjectsTest(Fixture):
    def test_copies_into_selected_repos_and_is_idempotent(self):
        self.run_all()
        proj = self.dev / "app"
        (proj / ".git").mkdir(parents=True)
        (self.dev / "notes").mkdir()  # not a git repo
        found = ss.list_projects(self.dev, self.repo)
        self.assertEqual([p.name for p in found], ["app"])
        r = ss.Report()
        ss.projects(self.repo, found, ["oneezy-merge", "grilling"], r)
        ss.apply(r, False)
        for layer in (".agents", ".claude"):
            self.assertTrue((proj / layer / "skills" / "oneezy-merge" / "SKILL.md").is_file())
            self.assertFalse(ss.is_link(proj / layer / "skills" / "oneezy-merge"))
            self.assertTrue((proj / layer / "skills" / "grilling" / "agents" / "openai.yaml").is_file())
            self.assertFalse((proj / layer / "skills" / "oneezy-status").exists())
        r2 = ss.Report()
        ss.projects(self.repo, found, ["oneezy-merge", "grilling"], r2)
        self.assertEqual(r2.changes(), [])


class CliTest(Fixture):
    def test_status_and_plan_via_main(self):
        rc = ss.main(["status", "--repo", str(self.repo.root), "--home", str(self.home)])
        self.assertEqual(rc, 0)
        rc = ss.main(["--repo", str(self.repo.root), "--home", str(self.home), "--plan"])
        self.assertEqual(rc, 0)
        self.assertFalse((self.home / ".claude").exists())
        rc = ss.main(["--repo", str(self.repo.root), "--home", str(self.home)])
        self.assertEqual(rc, 0)
        self.assertTrue(ss.is_link(self.home / ".agents" / "skills" / "grilling"))


if __name__ == "__main__":
    unittest.main()
