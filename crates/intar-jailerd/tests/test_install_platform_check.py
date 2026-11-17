"""install.sh's preflight for a hand-written intar-platform-check.service."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
INSTALL = (HERE.parent / "deploy/install.sh").read_text()
BLOCK = INSTALL[
    INSTALL.index("# INTAR_INSTALL_PLATFORM_CHECK_BEGIN") : INSTALL.index("# INTAR_INSTALL_PLATFORM_CHECK_END")
]
HARNESS = """set -eu
die() { echo "die: $*" >&2; exit 1; }
unit_loaded() { [ "$(systemctl show --property=LoadState --value "$1")" != not-found ]; }
"""
# A fake systemctl: $LOAD, $ENABLED, $PULLED; every call is logged.
FAKE = """#!/bin/sh
echo "$*" >> "$LOG"
case "$*" in
  *LoadState*) echo "$LOAD" ;;
  is-enabled*) echo "$ENABLED"; [ "$ENABLED" = enabled ] ;;
  "disable --quiet"*) ;;
  *WantedBy*) printf '%s\\n' "$PULLED" ;;
  *) exit 9 ;;
esac
"""


def preflight(load, enabled, pulled=""):
    with tempfile.TemporaryDirectory() as directory:
        fake = Path(directory) / "systemctl"
        fake.write_text(FAKE)
        fake.chmod(0o755)
        log = Path(directory) / "log"
        log.touch()
        env = {**os.environ, "PATH": f"{directory}:{os.environ['PATH']}", "LOG": str(log),
               "LOAD": load, "ENABLED": enabled, "PULLED": pulled}
        result = subprocess.run(["sh", "-c", HARNESS + BLOCK], env=env, capture_output=True, text=True)
        return result, log.read_text()


class PlatformCheckPreflight(unittest.TestCase):
    def test_a_missing_unit_is_left_alone(self):
        result, log = preflight("not-found", "")
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("disable", log)

    def test_an_enabled_unit_is_disabled_once_with_one_line(self):
        result, log = preflight("loaded", "enabled")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("disable --quiet intar-platform-check.service", log)
        self.assertEqual(result.stdout.count("Disabled intar-platform-check.service"), 1)

    def test_a_disabled_unit_prints_nothing(self):
        result, log = preflight("loaded", "disabled")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("disable --quiet", log)
        self.assertEqual(result.stdout, "")

    def test_a_unit_still_pulled_in_refuses_and_names_the_units(self):
        result, _ = preflight("loaded", "disabled", "intar-agent.service\n\nmulti-user.target")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("still pulled in by: intar-agent.service multi-user.target.", result.stderr)

    def test_the_refusal_comes_before_anything_is_stopped(self):
        check = INSTALL.index("# INTAR_INSTALL_PLATFORM_CHECK_END")
        for later in ("mutated=false", "systemctl stop intar-jailerd.socket", "publish_file \"${archive_dir}/intar-agent\""):
            self.assertLess(check, INSTALL.index(later), later)


if __name__ == "__main__":
    unittest.main()
