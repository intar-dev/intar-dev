#!/usr/bin/env bash
# ci.yml, job pr-title. A squash merge commits the pull request title (merge
# settings in ci/README.md), and git-cliff versions and describes the releases
# from those commits, so the title must be a Conventional Commit with one scope
# (see AGENTS.md):
# type(scope): subject, with an optional ! before the colon and a subject that
# does not start with a capital. The title arrives in PR_TITLE, never as script
# text, and is never printed.
set -euo pipefail
export LC_ALL=C
title="${PR_TITLE?PR_TITLE must hold the pull request title}"
re='^(feat|fix|perf|refactor|build|chore|ci|docs|style|test|revert)\([a-z0-9][a-z0-9/._-]*\)!?: [^A-Z[:space:]]'
if [[ "${title}" != *[[:cntrl:]]* && "${title}" =~ ${re} ]]; then
  exit 0
fi
cat >&2 <<'EOF'
The pull request title must be a Conventional Commit with one scope, such as
"fix(web): keep the session on reload" or "feat(intar-agent)!: drop the v1 probes".
Types: feat, fix, perf, refactor, build, chore, ci, docs, style, test, revert.
The scope is lowercase, and the subject does not start with a capital.
EOF
exit 1
