#!/usr/bin/env python3
"""The weekly kernel update job, step "Pin the kernels": pin.py AMD64 ARM64.

AMD64 and ARM64 are the SHA-256 of the two kernel archives the build made.
Writes the pins that follow from a build into crates/intar-image-build/src:
KERNEL_ARTIFACT_SET (the set this source builds, as kernel_inputs prints it),
the two KERNEL_ARTIFACT_SHA256_* constants, and the baked platform digest that
platform.rs's test pins. `cargo test -p intar-image-build` passes afterwards.
"""

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "crates/intar-image-build/src"
PLATFORM_TEST = "the_baked_platform_is_pinned_to_the_image_format"


def replace_once(path: Path, pattern: str, value: str) -> None:
    """Replaces the pattern's one capture group, which must match once."""
    source = path.read_text()
    found = re.findall(pattern, source)
    if len(found) != 1:
        sys.exit(f"pin.py: expected one match of {pattern!r} in {path.name}, found {len(found)}")
    span = re.search(pattern, source).span(1)
    path.write_text(source[: span[0]] + value + source[span[1] :])


def platform_test() -> subprocess.CompletedProcess:
    return subprocess.run(
        ["cargo", "test", "--locked", "--quiet", "-p", "intar-image-build", "--lib", PLATFORM_TEST],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("usage: pin.py <amd64 sha256> <arm64 sha256>")
    amd64, arm64 = sys.argv[1:]
    for arch, sha256 in (("amd64", amd64), ("arm64", arm64)):
        if not re.fullmatch(r"[0-9a-f]{64}", sha256):
            sys.exit(f"pin.py: the {arch} checksum is not 64 lowercase hex characters: {sha256!r}")

    with tempfile.TemporaryDirectory() as scratch:
        inputs = subprocess.run(
            ["cargo", "run", "--locked", "--quiet", "-p", "intar-image-build", "--example", "kernel_inputs", "--", "amd64", scratch],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            text=True,
            check=True,
        )
    kernel_set = json.loads(inputs.stdout)["set"]
    if not re.fullmatch(r"[0-9a-f]{12}", kernel_set):
        sys.exit(f"pin.py: kernel_inputs printed an unexpected set: {kernel_set!r}")

    kernel_rs = SRC / "kernel.rs"
    replace_once(kernel_rs, r'pub const KERNEL_ARTIFACT_SET: &str =\s*"([^"]*)";', kernel_set)
    replace_once(kernel_rs, r'const KERNEL_ARTIFACT_SHA256_AMD64: &str =\s*"([^"]*)";', amd64)
    replace_once(kernel_rs, r'const KERNEL_ARTIFACT_SHA256_ARM64: &str =\s*"([^"]*)";', arm64)

    # ponytail: the digest is read from the failing assertion's "left:" line,
    # which depends on how assert_eq! prints. Export baked_platform_digest()
    # from an example (as kernel_inputs does the set) when that ever breaks.
    test = platform_test()
    if test.returncode != 0:
        actual = re.search(r'left: \("[^"]*", "([0-9a-f]{64})"\)', test.stdout + test.stderr)
        if not actual:
            sys.exit(f"pin.py: {PLATFORM_TEST} failed without printing a digest:\n{test.stdout}{test.stderr}")
        replace_once(
            SRC / "platform.rs",
            r'const PINNED: \(&str, &str\) = \(\s*"[^"]*",\s*"([0-9a-f]{64})",?\s*\);',
            actual.group(1),
        )
        test = platform_test()
        if test.returncode != 0:
            sys.exit(f"pin.py: {PLATFORM_TEST} still fails:\n{test.stdout}{test.stderr}")
    print(f"pinned kernel set {kernel_set}")


if __name__ == "__main__":
    main()
