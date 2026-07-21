# Projects = namespaces

    A project *is* a namespace
    The top-bar selector maps 1:1 to namespaces. Switch project → every self-service page scopes to it. The tenancy unit every cloud console has (GCP projects, Nais teams).

    "New project", console-direct
    Provisions a namespace **+** binds the portal's tenant grant into it — so your databases and apps land there. Behind a **scoped**, git-delivered grant: namespaces + `bind` on exactly `portal-tenant`.

The platform pattern in miniature: **grant via git** (scoped, once) · **act via console** (self-service).
