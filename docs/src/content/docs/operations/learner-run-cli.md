---
title: Learner run CLI
description: Use the in-run intar command from an SSH terminal.
---

Use `intar` inside an active learner run. It works over SSH. Each command does
one action and then exits. It does not open a menu, ask a
question, read standard input, or produce JSON.

## Commands

| Command | Use |
| --- | --- |
| `intar` | Show a short summary and the next useful command. |
| `intar status` | Show the current run summary. |
| `intar check` | Run fresh checks for the current VM. |
| `intar hints` | List safe hint targets and their state. |
| `intar hint <alias>` | Reveal an available hint for that target. |
| `intar solution` | Show the solution state, or a solution that is available. |
| `intar solution reveal` | Reveal the Scenario solution; an unsolved run becomes assisted. |
| `intar help` | Show the command list. |

The CLI has no JSON output. Use `intar help` to see its commands.

Run `intar hints` before you request a hint. It shows the aliases that you can
use. Bash completion can also show them.

Hint aliases name a hint ladder, such as `general` or `check-1`. The command
reveals only the next allowed hint in that ladder.

## Checks and browser updates

`intar check` runs checks now. It does not report an old cached result as a new
check. A failed check exits with status `1`; fix the work and run the command
again.

The command first updates the local check state. The Intar web view receives the
same safe result through its normal report path. This update is eventual, so the
web view can take a short time to show the new state. Do not treat a delayed web
update as proof that the check did not run.

The CLI prints safe check labels and states only. It does not print probe IDs,
commands, raw values, command output, or secrets.

## Hints and solutions

`intar hints` never shows a sealed hint body or title. `intar hint <alias>`
reveals only content that is available to the learner.

Scenario learners can run `intar solution reveal`. This action takes effect at
once. It shows the full solution. If the Scenario is not solved, it marks the
run as assisted. It does not ask for confirmation.

## Bash completion and plain output

Interactive SSH Bash sessions load completion automatically from
`/etc/bash.bashrc`. Press Tab to complete commands, `solution reveal`, and
currently available hint aliases. Completion is read-only. It stays silent when
the service is slow or unavailable, and it never exposes sealed content.

Completion is available for Bash only. The commands still work in other shells
and in non-interactive SSH commands.

Set `NO_COLOR=1` to force plain output. The CLI also disables color when
standard output is not a terminal, `TERM=dumb`, or CI is set. In a non-UTF-8
locale it uses ASCII status symbols. Plain output keeps text status labels and
contains no terminal escape sequences.

## Exit status

| Status | Meaning |
| --- | --- |
| `0` | The command completed. For `check`, all checks passed. |
| `1` | Checks ran, but one or more checks did not pass. |
| `2` | Command syntax is invalid. |
| `3` | The requested hint or solution is locked, exhausted, or unavailable. |
| `4` | Kino, the run broker, or the Intar control service is unavailable. |
| `130` | The command was interrupted. |

Use exit status for scripts. Text output is for people and is not a stable
machine interface.

## Rollout and troubleshooting

The CLI is available only in new learner environments created from CLI-ready
images after the platform enables the feature. Existing active runs and
workspaces do not gain it. Operators must deploy in this order:

1. Deploy the control plane with `LEARNER_RUN_CLI_V1_ENFORCEMENT=off`.
2. Deploy host agents and Kino, and then rebuild the Scenario images.
3. Confirm fresh host reports and image caches, then deploy
   `LEARNER_RUN_CLI_V1_ENFORCEMENT=on`.

The final setting makes KVM selection require `supports_run_cli_v1`. Keeping
it off during the earlier steps prevents an old host inventory from blocking
all KVM allocations while the new images are still being prepared.

| Problem | Action |
| --- | --- |
| `intar: command not found` | This is an older environment. Start a new run after the feature is enabled. |
| `intar check` exits `1` | This is a real failed check. Repair the work, then run `intar check` again. |
| A hint is unavailable | Run `intar hints` and use a listed alias. Scenario hint ladders must stay in order. |
| The CLI exits `4` | The run is still open. Retry after a short wait. If it continues, reconnect through Intar and check the run state. |
| Tab completion is missing | Use an interactive Bash SSH session. Reconnect through the normal Intar SSH terminal. |

Do not copy broker sockets, credentials, or raw Kino data out of a learner
environment to work around an unavailable command.
