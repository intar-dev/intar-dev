# Hint 2: Interrogating Zot

Zot speaks the plain OCI registry API:

```bash
curl -s http://localhost:30500/v2/_catalog | jq .
curl -s http://localhost:30500/v2/hello-site/tags/list | jq .
```

Zot also has a small web UI on the same port.
