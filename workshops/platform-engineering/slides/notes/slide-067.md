A conceptual beat worth 60 seconds. The room just built choreography; name it, and name its opposite — because "how do I coordinate services?" has two canonical answers and a platform engineer should know when to reach for each.

Choreography (this capstone): event-driven, decoupled. Services emit and subscribe to facts; no component knows the topology. Resilient and extensible (add a Trigger, not a code change) — but the flow is emergent, harder to see end to end. Knative Eventing is the open-source shape of EventBridge / SQS→Lambda.

Orchestration: a central workflow drives an explicit sequence with retries, branching, and a visual execution graph. Easier to reason about and observe; more coupling to the orchestrator. AWS Step Functions is the reference — and the open analog is Argo Workflows, which you ALREADY ran in module 07: your in-cluster CI build is an Argo DAG. Same engine, same visual graph, no new tool.

The takeaway: you don't pick a winner — mature platforms offer both, and the skill is choosing. (We deliberately didn't build a dedicated orchestration module — it'd be a tangent in a platform-assembly workshop — but the engine and the concept are both already here.)
