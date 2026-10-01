#!/usr/bin/env bash
# Called by update-release-pr.sh: set MANIFEST's package version to VERSION and
# move PACKAGE's one Cargo.lock entry with it. A text edit, because Cargo cannot
# resolve the workspace without the prepared libnbd bindings.
set -euo pipefail
python3 - <<'PY'
import os
import pathlib
import re

manifest = pathlib.Path(os.environ["MANIFEST"])
package = os.environ["PACKAGE"]
version = os.environ["VERSION"]
text = manifest.read_text()
match = re.search(r'(?m)^version = "([^"]+)"', text)
if match is None:
    raise SystemExit(f"failed to update package version in {manifest}")

def semver(value):
    parsed = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", value)
    if parsed is None:
        raise SystemExit(f"unsupported package version: {value}")
    return tuple(map(int, parsed.groups()))

current = match.group(1)
if semver(current) > semver(version):
    raise SystemExit(
        f"refusing to downgrade {manifest} from {current} to {version}"
    )
lock = pathlib.Path("Cargo.lock")
entry = re.compile(
    rf'^(\[\[package\]\]\nname = "{re.escape(package)}"\nversion = )"([^"]+)"$',
    re.MULTILINE,
)
lock_text = lock.read_text()
entries = entry.findall(lock_text)
if len(entries) != 1 or entries[0][1] != current:
    raise SystemExit(
        f"Cargo.lock must hold exactly one {package} {current} entry, found {entries}"
    )
manifest.write_text(text[:match.start()] + f'version = "{version}"' + text[match.end():])
lock.write_text(entry.sub(rf'\g<1>"{version}"', lock_text))
PY
