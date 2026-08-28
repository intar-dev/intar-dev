import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftRight,
  CheckCircle2,
  Copy,
  KeyRound,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { InlineFeedback } from "../../patterns/InlineFeedback";
import { Section } from "../../patterns/Section";
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
  verification: {
    host: string;
    value: string;
    expiresAt: number;
  } | null;
}

export function OrganizationSettingsSection({ detail }: { detail: Detail }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const admin = detail.role !== "member";
  const owner = detail.role === "owner";
  const [name, setName] = useState(detail.name);
  const [issuer, setIssuer] = useState("");
  const [domain, setDomain] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const oidcEndpoint = `/api/organizations/${encodeURIComponent(detail.id)}/sso`;
  const oidc = useQuery({
    queryKey: ["organizations", detail.id, "oidc"],
    queryFn: () =>
      fetchJson<{ provider: OrganizationOidcProvider | null }>(oidcEndpoint),
    enabled: admin,
  });
  const invalidateDetail = () =>
    queryClient.invalidateQueries({
      queryKey: ["organizations", detail.id, "detail"],
    });
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
        body: JSON.stringify({ issuer, domain, clientId, clientSecret }),
      });
      const body = (await response.json().catch(() => null)) as {
        provider?: OrganizationOidcProvider;
        error?: string;
      } | null;
      if (!response.ok || !body?.provider) {
        throw new Error(
          body?.error ?? `OIDC registration failed (${response.status})`,
        );
      }
      return body.provider;
    },
    onSuccess: async () => {
      setClientSecret("");
      await invalidateOidc();
    },
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
  const removeProvider = useMutation({
    mutationFn: async () => {
      const response = await fetch(oidcEndpoint, {
        method: "DELETE",
        credentials: "include",
      });
      await mutationResponse(response, "Failed to remove OIDC provider");
    },
    onSuccess: invalidateOidc,
  });
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
      setTransferTarget("");
      await invalidateDetail();
    },
  });
  const leave = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(detail.id)}/leave`,
        { method: "POST", credentials: "include" },
      );
      await mutationResponse(response, "Failed to leave organization");
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      void navigate({ to: "/organizations" });
    },
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      void navigate({ to: "/organizations" });
    },
  });

  const provider = oidc.data?.provider ?? null;
  const signInUrl = `${
    typeof window === "undefined" ? "https://intar.dev" : window.location.origin
  }/organizations/${encodeURIComponent(detail.slug)}/sign-in`;
  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyFeedback(`${label} copied.`);
    } catch {
      setCopyFeedback(`${label} could not be copied.`);
    }
  };

  return (
    <div className="space-y-5">
      {admin ? (
        <Section
          density="compact"
          title="Organization profile"
          description="The slug remains stable so identity-provider links do not change when you rename the organization."
        >
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim().length >= 2 && !rename.isPending) rename.mutate();
            }}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="max-w-sm"
              aria-label="Organization name"
            />
            <Button
              type="submit"
              variant="outline"
              disabled={
                name.trim().length < 2 ||
                name.trim() === detail.name ||
                rename.isPending
              }
            >
              {rename.isPending ? "Saving…" : "Rename"}
            </Button>
          </form>
          {rename.error ? (
            <InlineFeedback tone="error" className="mt-3">
              {rename.error.message}
            </InlineFeedback>
          ) : null}
        </Section>
      ) : null}

      {admin ? (
        <Section
          density="compact"
          title="Organization OIDC"
          description="One verified provider owns sign-in for this organization. New IdP users are provisioned as members after a successful callback."
        >
          {oidc.isPending ? (
            <p className="text-sm text-muted-foreground">
              Loading identity provider…
            </p>
          ) : oidc.error ? (
            <InlineFeedback tone="error">
              {oidc.error instanceof Error
                ? oidc.error.message
                : "Failed to load the identity provider"}
            </InlineFeedback>
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
                    <dt className="text-label">Email domain</dt>
                    <dd className="mt-1 font-medium">{provider.domain}</dd>
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
                </dl>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={removeProvider.isPending}
                  onClick={() => removeProvider.mutate()}
                >
                  <Trash2 className="size-3.5" />
                  Remove provider
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <CopyValue
                  label="OIDC callback URL"
                  value={provider.callbackUrl}
                  onCopy={() => void copy(provider.callbackUrl, "Callback URL")}
                />
                <CopyValue
                  label="Member sign-in URL"
                  value={signInUrl}
                  onCopy={() => void copy(signInUrl, "Sign-in URL")}
                />
              </div>

              {provider.verification ? (
                <Alert>
                  <ShieldCheck className="size-4" />
                  <AlertTitle>Publish this DNS TXT record</AlertTitle>
                  <AlertDescription className="mt-3 space-y-3">
                    <CopyValue
                      label="Host"
                      value={provider.verification.host}
                      onCopy={() =>
                        void copy(provider.verification?.host ?? "", "DNS host")
                      }
                    />
                    <CopyValue
                      label="Value"
                      value={provider.verification.value}
                      onCopy={() =>
                        void copy(
                          provider.verification?.value ?? "",
                          "DNS value",
                        )
                      }
                    />
                    <p className="text-xs">
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
                        onClick={() => verify.mutate()}
                      >
                        <CheckCircle2 className="size-3.5" />
                        {verify.isPending ? "Checking…" : "Verify DNS"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={refresh.isPending}
                        onClick={() => refresh.mutate()}
                      >
                        <RefreshCw className="size-3.5" />
                        New token
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <KeyRound className="size-4" />
                  <AlertTitle>OIDC sign-in is active</AlertTitle>
                  <AlertDescription>
                    Share the member sign-in URL. Intar requests{" "}
                    <code>openid email profile offline_access</code> with PKCE.
                  </AlertDescription>
                </Alert>
              )}
              {copyFeedback ? (
                <InlineFeedback
                  tone={copyFeedback.endsWith("copied.") ? "success" : "error"}
                >
                  {copyFeedback}
                </InlineFeedback>
              ) : null}
              {(verify.error ?? refresh.error ?? removeProvider.error) ? (
                <InlineFeedback tone="error">
                  {(verify.error ??
                    refresh.error ??
                    removeProvider.error) instanceof Error
                    ? (verify.error ?? refresh.error ?? removeProvider.error)
                        ?.message
                    : "Identity provider action failed"}
                </InlineFeedback>
              ) : null}
            </div>
          ) : (
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!register.isPending) register.mutate();
              }}
            >
              <Field label="Issuer URL">
                <Input
                  value={issuer}
                  onChange={(event) => setIssuer(event.target.value)}
                  placeholder="https://id.rawkode.academy"
                  type="url"
                  required
                />
              </Field>
              <Field label="Verified email domain">
                <Input
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                  placeholder="rawkode.academy"
                  required
                />
              </Field>
              <Field label="Client ID">
                <Input
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  required
                />
              </Field>
              <Field label="Client secret">
                <Input
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  required
                />
              </Field>
              <div className="sm:col-span-2">
                <Button
                  type="submit"
                  disabled={
                    !issuer ||
                    !domain ||
                    !clientId ||
                    !clientSecret ||
                    register.isPending
                  }
                >
                  <ShieldCheck className="size-4" />
                  {register.isPending
                    ? "Discovering provider…"
                    : "Register OIDC provider"}
                </Button>
              </div>
              {register.error ? (
                <InlineFeedback tone="error" className="sm:col-span-2">
                  {register.error.message}
                </InlineFeedback>
              ) : null}
            </form>
          )}
        </Section>
      ) : null}

      <Section
        density="compact"
        title="Organization lifecycle"
        description="Organization deletion is blocked while it owns identity, scenarios, runners, builds, or run history."
      >
        <div className="space-y-3">
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
                disabled={!transferTarget || transfer.isPending}
                onClick={() => transfer.mutate()}
              >
                <ArrowLeftRight className="size-4" />
                Transfer ownership
              </Button>
              <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="size-4" />
                Delete organization
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              disabled={leave.isPending}
              onClick={() => leave.mutate()}
            >
              <LogOut className="size-4" />
              {leave.isPending ? "Leaving…" : "Leave organization"}
            </Button>
          )}
          {(transfer.error ?? leave.error) ? (
            <InlineFeedback tone="error">
              {(transfer.error ?? leave.error)?.message}
            </InlineFeedback>
          ) : null}
        </div>
      </Section>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {detail.name}?</DialogTitle>
            <DialogDescription>
              First remove every owned provider, scenario source, runner, build,
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
              {deleteOrganization.error.message}
            </InlineFeedback>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
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

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-1.5 text-sm font-medium">
      <span>{label}</span>
      {children}
    </label>
  );
}

function CopyValue({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <p className="text-label">{label}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all text-xs">{value}</code>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={onCopy}
          aria-label={`Copy ${label}`}
        >
          <Copy className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
