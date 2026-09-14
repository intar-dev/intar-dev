"""Focused checks for the published-image verifier's initramfs contract.

The verifier unpacks an initrd with unmkinitramfs, so each fixture swaps that
program for a stub that writes a fixed tree. No test needs a real initrd.
"""

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "image-build" / "verify-published-image.py"
SPEC = importlib.util.spec_from_file_location("verify_published_image", SCRIPT)
assert SPEC and SPEC.loader
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


# The required files, written here instead of read from the verifier: dropping
# one from the verifier's own list must make these tests fail.
REQUIRED_INITRAMFS_FILES = ("init", "bin/busybox", "sbin/e2fsck.static")


class InitramfsTest(unittest.TestCase):
    def stub_unmkinitramfs(self, root: Path, files: tuple[str, ...]) -> Path:
        listing = "\n".join(
            f'mkdir -p "$work/{Path(name).parent}"; : > "$work/{name}"' for name in files
        )
        path = root / "unmkinitramfs"
        path.write_text(f'#!/bin/sh\nwork="$2"\nmkdir -p "$work"\n{listing}\n', encoding="utf-8")
        path.chmod(0o755)
        return path

    def run_check(self, files: tuple[str, ...]) -> dict[str, bool]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stub = self.stub_unmkinitramfs(root, files)
            evidence = verifier.Evidence()
            verifier.check_initrd(evidence, stub, root / "initrd.img", root)
            return {item["name"]: item["passed"] for item in evidence.checks}

    def test_the_custom_initramfs_tree_passes(self) -> None:
        result = self.run_check(REQUIRED_INITRAMFS_FILES)
        self.assertTrue(result["initramfs carries busybox, e2fsck, and init"])

    def test_an_incomplete_tree_is_refused(self) -> None:
        for missing in REQUIRED_INITRAMFS_FILES:
            with self.subTest(missing=missing):
                files = tuple(name for name in REQUIRED_INITRAMFS_FILES if name != missing)
                result = self.run_check(files)
                self.assertFalse(result["initramfs carries busybox, e2fsck, and init"])


if __name__ == "__main__":
    unittest.main()
