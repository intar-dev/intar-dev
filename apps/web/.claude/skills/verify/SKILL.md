---
name: verify
description: Build and exercise the website Worker locally with the reset-only D1 baseline and real GitHub authentication.
---

# Verifying website changes locally

## Launch

Use the pinned Node and Bun versions. Create a gitignored `.dev.vars` with the
local Better Auth URL, strong development secrets, and GitHub OAuth credentials,
then run:

```bash
export GITHUB_USERNAME="your-github-username"
fnm exec --using=$(cat .node-version) bun run build
fnm exec --using=$(cat .node-version) bun run db:bootstrap:local
fnm exec --using=$(cat .node-version) bunx wrangler d1 execute DB --local --config wrangler.jsonc \
  --command "INSERT INTO signup_settings (id, signup_limit, version, updated_by, updated_at) VALUES (1, 10, 1, NULL, cast(unixepoch('subsecond') * 1000 as integer)) ON CONFLICT(id) DO UPDATE SET signup_limit = excluded.signup_limit, version = signup_settings.version + 1, updated_at = excluded.updated_at;"
fnm exec --using=$(cat .node-version) bunx wrangler dev --config dist/server/wrangler.json --port 8788
```

Sign-ups stay closed until a limit exists. The insert opens 10 spots, so the
first GitHub sign-in creates your account.

The GitHub OAuth callback must be
`http://127.0.0.1:8788/api/auth/callback/github`. Credential sign-up/sign-in and
Better Auth's direct user-deletion routes are intentionally disabled.

## Authenticated checks

Sign in through GitHub at `http://127.0.0.1:8788`, then use the resulting
`better-auth.session_token` cookie for API calls. Every mutating request should
send `Origin: http://127.0.0.1:8788`.

To grant the local user admin access after the first sign-in:

```bash
fnm exec --using=$(cat .node-version) bunx wrangler d1 execute DB --local --config wrangler.jsonc \
  --command "UPDATE user SET role = 'admin' WHERE username = lower('${GITHUB_USERNAME}');"
```

As an administrator, change the sign-up limit under **Admin → People →
Sign-ups**, and revoke or delete test accounts from the Users tab.

Use a dedicated local Wrangler state directory when isolation matters. Never
reuse or directly delete production users: user rows own hosts and run history,
and cleanup must go through the application lifecycle.
