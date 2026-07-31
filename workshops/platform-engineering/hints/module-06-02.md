# Hint 2: The Host header dance

```bash
kubectl -n demo get ksvc hello -o jsonpath='{.status.url}'    # e.g. http://hello.demo.example.com
```

`example.com` obviously doesn't resolve to your learner VM — that's fine. HTTP routing only
needs the header to match:

```bash
curl -H "Host: hello.demo.example.com" http://localhost:31080/
```

(`example.com` is Knative's default domain; a real install would set a real one +
wildcard DNS. Same mechanics.)
