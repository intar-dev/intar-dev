# Accounts, sign-in and organizations

How accounts behave, for whoever changes or supports them.

## Sign-ups

Anyone can create an account with GitHub, or through an organization's
identity provider, while sign-up spots are open. Administrators set the limit
under **Admin → People → Sign-ups**. Every active account with at least one
sign-in identity takes a spot, administrators included; connecting a second
sign-in method never takes another. Revoking or deleting someone frees their
spot, and restoring their access takes one again, even past the limit. Until a
limit is saved, the limit is 0 and sign-ups are closed. Lowering
the limit never removes anyone; it only stops new sign-ups. Members can always
sign in, and the landing page shows how many spots are left.

The spot is claimed atomically when a new member's first identity is linked,
so concurrent sign-ups for the last spot admit exactly one person.

An email address never links accounts someone can sign in to. When a sign-in's
email belongs to an account that isn't connected to that identity, the sign-in
is refused: sign in to the existing account, then connect the other method (an
organization from its sign-in page, GitHub from **Profile**). The exception is
an account nobody can sign in to anymore, for example because its only
organization identity was removed with the provider: a GitHub sign-in with the
same verified email takes it over, and so does an organization sign-in that
could have created it, when that organization signed the account up or the
address is verified and on its provider's verified domain. Organization
sign-ups record the email as verified only on that domain. An approved
provider's other addresses stay unverified, so GitHub never takes those
accounts over, and only their own organization can. Platform admins always
keep GitHub, so their accounts are never taken over this way.

**Profile** lists the account's sign-in methods by organization. Disconnecting
GitHub or an organization there signs out every other session and connected
app. The last way to sign in can't be disconnected, and neither can an
organization identity whose admins removed the person, until they restore
them. Connecting or disconnecting GitHub or an organization needs a sign-in
from the last day, and a connection finishes only while the session that
started it is still signed in and can act. Usernames come only from GitHub, so disconnecting GitHub
clears the username. Sessions an admin opens by impersonating someone can't
connect or disconnect sign-in methods, or authorize apps or widen their
access. They stop working as soon as that admin is no longer one who can sign
in, and end when the admin is demoted, revoked, or signed out.

A session lasts only while its account can still sign in: every API request
checks that some identity still can, and a sign-in's new session needs the
identity it came through. Platform admins sign in with GitHub only: an
organization's owners and admins control its provider and decide who
administers it, so no organization provider signs in a platform admin.
Promoting someone to platform admin therefore needs GitHub, and signs them out,
since an organization's provider may have opened those sessions. Guards that
keep the last platform admin, on demotion, revocation, and deletion, count
only admins who can still sign in.

Revoking access signs the person out: they keep their data but can no longer
sign in, and their sessions, connected apps, runs, routes, pending server
registrations, and personal servers are shut down. Once that cleanup finished,
an administrator can restore their access from the person's page under
**Admin → People**, as a fresh start on the same account. They keep their
sign-in methods, history, and an organization they alone own; their SSH keys,
the apps they registered, their other organization memberships, and the admin
role are removed, their personal servers are retired, and new runs use the
cloud. Nothing the revocation ended comes back: every check that brackets an
operation compares the account's access generation, which each revocation
advances, so an operation that started before a revocation fails even when it
finishes after a restore. Restoring also signs out anything that raced in.

Deleting a user revokes access first, then anonymizes the account. A deleted
person can sign up again while spots are open. Revocation, restore, and
deletion events keep the person's GitHub account id and first organization
identity (provider and subject), so the audit trail outlives the account rows.

## Organizations

Organizations are visible to every signed-in member, but organization creation is
controlled by the generic Cloudflare Flagship binding named `FLAGS`. The
`organization-creation` boolean flag defaults to `off`; targeting rules should
serve `on` only when the `targetingKey` context field matches a selected Better
Auth user ID. The toggle controls creation only—it is not an authentication or
authorization boundary.

The `builder_operations` boolean flag, evaluated the same way for the platform
administrator who reads, also defaults to `off`. While it is off, the admin
navigation has no "Builds" entry and host enrollment offers no "Builder" role:
scenario repositories build their own images, and the builder is the fallback.
Serve `on` to show both again. Nothing else depends on it: the builds page and
its API stay reachable at `/admin/builds`, the enrollment API still accepts a
builder from a platform administrator, enrolled builders keep working, and a
scenario source card links to its builds whenever a builder builds for it.

