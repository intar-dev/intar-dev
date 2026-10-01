"""Called by update-release-pr.sh: python3 deps-commits.py BASE PRODUCT.

PRODUCT is the product's products.json entry as JSON. Prints "<sha> <subject>"
for each dependency fix between BASE and HEAD that changes a crate the product
ships, for git-cliff's --with-commit. git-cliff maps a commit to a product by
the paths it touches, and the root Cargo.toml and Cargo.lock belong to no
product. A feat, fix, or build commit with the deps scope that touches only
those two files counts for a product when, before or after the change, it:

- adds, removes, or edits a Cargo.lock package in the dependency closure of the
  product's workspace crates: its package and each crates/<name>/** in its
  paths, such as the agent's jailer and jailerd, whose binaries ship in the
  agent's archive;
- changes a [workspace.dependencies] entry (version, features) for a package
  one of those crates depends on directly; or
- changes anything else in the root Cargo.toml, such as a profile or a patch,
  which counts for every product.

Both files are read as TOML, because Cargo cannot resolve the workspace without
the prepared libnbd bindings.

ponytail: Cargo.lock also lists the workspace crates' dev-dependencies and
every target's dependencies, so the closure can be wider than what ships and a
dev-only bump can release a patch; `cargo tree -e normal,build` per release
target is exact once the workspace resolves without the bindings.
"""

import json
import re
import subprocess
import sys
import tomllib

DEPS_FIX = re.compile(r"(feat|fix|build)\(deps\)!?: ")
ROOT_FILES = {"Cargo.toml", "Cargo.lock"}
CRATE_PATH = re.compile(r"crates/([^/]+)/\*\*")


def git(*args):
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True
    ).stdout


def toml(rev, path):
    return tomllib.loads(git("show", f"{rev}:{path}"))


def manifest(rev):
    """The root Cargo.toml without [workspace.dependencies], and that table."""
    root = toml(rev, "Cargo.toml")
    return root, root.get("workspace", {}).pop("dependencies", {})


def shipped(rev, crates):
    """Cargo.lock's packages, the closure of crates, and the names they use."""
    packages = {
        (p["name"], p["version"], p.get("source", "")): p
        for p in toml(rev, "Cargo.lock")["package"]
    }
    by_name = {}
    for key in packages:
        by_name.setdefault(key[0], []).append(key)
    # "name", "name version" when several versions are locked, and
    # "name version (source)" when several sources lock that version.
    edges = {}
    for key, package in packages.items():
        edges[key] = []
        for dependency in package.get("dependencies", []):
            name, _, rest = dependency.partition(" ")
            version, _, source = rest.partition(" ")
            edges[key] += [
                k
                for k in by_name.get(name, [])
                if version in ("", k[1]) and source in ("", f"({k[2]})")
            ]
    # A workspace crate has no source.
    todo = [key for key in packages if key[0] in crates and not key[2]]
    seen = set()
    while todo:
        key = todo.pop()
        if key not in seen:
            seen.add(key)
            todo += edges[key]
    direct = {d[0] for key in seen if not key[2] for d in edges[key]}
    return packages, seen, direct


def main(base, product):
    product = json.loads(product)
    crates = {product["package"]} | {
        m[1] for path in product["paths"] if (m := CRATE_PATH.fullmatch(path))
    }
    for line in git("log", "--format=%H %s", f"{base}..HEAD").splitlines():
        sha, _, subject = line.partition(" ")
        if not DEPS_FIX.match(subject):
            continue
        files = set(git("diff-tree", "--no-commit-id", "--name-only", "-r", sha).splitlines())
        if not files <= ROOT_FILES:
            continue
        (rest, deps), (rest_after, deps_after) = manifest(f"{sha}^"), manifest(sha)
        if rest != rest_after:
            print(line)
            continue
        # A renamed entry names its package in "package".
        names = {
            entry.get("package", key) if isinstance(entry, dict) else key
            for key in deps.keys() | deps_after.keys()
            if deps.get(key) != deps_after.get(key)
            for entry in (deps.get(key), deps_after.get(key))
        }
        before, closure, direct = shipped(f"{sha}^", crates)
        after, closure_after, direct_after = shipped(sha, crates)
        changed = {k for k in before.keys() | after.keys() if before.get(k) != after.get(k)}
        if changed & (closure | closure_after) or names & (direct | direct_after):
            print(line)


if __name__ == "__main__":
    main(*sys.argv[1:])
