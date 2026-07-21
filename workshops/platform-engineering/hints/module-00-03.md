# Hint 3: The offline mirror check fails

The image builder populated the local `cloudbox-mirror` before sealing checkpoint 00.
Check the guest-local service without pulling anything:

```bash
docker ps --filter name=cloudbox-mirror
curl -fsS http://localhost:5001/v2/_catalog | jq .
```

Here `localhost` is correct because this is an in-guest terminal request. If the mirror
is absent or incomplete, click **Need help**; restore checkpoint 00 rather than contacting
an external registry.
