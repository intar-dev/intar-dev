# Hint 1: Enabling + delivering, condensed

In your Gitea clone:

```bash
cp gitops/catalog/knative-serving.yaml gitops/apps/
cp /opt/platform-engineering-workshop/lab/06-serverless/hello-ksvc.yaml gitops/components/demo/
git add . && git commit -m "knative + hello service" && git push
```

Knative's webhooks take a minute to come up; the demo app retries. Watch:
`kubectl -n knative-serving get pods` and `kubectl -n demo get ksvc -w`.
