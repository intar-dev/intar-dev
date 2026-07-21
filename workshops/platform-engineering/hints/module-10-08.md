# Full solution

The complete OOMKill evidence chain, restart cadence, and canonical Git repair are in
[scenarios/02-oomkill-crashloop/description.md](scenarios/02-oomkill-crashloop/description.md).

Mechanically, `./restore.sh 2` finds the traced rightsizing commit, runs `git revert`, and
pushes the new commit. `./solve.sh` reverts every scenario that is currently injected.
