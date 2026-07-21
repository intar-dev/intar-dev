# Full solution

The complete root cause, evidence chain, rolling-update behavior, and canonical Git
repair are in
[scenarios/01-bad-release-rollback/description.md](scenarios/01-bad-release-rollback/description.md).

Mechanically, `./restore.sh 1` finds the traced release commit, runs `git revert`, and
pushes the new commit. `./solve.sh` reverts every scenario that is currently injected.
