# Hint 2: Interrogating Zot

Zot speaks the plain OCI registry API:

```bash
curl -s http://localhost:30500/v2/_catalog | jq .
curl -s http://localhost:30500/v2/hello-site/tags/list | jq .
```

Those are in-guest API checks. Open **Zot Registry** from the workshop app buttons for
the browser UI; do not type a localhost URL into your local browser.
