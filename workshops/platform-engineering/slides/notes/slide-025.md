Once the platform's portal is running (it arrives via the catalog; you'll meet it properly in module 08), its Workshop page shows a checklist of all ten modules — each row inferred from your live cluster state: nodes ready, kube-proxy absent, Gitea healthy, a CNPG cluster in demo, WorkshopDatabases present, thumbnails in the images bucket, and so on.

Two honest caveats to mention: it's a hint, not a judge — verify.sh in each lab folder is the authoritative check; and module 05 (fault-fixing) can't be inferred from end-state at all.

We'll keep it on the projector between modules as the room's shared progress board. It's also a nice teaser: the page itself is ~100 lines of Go reading the Kubernetes API — you'll read its source in module 08.

Now — let's make sure everyone's laptop is ready. Module 00.
