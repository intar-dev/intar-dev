# Hint 1: Submitting and following the workflow

```bash
kubectl create -f workflow-run.yaml     # create, not apply (generateName)
kubectl -n builds get workflows -w      # until Succeeded
# logs of the latest workflow's pods:
kubectl -n builds get pods
kubectl -n builds logs  -f
```

If it fails immediately with a parameter error, the template's inputs may differ — read
them: `kubectl -n builds get workflowtemplate build-and-push -o yaml | head -40`.

If the *build step* fails resolving `zot.zot.svc.cluster.local:5000/library/busybox` —
did you seed the base image (task step 3)? Check with
`curl -s http://localhost:30500/v2/library/busybox/tags/list`.
