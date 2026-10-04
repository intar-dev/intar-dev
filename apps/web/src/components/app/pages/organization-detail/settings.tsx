import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowLeftRight,
  CheckCircle2,
  KeyRound,
  LogOut,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { apiErrorMessage, describeApiError } from "../../lib/api-errors";
import { AsyncLabel } from "../../patterns/AsyncLabel";
import { ConfirmDialog } from "../../patterns/ConfirmDialog";
import { CopyButton } from "../../patterns/CopyButton";
import { Field } from "../../patterns/Field";
import { InlineFeedback } from "../../patterns/InlineFeedback";
import { Section } from "../../patterns/Section";
import { ErrorState } from "../../patterns/StateCard";
import { BinIcon } from "@/components/ui/bin-icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { HttpResponseError } from "../../lib/http-response-error";
import { startOrganizationSignIn } from "@/lib/auth-client";
import { isAdminUser } from "@/lib/authz";
import { useSession } from "../../hooks/useSession";
import { invalidateOrganizationDetail } from "./queries";
import { ORGANIZATION_NAME_MAX, reject } from "./reject";
import { ScenarioSourceSection } from "./scenario-source";
import {
  signupPolicyText,
  useSignupPolicy,
} from "../../hooks/useSignupPolicy";
import {
  organizationSignInErrorMessage,
  organizationSignInStartErrorMessage,
} from "../sign-in-helpers";
import {
  type OrganizationDetailResponse,
  fetchJson,
  mutationResponse,
} from "./types";

type Detail = OrganizationDetailResponse["organization"];

interface OrganizationOidcProvider {
  providerId: string;
  issuer: string;
  domain: string;
  domainVerified: boolean;
  callbackUrl: string;
  clientIdLastFour: string;
  pkce: true;
  scopes: string[];
  allowExternalEmailSignups: boolean;
  verification: {
    host: string;
    value: string;
    expiresAt: number;
  } | null;
}

