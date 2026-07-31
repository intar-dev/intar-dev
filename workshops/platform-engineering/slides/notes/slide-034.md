The second mechanic to internalize, because every module from 03 onward starts with it: platform capabilities live as a catalog of ready-made ArgoCD Application manifests in gitops/catalog/. Enabling one = copying it into gitops/apps/, committing, pushing to your own Gitea. ArgoCD notices and converges.

This is a real pattern, scaled down: the catalog is the platform team's menu; the apps directory is the cluster's order. Later, module 08 uses bundled Backstage screenshots to compare its software-template model with this loop.

No kubectl apply for platform components, all day. If someone is tempted to shortcut with kubectl: it will work, and then ArgoCD will quietly revert it — which is itself a lesson worth having on the projector.
