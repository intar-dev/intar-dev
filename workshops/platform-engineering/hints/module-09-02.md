# Hint 2: Upload works but no resizer pod appears

Follow the event, hop by hop:

1. Did the uploader get the file? `kubectl -n pipeline logs -l serving.knative.dev/service=uploader -c user-container --tail=20`
   — it logs the S3 key and the Broker's answer (expect `202 Accepted`).
2. Is the Trigger Ready and pointing at the resizer?
   `kubectl -n pipeline describe trigger resize-on-upload` — check the filter
   (`type: dev.cloudbox.image.uploaded`) and subscriber. If it stays `NotReady` with reason
   `BrokerNotConfigured`, it reconciled before the broker was Ready and latched — once the
   broker and both ksvcs are Ready, nudge it to re-reconcile with any harmless annotation
   change: `kubectl -n pipeline annotate trigger/resize-on-upload cloudbox.io/rereconcile="$(date +%s)" --overwrite`
   (exactly what `solve.sh` does).
3. The Broker's delivery side lives in ns `knative-eventing`:
   `kubectl -n knative-eventing logs deploy/mt-broker-filter --tail=20` and
   `deploy/imc-dispatcher` — delivery errors (and retries) land there.
