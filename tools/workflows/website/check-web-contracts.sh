#!/usr/bin/env bash
# Website workflow, validate job, step "Check web contracts".
bun run check:imports
bun run check:deploy
bun run check:vm-boot-benchmark
bun run check:database-migrations
