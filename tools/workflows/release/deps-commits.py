"""Called by update-release-pr.sh: python3 deps-commits.py PACKAGE BASE.

Prints "<sha> <subject>" for each dependency fix between BASE and HEAD that
changes a crate PACKAGE ships, for git-cliff's --with-commit. git-cliff maps a
commit to a product by the paths it touches, and the root Cargo.toml and
Cargo.lock belong to no product. A feat, fix, or build commit with the deps
scope that touches only those two files counts for a product when its
Cargo.lock change adds, removes, or edits a package in the product package's
dependency closure, before or after the change. Cargo.lock is read as TOML,
because Cargo cannot resolve the workspace without the prepared libnbd
bindings.

ponytail: Cargo.lock also lists the workspace crates' dev-dependencies and
every target's dependencies, so the closure can be wider than what ships and a
dev-only bump can release a patch; `cargo tree -e normal,build` per release
target is exact once the workspace resolves without the bindings.
"""

import re
import subprocess
import sys
import tomllib

DEPS_FIX = re.compile(r"(feat|fix|build)\(deps\)!?: ")
ROOT_FILES = {"Cargo.toml", "Cargo.lock"}


def git(*args):
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True
    ).stdout


def lock(rev):
    packages = tomllib.loads(git("show", f"{rev}:Cargo.lock"))["package"]
    return {(p["name"], p["version"], p.get("source", "")): p for p in packages}


def closure(packages, package):
    by_name = {}
    for key in packages:
        by_name.setdefault(key[0], []).append(key)
    # The product is a workspace member, which has no source.
    todo = [key for key in by_name.get(package, []) if not key[2]]
    seen = set()
    while todo:
        key = todo.pop()
        if key in seen:
            continue
        seen.add(key)
        # "name", "name version" when several versions are locked, and
        # "name version (source)" when several sources lock that version.
        for dependency in packages[key].get("dependencies", []):
            name, _, rest = dependency.partition(" ")
            version, _, source = rest.partition(" ")
            todo += [
                k
                for k in by_name.get(name, [])
                if version in ("", k[1]) and source in ("", f"({k[2]})")
            ]
    return seen


def main(package, base):
    for line in git("log", "--format=%H %s", f"{base}..HEAD").splitlines():
        sha, _, subject = line.partition(" ")
        if not DEPS_FIX.match(subject):
            continue
        files = set(git("diff-tree", "--no-commit-id", "--name-only", "-r", sha).splitlines())
        if "Cargo.lock" not in files or not files <= ROOT_FILES:
            continue
        before, after = lock(f"{sha}^"), lock(sha)
        changed = {k for k in before.keys() | after.keys() if before.get(k) != after.get(k)}
        if changed & (closure(before, package) | closure(after, package)):
            print(line)


if __name__ == "__main__":
    main(*sys.argv[1:])
