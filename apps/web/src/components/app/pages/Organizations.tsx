import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Building2, LockKeyhole, Plus } from "lucide-react";
import { formatRelativeTime } from "../lib/format";
import { AsyncLabel } from "../patterns/AsyncLabel";
import { Field } from "../patterns/Field";
import { MetaLine } from "../patterns/MetaLine";
import { PageShell } from "../patterns/PageShell";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "../patterns/CollectionPagination";
import { CardGridSkeleton } from "../patterns/Skeletons";
import { EmptyState, ErrorState } from "../patterns/StateCard";
import { usePageChrome } from "../shell/page-chrome";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ORGANIZATION_NAME_MAX, reject } from "./organization-detail/reject";

interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member";
  memberCount: number;
  createdAt: number;
}

interface OrganizationsResponse {
  organizations: OrganizationSummary[];
  creation: {
    enabled: boolean;
    reason: "not_selected" | "owner_limit_reached" | null;
  };
}

export function Organizations() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  // A refused submit (too short) says why at the field and nudges it.
  const [nameProblem, setNameProblem] = useState<string | null>(null);

  const organizations = useQuery({
    queryKey: ["organizations", "list"],
    queryFn: async () => {
      const response = await fetch("/api/organizations", {
        credentials: "include",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "Could not load your organizations.");
      }
      return (await response.json()) as OrganizationsResponse;
    },
    staleTime: 5_000,
  });

  const createOrganization = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/organizations", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = (await response.json().catch(() => null)) as {
        organization?: OrganizationSummary;
        error?: string;
      } | null;
      if (!response.ok || !body?.organization) {
        throw new Error(body?.error ?? "Could not create the organization.");
      }
      return body.organization;
    },
    onSuccess: async (organization) => {
      setCreateOpen(false);
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      void navigate({
        to: "/organizations/$orgId",
        params: { orgId: organization.id },
      });
    },
  });

  const creation = organizations.data?.creation;
  const openCreate = useCallback(() => {
    if (!creation?.enabled) return;
    setName("");
    setNameProblem(null);
    createOrganization.reset();
    setCreateOpen(true);
  }, [createOrganization, creation?.enabled]);

  usePageChrome({
    action: useMemo(
      () => (
        <Button
          size="sm"
          onClick={openCreate}
          disabled={!creation?.enabled}
          title={
            creation?.reason === "owner_limit_reached"
              ? "Each selected account can own one organization"
              : creation?.reason === "not_selected"
                ? "Organization creation is enabled for selected accounts"
                : undefined
          }
        >
          <Plus className="size-3.5" />
          New organization
        </Button>
      ),
      [creation?.enabled, creation?.reason, openCreate],
    ),
  });

  const entries = organizations.data?.organizations ?? [];
  const roleLabel = (role: OrganizationSummary["role"]) =>
    role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member";

  return (
    <PageShell>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create an organization</DialogTitle>
            <DialogDescription>
              Set up private identity, scenario, and runner boundaries. You can
              own one organization.
            </DialogDescription>
          </DialogHeader>
          <form
            id="create-organization-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (createOrganization.isPending) return;
              if (name.trim().length < 2) {
                setNameProblem("Enter a name of 2 to 60 characters.");
                reject(
                  event.currentTarget.querySelector<HTMLInputElement>("input"),
                );
                return;
              }
              createOrganization.mutate();
            }}
          >
            <Field
              label="Organization name"
              error={
                nameProblem ??
                (createOrganization.error ? createOrganization.error.message : null)
              }
            >
              {(control) => (
                <Input
                  {...control}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameProblem(null);
                  }}
                  placeholder="Platform team"
                  maxLength={ORGANIZATION_NAME_MAX}
                  autoComplete="off"
                  autoFocus
                />
              )}
            </Field>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="create-organization-form"
              aria-busy={createOrganization.isPending || undefined}
              disabled={createOrganization.isPending}
              focusableWhenDisabled
            >
              <AsyncLabel
                state={createOrganization.isPending ? "pending" : "idle"}
                idle="Create"
                pending="Creating…"
              />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {creation && !creation.enabled ? (
        <Alert icon={<LockKeyhole />}>
          <AlertTitle>
            {creation.reason === "owner_limit_reached"
              ? "Organization ownership limit reached"
              : "Organization creation is in selected rollout"}
          </AlertTitle>
          <AlertDescription>
            {creation.reason === "owner_limit_reached"
              ? "You can still join and administer other organizations, but each selected account can own one."
              : "The feature is visible to everyone. Selected accounts can create an organization; anyone invited through a verified organization identity provider can join."}
          </AlertDescription>
        </Alert>
      ) : null}

      {organizations.error ? (
        <ErrorState
          title="Could not load organizations"
          description={
            organizations.error instanceof Error
              ? organizations.error.message
              : "Failed to load organizations"
          }
          onRetry={() => void organizations.refetch()}
        />
      ) : organizations.isPending ? (
        <CardGridSkeleton
          cards={3}
          cardClassName="h-24"
          className="sm:grid-cols-1"
        />
      ) : entries.length ? (
        <section className="space-y-4" aria-labelledby="organizations-heading">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2
                id="organizations-heading"
                className="text-section-title"
              >
                Organizations
              </h2>
            </div>
            <span className="text-metadata tabular-nums">
              {entries.length} total
            </span>
          </div>
          <PaginatedCollection
            items={entries}
            pageSize={COLLECTION_PAGE_SIZE.list}
            itemLabel="organizations"
          >
            {(visibleOrganizations) => (
              <div className="space-y-3">
                {visibleOrganizations.map((organization) => (
                  <Card
                    key={organization.id}
                    variant="interactive"
                    className="group gap-3 px-(--card-spacing)"
                    render={
                      <Link
                        to="/organizations/$orgId"
                        params={{ orgId: organization.id }}
                      />
                    }
                  >
                    <div className="flex items-center gap-3.5">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-[0.625rem] bg-brand-subtle text-brand-text ring-1 ring-brand-border/60">
                        <Building2 className="size-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-card-title">{organization.name}</h3>
                        <MetaLine
                          dense
                          className="mt-1"
                          items={[
                            `${organization.memberCount} member${organization.memberCount === 1 ? "" : "s"}`,
                            roleLabel(organization.role),
                            `Created ${formatRelativeTime(organization.createdAt)}`,
                          ]}
                        />
                      </div>
                      <ArrowRight className="size-4 shrink-0 text-faint-foreground transition-[translate,color] duration-(--duration-moderate) ease-enter group-hover:translate-x-(--move-nudge) group-hover:text-foreground group-focus-visible:translate-x-(--move-nudge) group-focus-visible:text-foreground" />
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </PaginatedCollection>
        </section>
      ) : (
        <EmptyState
          icon={<Building2 />}
          title="No organization access yet"
          description="When you sign in through an organization's verified identity provider, Intar creates your membership and this workspace appears here."
          action={
            creation?.enabled ? (
              <Button onClick={openCreate}>
                <Plus className="size-4" />
                Create organization
              </Button>
            ) : undefined
          }
        />
      )}
    </PageShell>
  );
}
