The task: enable crossplane.yaml from the catalog (installs Crossplane v2, the patch-and-transform function, and the RBAC letting it manage CNPG Clusters and Jobs). Ship the platform API — the XRD and the Composition from the lab's platform/ dir — as a new component via git. Then be the developer: push the 10-line example WorkshopDatabase and watch the XR, the composed CNPG Cluster, and the bucket Job appear.

Watching the stack unfold is the win: kubectl get workshopdatabase, then the Cluster booting, then the Job completing.

Explain-back: "walk your neighbor through what happened between your 10-line YAML and the running Postgres — name each controller that acted." (ArgoCD delivered it, Crossplane composed it, CNPG realized it.)

Helper note: the classic failure is an XRD that never goes ESTABLISHED because of a schema typo — kubectl describe xrd shows why. And anyone pattern-matching from v1 tutorials will trip exactly as the warning slide predicted; that's a teachable moment, not a bug.

This module's API is load-bearing later: module 08's portal form creates exactly these WorkshopDatabase resources.
