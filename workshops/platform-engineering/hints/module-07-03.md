# Hint 3: The deployment can't pull the image?

Mind the two vantage points: the *build* pushed to `zot.zot.svc.cluster.local:5000`
(cluster DNS — pods can resolve that), but the *kubelet* pulls from the node, where
cluster DNS doesn't exist — that's why `hello-site.yaml` uses `localhost:30500`
(Zot's NodePort, reached from the node itself; containerd allows plain HTTP for
localhost registries). If the pull fails: first confirm the image exists in Zot
(hint 2), then `kubectl -n demo describe pod` and read the exact pull error.
