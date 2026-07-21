# Hint 4: Prove the decoupling (what the explain-back is about)

Scale the resizer away and upload anyway. The Trigger keeps retrying delivery — watch
`kubectl -n knative-eventing logs deploy/imc-dispatcher -f` while the resizer is gone,
then let it come back and see the event land. Then ask the uncomfortable question: this
Broker is backed by an **in-memory** channel — what happens to waiting events if the
`imc-dispatcher` pod itself restarts? (That's why production brokers ride on Kafka —
and why this one deliberately doesn't; it's a lab.)
