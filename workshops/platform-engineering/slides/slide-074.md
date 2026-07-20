# Eyes vs. hands

    Eyes · the agent
    Read-only ClusterRole (`kagent-tools.rbac.readOnly: true`) plus `--read-only` at the tool server. The agent CR still lists `apply`/`patch`/`delete` — it may try; both layers refuse the call. It can look; it cannot touch.

    Hands · git, always
    Fixes render as copy-paste `git revert` commands — never an apply button. The Kagent API has **no in-cluster auth**; the Console is its one trusted caller.

The module's rule: **the agent gets eyes; git keeps the hands.**
