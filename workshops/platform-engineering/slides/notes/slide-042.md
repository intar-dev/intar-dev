The concept: developers shouldn't need to know CNPG, storage classes, or RustFS endpoints. Platform engineering is building the abstraction — you define WHAT can be asked for (an XRD: the WorkshopDatabase schema), and HOW it's fulfilled (a Composition), and developers just write a 10-line resource.

Crossplane is the machinery: the XR (composite resource) comes in, the composition pipeline runs, and out come real resources — a CNPG Cluster AND a Job that creates the matching S3 bucket. One request, a whole wired stack.

The punchline for the room: this is exactly what `aws rds create-db-instance` is — a small request against an API someone composed into real infrastructure. The difference is that after this module, YOU own both sides of that API.

Lab flow: enable crossplane.yaml from the catalog, ship the two halves of the platform API (xrd.yaml — read the schema!, composition.yaml) via git, confirm the XRD is ESTABLISHED, then switch hats and be the developer: push examples/my-database.yaml and watch the stack unfold.