### Organization OIDC

An organization admin can configure one OIDC provider and a domain the
organization controls. After the admin publishes the requested DNS TXT record,
people sign in at `/organization-sign-in` or `/organizations/<slug>/sign-in`
(the member sign-in URL in organization settings):

- A new identity gets an Intar account and joins the organization as a member.
  Its email must be on the verified domain (subdomains count). Emails on other
  domains need a platform admin's approval for that provider (**Admin →
  People → Organizations → Manage**, or the **New accounts** control in
  organization settings), and the provider must mark them `email_verified`.
  Sign-ups take a spot like GitHub sign-ups.
- An identity is its provider subject. Later sign-ins bind to it, whatever
  email the provider sends, and require an active account.
- Someone already signed in who continues on the organization sign-in page
  connects the identity to that account, whatever its email. The
  organization's provider can then sign in as them, except as a platform
  admin, who signs in with GitHub only; no organization sign-in takes over a
  platform admin's account. The owner's **Test sign-in** in settings runs this
  flow and returns with the result.
- Signing in through the provider makes the person a member. An admin who
  removes a member also blocks them from the provider until an admin restores
  them under **People**, or a platform admin under **Admin → People →
  Organizations**. If they have an identity at the provider, they are signed
  out everywhere in the same transaction: a session doesn't record which
  identity opened it. Platform admins, who sign in with GitHub only, stay
  signed in. The block also covers the logins (issuer and subject) they had at
  the organization's providers, so those can't sign in to, sign up or connect
  any account, even after the person is deleted or the provider is registered
  again. Admins leave instead of removing themselves. Leaving an organization
  blocks nothing.

Every flow starts from Intar's own routes, which sign an intent that the
callback enforces; Better Auth's `/api/auth/sign-in/sso` refuses requests
without one. SAML routes are disabled; organization SSO is OIDC-only.

Register Intar at the identity provider as a public client without a client
secret. Use the callback URI shown in organization settings; it is built from
`BETTER_AUTH_URL`. Discovery must advertise response type `code`, PKCE method
`S256`, and token authentication method `none`. Intar requests
`openid email profile`, always uses authorization code flow with PKCE S256,
and validates the signed ID token against the provider's JWKS, the issuer
exactly as discovery advertises it, and the client ID. The ID token must
include the `email` claim; without it, sign-in and connecting stop with a
message asking the provider's admin to add it. Implicit flow, hybrid flow,
plain PKCE, and clients with secrets are not supported.

For a Better Auth identity provider that uses the legacy `oidcProvider` plugin
(such as `https://id.rawkode.academy`), register Intar as a trusted public
client:

```ts
{
  clientId: "intar",
  name: "Intar",
  type: "public",
  // Better Auth's legacy provider expects a value even for public clients.
  clientSecret: "pkce-public-client-placeholder",
  redirectUrls: ["<callback URI from organization settings>"],
  disabled: false,
  skipConsent: true,
  metadata: null,
}
```

The SSO dependency patch in `patches/` enables token authentication `none` and
lets Intar bind an explicit link to the signed-in account; see
`patches/README.md`.

Removing the provider is refused while active members have no other usable
way to sign in. Otherwise removal signs out everyone with an identity at it,
except the admin removing it in their current session, and deletes the linked
identities in one transaction that rechecks the members; members keep their
memberships and other sign-in methods, and people left without a way in can
reclaim their account as described under Sign-ups. Server-side sign-outs delete sessions
and OAuth tokens in the transaction that takes access away, so a refused
change signs nobody out; they include the sessions the person opened by
impersonating someone. Back-channel logout isn't sent: Better Auth's OAuth
provider delivers it with a fetch option Workers doesn't support. Terminal
routes opened before a sign-out keep working until they expire
(`STARGATE_ROUTE_TTL_SECONDS`, four hours by default); only revoking access
closes them early. Existing
providers that use secrets cannot sign in: remove their configuration and
register a public client.

Private scenarios use the `<organization-slug>-<local-scenario-id>` namespace.
Their images are built by a platform builder, or by the repository's own
pipeline once a platform administrator sets the scenario source to it, and
they can run only on agent runners owned by
the same organization. Organization runner bootstrap credentials remain valid
until rotation, revocation, host disablement, or deletion; the access JWTs they
mint remain short-lived.
