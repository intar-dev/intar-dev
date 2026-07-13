#!/usr/bin/env python3
"""Emit the third-party dependency inventory for the shipped host binaries."""

import json
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: generate-dependency-inventory.py METADATA OUTPUT")
    metadata = json.loads(Path(sys.argv[1]).read_text())
    packages = {package["id"]: package for package in metadata["packages"]}
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    roots = {
        package["id"]
        for package in metadata["packages"]
        if package["name"] in {"intar-agent", "intar-jailer", "intar-jailerd"}
    }
    reachable = set(roots)
    pending = list(roots)
    while pending:
        node = nodes.get(pending.pop())
        if node is None:
            continue
        for dependency in node["dependencies"]:
            if dependency not in reachable:
                reachable.add(dependency)
                pending.append(dependency)

    inventory = []
    for package_id in sorted(reachable):
        package = packages[package_id]
        if package["source"] is None:
            continue
        inventory.append(
            {
                "name": package["name"],
                "version": package["version"],
                "license": package["license"],
                "license_file": package["license_file"],
                "repository": package["repository"],
                "source": package["source"],
            }
        )
    Path(sys.argv[2]).write_text(
        json.dumps({"schema_version": 1, "packages": inventory}, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
