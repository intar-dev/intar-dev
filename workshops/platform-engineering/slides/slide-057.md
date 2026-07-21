# A portal is just REST calls

- ~6k lines of Go + htmx you can read end to end
- Reads the K8s API with a ServiceAccount token
- A scoped read-only role — the surfaces it renders, not read-all
- The DB form? Creates a `WorkshopDatabase`
- Module 04 already did the hard part

Shown → a component's live **Monitoring** page: per-component metrics, logs & traces from the OTel stack, server-rendered, offline, light + dark.

 **Cloud parallel:** the AWS · Azure · GCP Console — except this one is plain Go you can read end to end, not a product you log into.
