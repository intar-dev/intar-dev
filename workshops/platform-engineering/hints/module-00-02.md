# Hint 2: A pinned tool is "not found"

First confirm you are in the provisioned workshop terminal and the baked repository
exists:

```bash
test -d /opt/platform-engineering-workshop
command -v talosctl kubectl helm cilium jq git curl
```

Do not run `apt`, `mise install`, or a download script. A missing command violates the
sealed checkpoint contract. Click **Need help** so the facilitator can restore checkpoint
00 or reprovision the workspace.
