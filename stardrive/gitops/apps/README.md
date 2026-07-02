# Apps

Public apps should use the Cloudflare Tunnel ingress class.

Constraints:
- hostnames must be under your cluster base domain, for example `*.intar.app`
- routes should set `ingressClassName: cloudflare-tunnel`
- the controller reads `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_TUNNEL_NAME` from the shared Infisical operator path
- the Cloudflare API token needs Zone read, DNS edit, and Cloudflare Tunnel edit permissions

Example shape:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: example
  namespace: app
spec:
  ingressClassName: cloudflare-tunnel
  rules:
    - host: app.intar.app
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: example
                port:
                  number: 8080
```
