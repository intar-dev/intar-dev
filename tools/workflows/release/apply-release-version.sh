#!/usr/bin/env bash
# release.yml, job release, step "Apply release version".
set -euo pipefail
python3 - <<'PY'
import os
import pathlib
import re

manifest = pathlib.Path(os.environ["MANIFEST"])
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
        f"refusing to downgrade {manifest} from {current} to {version}; "
        "choose the matching release bump"
    )
updated = text[:match.start()] + f'version = "{version}"' + text[match.end():]
manifest.write_text(updated)
PY
tools/image-build/with-libnbd-env.sh --rust-only -- cargo update -p "${PACKAGE}" --precise "${VERSION}"
