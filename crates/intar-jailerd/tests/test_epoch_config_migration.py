import importlib.util
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

if sys.version_info < (3, 11):
    raise unittest.SkipTest("host configuration migration requires Python 3.11")

HERE = Path(__file__).parent
FIXTURES = HERE / "fixtures/config-migration"
spec = importlib.util.spec_from_file_location(
    "epoch_config", HERE.parent / "deploy/migrate-epoch-config.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EpochConfigurationMigration(unittest.TestCase):
    # The *.main.toml fixtures are the example configs of the release before
    # this one; the *.host.toml ones carry host values and other spellings.
    # The Rust config tests parse every *.migrated.toml with the real parsers.
    def test_fixtures_migrate_to_their_golden_files_and_stay_there(self):
        for kind in ("jailerd", "builder"):
            for name in ("main", "host"):
                with self.subTest(kind=kind, name=name):
                    source = (FIXTURES / f"{kind}.{name}.toml").read_text()
                    golden = (FIXTURES / f"{kind}.{name}.migrated.toml").read_text()
                    self.assertEqual(module.migrate(source, kind), golden)
                    self.assertEqual(module.migrate(golden, kind), golden)

    def test_only_the_retired_keys_go(self):
        source = 'max_attempts = 1\n[jobs]\nmax_attempts = 3\nmax_concurrent_builds = 2\n[other]\nmax_attempts = 4\n'
        self.assertEqual(
            module.migrate(source, "builder"),
            'max_attempts = 1\n[jobs]\nmax_concurrent_builds = 2\n[other]\nmax_attempts = 4\n',
        )

    def test_a_spelling_it_does_not_edit_is_refused(self):
        for source in [
            'jobs.max_attempts = 3\n',
            '[jobs]\n"max_attempts" = 3\n',
            'legacy_template_retention_seconds = 1\nx = """\nlegacy_template_retention_seconds = 2\n"""\n',
        ]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                module.migrate(source, "builder" if "jobs" in source else "jailerd")

    def test_install_sh_runs_it_for_jailerd(self):
        install = (HERE.parent / "deploy/install.sh").read_text()
        self.assertIn('python3 "${archive_dir}/deploy/migrate-epoch-config.py" jailerd\n', install)

    def test_the_builder_rollout_migrates_before_it_stops_the_builder(self):
        rollout = (HERE.parents[2] / "workflows/workflow-builder-rollout.yaml").read_text()
        migrate = rollout.index("deploy/migrate-epoch-config.py' builder\n")
        self.assertLess(migrate, rollout.index("systemctl stop intar-builder", migrate - 2000))

    def test_install_sh_refuses_before_it_stops_anything(self):
        install = (HERE.parent / "deploy/install.sh").read_text()
        check = install.index('migrate-epoch-config.py" jailerd --print >/dev/null || \\\n  die')
        for later in ("mutated=false", "systemctl stop intar-jailerd.socket", "systemctl stop intar-jailerd.service"):
            self.assertLess(check, install.index(later), later)


class EpochConfigurationFile(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "config.toml"
        self.backup = Path(self.directory.name) / "config.toml.pre-epoch"
        self.source = (FIXTURES / "jailerd.host.toml").read_text()
        self.path.write_text(self.source)
        os.chmod(self.path, 0o640)

    def tearDown(self):
        self.directory.cleanup()

    def migrate(self):
        return module.migrate_file(self.path, "jailerd", os.getuid(), os.getgid())

    def test_keeps_a_rollback_copy_and_the_file_mode_and_is_idempotent(self):
        self.assertTrue(self.migrate())
        self.assertEqual(self.path.read_text(), (FIXTURES / "jailerd.host.migrated.toml").read_text())
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o640)
        self.assertEqual(self.backup.read_text(), self.source)
        self.assertEqual(stat.S_IMODE(self.backup.stat().st_mode), 0o600)
        self.assertFalse(self.migrate())
        self.assertEqual(self.backup.read_text(), self.source)
        self.assertEqual(sorted(p.name for p in self.path.parent.iterdir()), ["config.toml", "config.toml.pre-epoch"])

    def test_never_replaces_an_existing_rollback_copy(self):
        self.backup.write_text("the first original\n")
        self.assertTrue(self.migrate())
        self.assertEqual(self.backup.read_text(), "the first original\n")

    def test_changes_nothing_on_a_config_it_cannot_parse(self):
        self.path.write_text("legacy_template_retention_seconds = \n")
        with self.assertRaises(SystemExit):
            self.migrate()
        self.assertEqual(self.path.read_text(), "legacy_template_retention_seconds = \n")
        self.assertFalse(self.backup.exists())

    def test_refuses_a_writable_or_linked_config(self):
        os.chmod(self.path, 0o660)
        with self.assertRaises(SystemExit):
            self.migrate()
        os.chmod(self.path, 0o600)
        os.link(self.path, Path(self.directory.name) / "other")
        with self.assertRaises(SystemExit):
            self.migrate()
        self.assertEqual(self.path.read_text(), self.source)

    def test_a_missing_config_is_left_to_the_installer(self):
        self.path.unlink()
        self.assertFalse(self.migrate())
        self.assertFalse(self.path.exists())

    def test_the_dry_run_refuses_what_the_real_run_refuses(self):
        dry = lambda: module.migrated_text(self.path, "jailerd", os.getuid())
        self.assertEqual(dry(), (FIXTURES / "jailerd.host.migrated.toml").read_text())
        self.assertEqual(self.path.read_text(), self.source)
        os.chmod(self.path, 0o660)
        with self.assertRaises(SystemExit):
            dry()
        os.chmod(self.path, 0o600)
        os.link(self.path, Path(self.directory.name) / "other")
        with self.assertRaises(SystemExit):
            dry()
        os.unlink(Path(self.directory.name) / "other")
        with self.assertRaises(SystemExit):
            module.migrated_text(self.path, "jailerd", os.getuid() + 1)
        self.path.write_text("legacy_template_retention_seconds = \n")
        with self.assertRaises(SystemExit):
            dry()
        self.path.unlink()
        self.assertEqual(dry(), "")
        self.assertFalse(self.backup.exists())


if __name__ == "__main__":
    unittest.main()