export function OrganizationSettingsSection({ detail }: { detail: Detail }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { oidcTest, oidcError } = useSearch({
    from: "/app/organizations/$orgId",
  });
  const { data: session } = useSession();
  const platformAdmin = isAdminUser(session?.user);
  const admin = detail.role !== "member";
  const owner = detail.role === "owner";
  const [name, setName] = useState(detail.name);
  const [issuer, setIssuer] = useState("");
  const [domain, setDomain] = useState("");
  const [clientId, setClientId] = useState("");
  const [copyError, setCopyError] = useState<string | null>(null);
  // A refused submit says why at the field and nudges it.
  const [issuerProblem, setIssuerProblem] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [removeProviderOpen, setRemoveProviderOpen] = useState(false);

  const oidcEndpoint = `/api/organizations/${encodeURIComponent(detail.id)}/sso`;
  const oidc = useQuery({
    queryKey: ["organizations", detail.id, "oidc"],
    queryFn: () =>
      fetchJson<{ provider: OrganizationOidcProvider | null }>(oidcEndpoint),
    enabled: admin,
  });
  const invalidateDetail = () =>
    invalidateOrganizationDetail(queryClient, detail);
  const invalidateOidc = () =>
    queryClient.invalidateQueries({
      queryKey: ["organizations", detail.id, "oidc"],
    });

  const rename = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(detail.id)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        },
      );
      await mutationResponse(response, "Failed to rename organization");
    },
    onSuccess: invalidateDetail,
  });
  const register = useMutation({
    mutationFn: async () => {
      const response = await fetch(oidcEndpoint, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ issuer, domain, clientId }),
      });
      const body = (await response.json().catch(() => null)) as {
        provider?: OrganizationOidcProvider;
        error?: string;
      } | null;
      if (!response.ok || !body?.provider) {
        throw HttpResponseError.fromBody(
          response.status,
          body,
          "The provider couldn't be registered. Try again.",
        );
      }
      return body.provider;
    },
    onSuccess: async () => {
      await invalidateOidc();
    },
  });
  const testSignIn = useMutation({
    mutationFn: () =>
      startOrganizationSignIn(detail.slug, { connect: true, test: true }),
    onMutate: () =>
      navigate({ to: ".", replace: true, search: { tab: "settings" } }),
  });
  const verify = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${oidcEndpoint}/verify`, {
        method: "POST",
        credentials: "include",
      });
      await mutationResponse(response, "Domain verification failed");
    },
    onSuccess: invalidateOidc,
  });
  const refresh = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${oidcEndpoint}/verification`, {
        method: "POST",
        credentials: "include",
      });
      await mutationResponse(response, "Failed to refresh DNS token");
    },
    onSuccess: invalidateOidc,
  });
  const setSignupPolicy = useSignupPolicy(detail.id);
  const removeProvider = useMutation({
    mutationFn: async () => {
      const response = await fetch(oidcEndpoint, {
        method: "DELETE",
        credentials: "include",
      });
      await mutationResponse(response, "Failed to remove OIDC provider");
    },
    onSuccess: async () => {
      setRemoveProviderOpen(false);
      await Promise.all([
        invalidateOidc(),
        // Removing the provider also removes your own identity at it.
        queryClient.invalidateQueries({ queryKey: ["profile", "identities"] }),
      ]);
    },
  });
  const closeRemoveProviderDialog = () => {
    setRemoveProviderOpen(false);
    removeProvider.reset();
  };
  const providerError = apiErrorMessage(
    verify.error ?? refresh.error ?? setSignupPolicy.error,
    "Couldn't update the provider. Try again.",
  );
  const renameFailure = describeApiError<"name">(rename.error, {
    fallback: "Couldn't rename the organization. Try again.",
    defaultField: "name",
  });
  const registerFailure = describeApiError<"issuer" | "domain" | "clientId">(
    register.error,
    {
      fallback: "The provider couldn't be registered. Try again.",
      fields: { issuer: /issuer|discovery|url/i, domain: /domain/i, clientId: /client/i },
    },
  );
  // Only the latest provider action's failure shows; one still running keeps
  // its own.
  const startProviderAction = () => {
    for (const action of [verify, refresh, setSignupPolicy]) {
      if (!action.isPending) action.reset();
    }
  };
  const transfer = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(detail.id)}/transfer-ownership`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ memberId: transferTarget }),
        },
      );
      await mutationResponse(response, "Failed to transfer ownership");
    },
    onSuccess: async () => {
      setTransferOpen(false);
      setTransferTarget("");
      await invalidateDetail();
    },
  });
  const transferMember = detail.members.find(
    (entry) => entry.memberId === transferTarget,
  );
  // Leaving or deleting ends access to this organization, so refetching this
  // still-mounted page's queries could only fail, and retrying them held the
  // navigation for seconds. Mark them stale without refetching; the list page
  // reloads what it shows.
  const exitOrganization = async () => {
    await queryClient.invalidateQueries({
      queryKey: ["organizations"],
      refetchType: "none",
    });
    await navigate({ to: "/organizations" });
  };
  const leave = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(detail.id)}/leave`,
        { method: "POST", credentials: "include" },
      );
      await mutationResponse(response, "Failed to leave organization");
    },
    onSuccess: exitOrganization,
  });
  const deleteOrganization = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(detail.id)}`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );
      await mutationResponse(response, "Failed to delete organization");
    },
    onSuccess: exitOrganization,
  });

  const provider = oidc.data?.provider ?? null;
  const signInUrl = `${
    typeof window === "undefined" ? "https://intar.dev" : window.location.origin
  }/organizations/${encodeURIComponent(detail.slug)}/sign-in`;
  // A copy confirms on its own button; only a failure needs a line.
  const copyFailed = () =>
    setCopyError("Could not copy to the clipboard. Select the text and copy it.");

  return (
    <div className="space-y-4">
      {admin ? (
        <Section
          density="compact"
          title="Organization profile"
          description="The slug remains stable so identity-provider links do not change when you rename the organization."
        >
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim().length >= 2 && !rename.isPending) rename.mutate();
            }}
          >
            <Field
              label="Organization name"
              className="w-full max-w-sm"
              error={renameFailure?.field === "name" ? renameFailure.message : null}
            >
              {(control) => (
                <Input
                  {...control}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (rename.error) rename.reset();
                  }}
                  maxLength={ORGANIZATION_NAME_MAX}
                  autoComplete="off"
                />
              )}
            </Field>
            <Button
              type="submit"
              variant="outline"
              aria-busy={rename.isPending || undefined}
              disabled={
                name.trim().length < 2 ||
                name.trim() === detail.name ||
                rename.isPending
              }
              focusableWhenDisabled={rename.isPending}
            >
              <AsyncLabel
                state={rename.isPending ? "pending" : "idle"}
                idle="Rename"
                pending="Saving…"
              />
            </Button>
          </form>
          {renameFailure && renameFailure.field === null ? (
            <InlineFeedback tone="error" className="mt-2">
              {renameFailure.message}
            </InlineFeedback>
          ) : null}
        </Section>
      ) : null}

      {admin ? (
        <Section
          density="compact"
          title="Organization OIDC"
          description="One verified provider owns sign-in for this organization. Everyone who signs in through it joins as a member, and first-timers get an Intar account."
        >
          {oidc.isPending ? (
            <InlineFeedback tone="pending">
              Loading identity provider…
            </InlineFeedback>
          ) : oidc.error ? (
            <ErrorState
              headingLevel={3}
              title="Could not load the identity provider"
              description="The identity provider could not be loaded."
              onRetry={() => oidc.refetch()}
            />
          ) : provider ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border bg-muted/20 p-4">
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-label">Issuer</dt>
                    <dd className="mt-1 font-mono text-xs break-all">
                      {provider.issuer}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-label">Domain</dt>
                    <dd className="mt-1">
                      <code className="text-code">{provider.domain}</code>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-label">Client</dt>
                    <dd className="mt-1 font-mono text-xs">
                      {provider.clientIdLastFour}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-label">Status</dt>
                    <dd className="mt-1">
                      <Badge
                        variant={
                          provider.domainVerified ? "success" : "secondary"
                        }
                      >
                        {provider.domainVerified
                          ? "Verified"
                          : "DNS verification required"}
                      </Badge>
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-label">New accounts</dt>
                    <dd className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span>
                        {
                          signupPolicyText(
                            provider.domain,
                            provider.allowExternalEmailSignups,
                          ).status
                        }
                      </span>
                      {platformAdmin ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={setSignupPolicy.isPending}
                          onClick={() => {
                            startProviderAction();
                            setSignupPolicy.mutate(
                              !provider.allowExternalEmailSignups,
                            );
                          }}
                        >
                          {
                            signupPolicyText(
                              provider.domain,
                              provider.allowExternalEmailSignups,
                            ).action
                          }
                        </Button>
                      ) : provider.allowExternalEmailSignups ? null : (
                        <span className="text-caption">
                          An Intar admin can allow other email domains from
                          Admin › People › Organizations.
                        </span>
                      )}
                    </dd>
                  </div>
                </dl>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    removeProvider.reset();
                    setRemoveProviderOpen(true);
                  }}
                >
                  <BinIcon />
                  Remove provider
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <CopyValue
                  label="OIDC callback URL"
                  value={provider.callbackUrl}
                  onError={copyFailed}
                />
                <CopyValue
                  label="Member sign-in URL"
                  value={signInUrl}
                  onError={copyFailed}
                />
              </div>

              {provider.verification ? (
                <Alert icon={<ShieldCheck />} role={undefined}>
                  <AlertTitle>Publish this DNS TXT record</AlertTitle>
                  <AlertDescription className="mt-3 space-y-3">
                    <CopyValue
                      label="Host"
                      value={provider.verification.host}
                      onError={copyFailed}
                    />
                    <CopyValue
                      label="Value"
                      value={provider.verification.value}
                      onError={copyFailed}
                    />
                    <p className="text-metadata">
                      Token expires{" "}
                      {new Date(
                        provider.verification.expiresAt,
                      ).toLocaleString()}
                      .
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={verify.isPending}
                        onClick={() => {
                          startProviderAction();
                          verify.mutate();
                        }}
                      >
                        <CheckCircle2 className="size-3.5" />
                        {verify.isPending ? "Checking…" : "Verify DNS"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={refresh.isPending}
                        onClick={() => {
                          startProviderAction();
                          refresh.mutate();
                        }}
                      >
                        <RefreshCw className="size-3.5" />
                        New token
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert icon={<KeyRound />}>
                  <AlertTitle>OIDC sign-in is active</AlertTitle>
                  <AlertDescription>
                    Share the member sign-in URL. Intar requests{" "}
                    <code className="text-code">
                      {provider.scopes.join(" ")}
                    </code>{" "}
                    with PKCE S256.
                  </AlertDescription>
                </Alert>
              )}
              {owner ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!provider.domainVerified || testSignIn.isPending}
                      onClick={() => testSignIn.mutate()}
                    >
                      <ShieldCheck className="size-3.5" aria-hidden="true" />
                      {testSignIn.isPending ? "Opening provider…" : "Test sign-in"}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      PKCE S256 · No client secret
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {provider.domainVerified
                      ? "Sign in at your provider to test access. The test connects that identity to your account."
                      : "Verify DNS before testing sign-in."}
                  </p>
                  {testSignIn.isPending ? (
                    <InlineFeedback tone="pending">
                      Opening your identity provider…
                    </InlineFeedback>
                  ) : testSignIn.error ? (
                    <InlineFeedback tone="error">
                      {organizationSignInStartErrorMessage(testSignIn.error)}
                    </InlineFeedback>
                  ) : oidcTest ? (
                    <InlineFeedback
                      tone={oidcTest === "passed" ? "success" : "error"}
                    >
                      {oidcTest === "passed"
                        ? "PKCE S256 sign-in passed."
                        : organizationSignInErrorMessage(
                            oidcError ?? null,
                            "Sign-in test failed. Check the provider settings and try again.",
                          )}
                    </InlineFeedback>
                  ) : null}
                </div>
              ) : null}
              {copyError ? (
                <InlineFeedback tone="error">{copyError}</InlineFeedback>
              ) : null}
              {providerError ? (
                <InlineFeedback tone="error">{providerError}</InlineFeedback>
              ) : null}
            </div>
          ) : (
            <form
              className="grid gap-4 sm:grid-cols-2"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (register.isPending) return;
                if (issuer && !URL.canParse(issuer)) {
                  setIssuerProblem(
                    "Enter the issuer as a URL, like https://id.example.com.",
                  );
                  reject(
                    event.currentTarget.querySelector<HTMLInputElement>(
                      "input",
                    ),
                  );
                  return;
                }
                register.mutate();
              }}
            >
              <Field
                label="Issuer URL"
                error={
                  issuerProblem ??
                  (registerFailure?.field === "issuer"
                    ? registerFailure.message
                    : null)
                }
              >
                {(control) => (
                  <Input
                    {...control}
                    value={issuer}
                    onChange={(event) => {
                      setIssuer(event.target.value);
                      setIssuerProblem(null);
                      if (register.error) register.reset();
                    }}
                    className="text-code"
                    placeholder="https://id.example.com"
                    type="url"
                    required
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                )}
              </Field>
              <Field
                label="Organization domain"
                error={
                  registerFailure?.field === "domain"
                    ? registerFailure.message
                    : null
                }
              >
                {(control) => (
                  <Input
                    {...control}
                    value={domain}
                    onChange={(event) => {
                      setDomain(event.target.value);
                      if (register.error) register.reset();
                    }}
                    className="text-code"
                    placeholder="example.com"
                    required
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                )}
              </Field>
              <Field
                label="Client ID"
                error={
                  registerFailure?.field === "clientId"
                    ? registerFailure.message
                    : null
                }
              >
                {(control) => (
                  <Input
                    {...control}
                    value={clientId}
                    onChange={(event) => {
                      setClientId(event.target.value);
                      if (register.error) register.reset();
                    }}
                    className="text-code"
                    required
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                )}
              </Field>
              <p className="text-sm text-muted-foreground sm:col-span-2">
                Use a public client without a client secret. The provider must
                support authorization code flow with PKCE S256 and token
                authentication method none. You'll prove the domain with a DNS
                record. People with emails on it can create accounts through
                the provider; other emails need a platform admin's approval.
              </p>
              <div className="sm:col-span-2">
                <Button
                  type="submit"
                  disabled={
                    !issuer ||
                    !domain ||
                    !clientId ||
                    register.isPending
                  }
                >
                  <ShieldCheck className="size-4" />
                  {register.isPending
                    ? "Discovering provider…"
                    : "Register OIDC provider"}
                </Button>
              </div>
              {registerFailure && registerFailure.field === null ? (
                <InlineFeedback tone="error" className="sm:col-span-2">
                  {registerFailure.message}
                </InlineFeedback>
              ) : null}
            </form>
          )}
        </Section>
      ) : null}

      {admin ? (
        <ScenarioSourceSection
          endpoint={`/api/organizations/${encodeURIComponent(detail.id)}/scenario-source`}
          scope={detail.slug}
        />
      ) : null}

      <Section
        density="compact"
        title="Organization lifecycle"
        description="Organization deletion is blocked while it owns identity, scenarios, builds, or run history."
      >
        <div className="space-y-2">
          {owner ? (
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect
                value={transferTarget}
                onChange={(event) => setTransferTarget(event.target.value)}
                aria-label="New owner"
              >
                <option value="">Choose a new owner…</option>
                {detail.members
                  .filter((entry) => entry.role !== "owner")
                  .map((entry) => (
                    <option key={entry.memberId} value={entry.memberId}>
                      {entry.name}
                    </option>
                  ))}
              </NativeSelect>
              <Button
                variant="outline"
                aria-haspopup="dialog"
                disabled={!transferTarget}
                onClick={() => {
                  transfer.reset();
                  setTransferOpen(true);
                }}
              >
                <ArrowLeftRight className="size-4" />
                Transfer ownership
              </Button>
              <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                <BinIcon className="size-4" />
                Delete organization
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              aria-haspopup="dialog"
              onClick={() => {
                leave.reset();
                setLeaveOpen(true);
              }}
            >
              <LogOut className="size-4" />
              Leave organization
            </Button>
          )}
        </div>
      </Section>

      <ConfirmDialog
        open={transferOpen}
        onClose={() => {
          setTransferOpen(false);
          transfer.reset();
        }}
        title={`Transfer ownership to ${transferMember?.name ?? "this member"}?`}
        description="You become an admin. Only they can transfer ownership back."
        error={apiErrorMessage(
          transfer.error,
          "Couldn't transfer ownership. Try again.",
        )}
        pending={transfer.isPending}
        confirmLabel="Transfer ownership"
        pendingLabel="Transferring…"
        cancelLabel="Keep ownership"
        confirmVariant="default"
        onConfirm={() => transfer.mutate()}
      />

      <ConfirmDialog
        open={leaveOpen}
        onClose={() => {
          setLeaveOpen(false);
          leave.reset();
        }}
        title={`Leave ${detail.name}?`}
        description="You lose access until you are invited again or sign in through its identity provider."
        error={apiErrorMessage(
          leave.error,
          "Couldn't leave the organization. Try again.",
        )}
        pending={leave.isPending}
        confirmLabel="Leave organization"
        pendingLabel="Leaving…"
        cancelLabel="Stay"
        onConfirm={() => leave.mutate()}
      />

      <ConfirmDialog
        open={removeProviderOpen}
        onClose={closeRemoveProviderDialog}
        title="Remove the identity provider?"
        description="Everyone who connected it is signed out everywhere, except you here, and loses it as a way to sign in. Members keep their memberships and their other sign-in methods."
        error={apiErrorMessage(
          removeProvider.error,
          "Couldn't remove the provider. Try again.",
        )}
        pending={removeProvider.isPending}
        confirmLabel="Remove provider"
        pendingLabel="Removing…"
        onConfirm={() => removeProvider.mutate()}
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {detail.name}?</DialogTitle>
            <DialogDescription>
              First remove every owned provider, course catalog, runner, build,
              and run. Type the organization name to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={deleteConfirm}
            onChange={(event) => setDeleteConfirm(event.target.value)}
            aria-label="Organization name confirmation"
          />
          {deleteOrganization.error ? (
            <InlineFeedback tone="error">
              {apiErrorMessage(
                deleteOrganization.error,
                "Couldn't delete the organization. Try again.",
              )}
            </InlineFeedback>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={
                deleteConfirm !== detail.name || deleteOrganization.isPending
              }
              onClick={() => deleteOrganization.mutate()}
            >
              {deleteOrganization.isPending
                ? "Deleting…"
                : "Delete organization"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CopyValue({
  label,
  value,
  onError,
}: {
  label: string;
  value: string;
  onError: () => void;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-label">{label}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all text-code">{value}</code>
        <CopyButton
          text={value}
          name={`Copy ${label}`}
          variant="ghost"
          onError={onError}
        />
      </div>
    </div>
  );
}
