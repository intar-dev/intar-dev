---
name: verify
description: Drive the website's API surface end-to-end locally — mint real sessions without GitHub OAuth, then curl authenticated endpoints.
---

# Verifying website/ changes at the running server

## Launch

```bash
# Node: repo pins website/.node-version; run tools through it
fnm exec --using=$(cat .node-version) bun run dev   # daemonizes (astro dev), port 4321
fnm exec --using=$(cat .node-version) bunx astro dev stop   # stop the daemon
```

`bun run db:migrate:local` applies migrations to the local D1 first.

## Auth without GitHub OAuth

better-auth has `emailAndPassword` enabled and the `username()` plugin, and the
sign-up allowlist is a local KV namespace — so you can mint real sessions:

1. Origin checks: better-auth trusts `BETTER_AUTH_URL` (wrangler var =
   `https://intar.dev`). Override for dev via gitignored `website/.dev.vars`:
   `BETTER_AUTH_URL=http://localhost:4321`, then restart the dev server.
2. Allowlist the GitHub-username you'll sign up with:
   `bunx wrangler kv key put <name> '{}' --binding=ALLOWLIST --local --config wrangler.jsonc`
3. Sign up (cookie jar holds the session):
   ```bash
   curl -s -c user.jar -X POST http://localhost:4321/api/auth/sign-up/email \
     -H 'content-type: application/json' -H 'Origin: http://localhost:4321' \
     -d '{"email":"u@example.com","password":"…12+ chars…","name":"U","username":"<name>"}'
   ```
4. Every subsequent POST/PATCH/DELETE needs `-H 'Origin: http://localhost:4321'`
   (Astro CSRF blocks bodyless cross-site POSTs; browsers send Origin automatically).
5. Site admin: `bunx wrangler d1 execute DB --local --config wrangler.jsonc \
   --command "UPDATE user SET role='admin' WHERE username='<name>'"`.

## Cleanup

Delete test users (`DELETE FROM user WHERE username IN (...)` — memberships
cascade), delete the KV allowlist keys, stop the dev daemon.
