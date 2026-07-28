The task: enable portal.yaml (lands in ns portal in seconds — one small Go binary), explore the Console at :30600, and for each page answer "which Kubernetes API is this?" — they installed every one of them today.

Star task: create console-db (size small) via the New database form, then prove it with kubectl: the WorkshopDatabase XR, and the composed CNPG cluster booting with -w. Then the governance question: this one didn't go through git — find the evidence, keep the thought for the explain-back.

Finish by actually reading the source — apps/portal/ is a few dozen small Go files (internal/kube/client.go for the API, one file per page under internal/web/) and a set of templates; ask them to find the 20 lines behind the form in internal/web/databases.go. "After today you can read every line of your platform's front door" is the sentence to leave hanging.

Also point out the Workshop page they've been watching all day lives in this same binary (workshop.go) — a checklist inferred from live cluster state, ~100 lines.
