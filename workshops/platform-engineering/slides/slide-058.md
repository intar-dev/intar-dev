# Two write planes — by audience

    Platform plane · **GitOps**
    `git push → ArgoCD`. Installing capabilities, the catalog, **RBAC grants**. High blast-radius → wants audit + rollback. You drive it on the CLI; the console *reflects* it.

    Tenant plane · **Console-direct**
    `form → K8s API`. Databases, functions, apps, projects. Self-service → wants *instant* feedback. `kubectl create`, from a form — no git round-trip.

Git changes the platform · the console **uses** the platform · `kubectl` inspects both.
