#!/usr/bin/env bash
# image-ops workflow, tools-build job, "Verify runner disk tools" step.
test -x /usr/sbin/mke2fs
command -v zstd
