# Hint 2: The Host header dance

```bash
kubectl -n demo get ksvc hello -o jsonpath='{.status.url}'    # e.g. http://hello.demo.example.com
```

`example.com` is not public DNS for this guest — that's fine. The in-guest terminal test
only needs the header to match:

```bash
curl -H "Host: hello.demo.example.com" http://localhost:31080/
```

(`example.com` is Knative's default domain; a real install would set a real one +
wildcard DNS. Same mechanics.) For the browser view, use Intar's released **Knative**
app button; its fixed adapter supplies the route without exposing NodePort 31080.
