# Full solution

The complete ImagePullBackOff evidence chain, workshop registry constraint, and canonical
Git repair are in
[scenarios/03-dockerhub-imagepull/description.md](scenarios/03-dockerhub-imagepull/description.md).

Mechanically, `./restore.sh 3` finds the traced registry commit, runs `git revert`, and
pushes the new commit. `./solve.sh` reverts every scenario that is currently injected.
