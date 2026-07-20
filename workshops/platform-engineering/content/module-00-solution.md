# Canonical solution for module 00

This Intar adaptation verifies the sealed checkpoint contract. Reveal it only after the
learner has chosen to see the solution.

```bash
#!/usr/bin/env bash
set -euo pipefail

cd /opt/platform-engineering-workshop

# Read-only pre-flight: checkpoint 00 already contains the tools and images.
./scripts/install.sh --check

cd lab/00-setup
./verify.sh
```

If either command reports a missing tool, image, or resource, stop. Use **Need help**;
the facilitator should restore checkpoint 00 or reprovision the workspace instead of
mutating the learner VM with an install or pull.
