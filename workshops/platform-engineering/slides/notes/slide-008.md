Walk the three, slowly — this is the mental model the whole day hangs on:

1. Primitives: a cloud sells you building blocks — a database, a bucket, a function — each behind an API, not a rack you wire up. You compose primitives; you don't assemble servers.
2. Control plane: behind every "managed" service is a control loop that provisions, monitors, fails over, backs up. That software is the product. When you pay for RDS, you're paying for that loop, not for Postgres.
3. Self-service: the thing that made cloud feel like magic in 2008 wasn't virtualization — it was that a developer could *ask* for a database and get one in minutes, with no human in the loop.

Now the punchline that sets up the table: Kubernetes is a control plane. Operators are the control loops. Git is the self-service front door. Every ingredient is open source — so a cloud is a thing you can just... run. Here's the shopping list.
