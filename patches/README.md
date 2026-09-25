The `@better-auth/sso` patch adds two things the pinned release lacks. Both
are still missing from the latest release (1.7.5) and from upstream `main`.

1. Token authentication method `none`. The SSO callback maps every method it
   doesn't know to `client_secret_basic`, and Better Auth core then refuses the
   token request because a public client has no secret. The patch passes
   `none` to core's existing public-client token exchange.
2. A `beforeOIDCUserResolution` option. The callback calls it after the ID
   token is verified and before the plugin resolves a user by subject or email;
   a returned URL finishes the callback with a redirect. Intar uses it to bind
   an explicit organization link to the signed-in account whatever email the
   provider returns; the plugin still requires the ID token to carry one before
   the hook runs. Upstream's equivalent, `resolveUser` (1.7.x), requires
   native interactive transactions, which Cloudflare D1 doesn't provide.

Organization registration validates discovery metadata. The OIDC adapter allows
only public clients, enforces PKCE S256, and requires a verified ID token.
`auth.workers.test.ts` and `organization-sso.workers.test.ts` cover the actual
token request, the callback, and the link hook.

Remove the `none` hunk when the SSO library supports `none` directly, and the
link hook once auth data lives in a store with interactive transactions so
`resolveUser` can replace it.
