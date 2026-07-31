The task: enable portal.yaml (lands in ns portal in seconds — one small Go binary), open **Cloudbox Console** under **Workspace applications**, and for each page answer "which Kubernetes API is this?" — they installed every one of them today.

Star task: create console-db (size small) via the New database form, then prove it with kubectl: the WorkshopDatabase XR, and the composed CNPG cluster booting with -w. Then the governance question: this one didn't go through git — find the evidence, keep the thought for the explain-back.

Finish by actually reading the source — apps/portal/ is a few dozen small Go files (internal/kube/client.go for the API, one file per page under internal/web/) and a set of templates; ask them to find the 20 lines behind the form in internal/web/databases.go. "After today you can read every line of your platform's front door" is the sentence to leave hanging.

Open the Console's Workshop page now. It becomes available with module 08 and summarizes live cluster state; compare it with Intar's native verification view used earlier. The page is implemented in `workshop.go` in roughly 100 lines.
