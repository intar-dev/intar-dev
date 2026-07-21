# Hint 3: The change itself

```bash
cd ~/cloudbox-platform
cp /opt/platform-engineering-workshop/lab/02-gitops/demo-app.yaml gitops/apps/demo.yaml
mkdir -p gitops/components/demo
cp /opt/platform-engineering-workshop/lab/02-gitops/welcome.yaml gitops/components/demo/welcome.yaml
$EDITOR gitops/components/demo/welcome.yaml    # your name in 'owner'
git add . && git commit -m "demo app: welcome configmap" && git push
```

Then watch: `kubectl get application -n argocd -w` or the UI. ArgoCD polls every ~3 min —
the Refresh button in the UI (or `argocd app sync`) skips the wait.
