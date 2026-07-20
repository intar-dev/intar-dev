# Hint 2: Cloning from your in-cluster Gitea

```bash
git clone http://gitea_admin:cloudbox123@localhost:30300/cloudbox/platform.git ~/cloudbox-platform
cd ~/cloudbox-platform
```

This is a *different remote* than github.com — it's the copy your cluster watches. Pushes
to GitHub change nothing in your workspace; pushes here change everything. (Alternative:
`seed-gitea.sh` printed a `git remote add cloudbox …` line — you can push to your Gitea
from the workshop checkout instead of cloning; then it's `git push cloudbox main`.)
