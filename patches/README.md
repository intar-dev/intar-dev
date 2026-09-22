The `@better-auth/sso` patch passes token authentication method `none` to
Better Auth's existing public-client token exchange. The upstream SSO callback
otherwise defaults to `client_secret_basic`.

Organization registration validates discovery metadata. The OIDC adapter allows
only public clients, enforces PKCE S256, and requires a verified ID token.
`auth.workers.test.ts` covers the actual token request and callback.
Remove this patch when the SSO library supports `none` directly.
