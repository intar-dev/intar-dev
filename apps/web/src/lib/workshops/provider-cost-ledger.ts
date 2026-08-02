import { env } from "cloudflare:workers";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  providerPriceLineItems,
  providerPriceObservations,
  runtimeExecutions,
  runtimeProviderAllocations,
  runtimeProviderCostLedger,
  runtimeProviderResources,
  workshopSessionCostForecasts,
  workshopWorkspaces,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { estimateLedgerLineItem, type ProviderCostLineItemInput } from "./costs";
import { finalizeWorkshopCostSummary } from "./cost-storage";

type BillableResourceKind = "instance" | "boot_disk" | "ipv4";

export interface ProviderCostLedgerReconciliation {
  inserted: number;
  closed: number;
  skipped: "unsupported_execution_domain" | "no_resources" | null;
}

/**
 * Persist the price snapshot for every billable resource that has become known.
 *
 * Allocation creation already pinned the immutable observation and, for a
 * learner, the accepted forecast. This function copies those exact identities;
 * it never rediscovers "latest" pricing. Re-running it is safe after ambiguous
 * provider calls.
 */
export async function reconcileProviderCostLedger(input: {
  allocationId: string;
  now?: number;
}): Promise<ProviderCostLedgerReconciliation> {
  const now = input.now ?? Date.now();
  const db = drizzle(env.DB);
  const contextRows = await db
    .select({
      allocation: runtimeProviderAllocations,
      execution: runtimeExecutions,
      sessionId: workshopWorkspaces.sessionId,
      observation: providerPriceObservations,
      forecast: workshopSessionCostForecasts,
    })
    .from(runtimeProviderAllocations)
    .innerJoin(
      runtimeExecutions,
      eq(runtimeExecutions.id, runtimeProviderAllocations.executionId),
    )
    .leftJoin(
      workshopWorkspaces,
      and(
        eq(runtimeExecutions.domainKind, "workshop"),
        eq(workshopWorkspaces.id, runtimeExecutions.domainId),
      ),
    )
    .innerJoin(
      providerPriceObservations,
      eq(
        providerPriceObservations.id,
        runtimeProviderAllocations.priceObservationId,
      ),
    )
    .leftJoin(
      workshopSessionCostForecasts,
      eq(
        workshopSessionCostForecasts.id,
        runtimeProviderAllocations.costForecastId,
      ),
    )
    .where(eq(runtimeProviderAllocations.id, input.allocationId))
    .limit(1);
  const context = contextRows[0];
  if (
    !context ||
    (context.execution.domainKind !== "workshop" &&
      context.execution.domainKind !== "workshop_certification")
  ) {
    return {
      inserted: 0,
      closed: 0,
      skipped: "unsupported_execution_domain",
    };
  }
  if (
    context.execution.domainKind === "workshop" &&
    (context.sessionId === null ||
      context.allocation.costForecastId === null ||
      context.forecast === null)
  ) {
    throw appError(
      500,
      "provider_cost_forecast_attribution_missing",
      "the learner allocation has no pinned cost forecast",
    );
  }
  if (
    context.execution.domainKind === "workshop_certification" &&
    (context.allocation.costForecastId !== null || context.forecast !== null)
  ) {
    throw appError(
      500,
      "provider_certification_forecast_forbidden",
      "certification allocations cannot reference a session cost forecast",
    );
  }

  await ensureGcpEphemeralIpv4Resource({
    allocation: context.allocation,
    now,
  });

  const resources = await db
    .select()
    .from(runtimeProviderResources)
    .where(
      and(
        eq(runtimeProviderResources.allocationId, input.allocationId),
        inArray(runtimeProviderResources.resourceKind, [
          "instance",
          "boot_disk",
          "ipv4",
        ]),
      ),
    );
  if (resources.length === 0) {
    return { inserted: 0, closed: 0, skipped: "no_resources" };
  }

  if (
    context.forecast !== null &&
    context.observation.currency !== context.forecast.currency
  ) {
    throw appError(
      500,
      "provider_cost_forecast_currency_mismatch",
      "the pinned cost forecast currency does not match its price observation",
    );
  }

  const prices = await db
    .select()
    .from(providerPriceLineItems)
    .where(
      eq(
        providerPriceLineItems.observationId,
        context.allocation.priceObservationId,
      ),
    );
  const insertRows: Array<typeof runtimeProviderCostLedger.$inferInsert> = [];
  for (const resource of resources) {
    const matchingPrices = prices.filter(
      (price) =>
        price.location === resource.location &&
        priceAppliesToResource(
          context.allocation.providerKind,
          resource.resourceKind as BillableResourceKind,
          price.resourceKind,
        ),
    );
    if (matchingPrices.length === 0) {
      throw appError(
        500,
        "provider_cost_price_line_missing",
        `the pinned price observation has no ${resource.resourceKind} line for ${resource.location}`,
      );
    }
    const providerCreatedAt = effectiveProviderCreatedAt({
      providerKind: context.allocation.providerKind,
      allocationCreatedAt: context.allocation.createdAt,
      resourceCreatedAt: resource.providerCreatedAt,
    });
    for (const price of matchingPrices) {
      insertRows.push({
        id: createAppId(),
        executionId: context.execution.id,
        allocationId: context.allocation.id,
        providerResourceId: resource.id,
        forecastId: context.allocation.costForecastId,
        priceLineItemId: price.id,
        providerKind: context.allocation.providerKind,
        resourceKind: resource.resourceKind,
        sku: price.sku,
        location: price.location,
        currency: context.observation.currency,
        rawPrice: price.rawPrice,
        priceNanos: price.priceNanos,
        unit: price.unit,
        quantityNanos: price.quantityNanos,
        billingIncrementSeconds: price.billingIncrementSeconds,
        minimumDurationSeconds: price.minimumDurationSeconds,
        capPriceNanos: price.capPriceNanos,
        taxTreatment: price.taxTreatment,
        providerCreatedAt,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  let inserted = 0;
  for (const row of insertRows) {
    const result = await db
      .insert(runtimeProviderCostLedger)
      .values(row)
      .onConflictDoNothing({
        target: [
          runtimeProviderCostLedger.providerResourceId,
          runtimeProviderCostLedger.sku,
          runtimeProviderCostLedger.taxTreatment,
        ],
      });
    inserted += result.meta.changes;
  }
  const closed = await closeDisappearedProviderCostLedgerLines({
    allocationId: input.allocationId,
    now,
  });
  return { inserted, closed, skipped: null };
}

/** Close open ledger rows at the provider-confirmed disappearance timestamp. */
export async function closeDisappearedProviderCostLedgerLines(input: {
  allocationId: string;
  now?: number;
}): Promise<number> {
  const now = input.now ?? Date.now();
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      ledger: runtimeProviderCostLedger,
      disappearedAt: runtimeProviderResources.disappearanceConfirmedAt,
    })
    .from(runtimeProviderCostLedger)
    .innerJoin(
      runtimeProviderResources,
      eq(
        runtimeProviderResources.id,
        runtimeProviderCostLedger.providerResourceId,
      ),
    )
    .where(
      and(
        eq(runtimeProviderCostLedger.allocationId, input.allocationId),
        isNull(runtimeProviderCostLedger.deletionConfirmedAt),
        isNotNull(runtimeProviderResources.disappearanceConfirmedAt),
      ),
    );
  let closed = 0;
  for (const row of rows) {
    if (row.disappearedAt === null) continue;
    const estimate = estimateLedgerLineItem({
      lineItem: ledgerPriceInput(row.ledger),
      createdAt: row.ledger.providerCreatedAt,
      deletionConfirmedAt: row.disappearedAt,
      now,
    });
    const result = await db
      .update(runtimeProviderCostLedger)
      .set({
        deletionConfirmedAt: row.disappearedAt,
        finalCostNanos: estimate.costNanos,
        updatedAt: now,
      })
      .where(
        and(
          eq(runtimeProviderCostLedger.id, row.ledger.id),
          isNull(runtimeProviderCostLedger.deletionConfirmedAt),
        ),
      );
    closed += result.meta.changes;
  }
  return closed;
}

/**
 * Finalize a session estimate only after every direct-cloud allocation and
 * individual resource has confirmed deletion.
 */
export async function finalizeWorkshopCostAfterAllocationDeletion(input: {
  allocationId: string;
  now?: number;
}): Promise<{ finalized: boolean }> {
  const now = input.now ?? Date.now();
  const db = drizzle(env.DB);
  const identity = await db
    .select({
      sessionId: workshopWorkspaces.sessionId,
      domainKind: runtimeExecutions.domainKind,
    })
    .from(runtimeProviderAllocations)
    .innerJoin(
      runtimeExecutions,
      eq(runtimeExecutions.id, runtimeProviderAllocations.executionId),
    )
    .leftJoin(
      workshopWorkspaces,
      eq(workshopWorkspaces.id, runtimeExecutions.domainId),
    )
    .where(eq(runtimeProviderAllocations.id, input.allocationId))
    .limit(1);
  const row = identity[0];
  if (row?.domainKind !== "workshop" || row.sessionId === null) {
    return { finalized: false };
  }
  const remaining = await db
    .select({ id: runtimeProviderAllocations.id })
    .from(runtimeProviderAllocations)
    .innerJoin(
      runtimeExecutions,
      eq(runtimeExecutions.id, runtimeProviderAllocations.executionId),
    )
    .innerJoin(
      workshopWorkspaces,
      eq(workshopWorkspaces.id, runtimeExecutions.domainId),
    )
    .leftJoin(
      runtimeProviderResources,
      eq(
        runtimeProviderResources.allocationId,
        runtimeProviderAllocations.id,
      ),
    )
    .where(
      and(
        eq(runtimeExecutions.domainKind, "workshop"),
        eq(workshopWorkspaces.sessionId, row.sessionId),
        or(
          ne(runtimeProviderAllocations.state, "deleted"),
          isNull(runtimeProviderAllocations.deletionConfirmedAt),
          isNull(runtimeProviderResources.disappearanceConfirmedAt),
        ),
      ),
    )
    .limit(1);
  if (remaining.length > 0) return { finalized: false };
  return finalizeWorkshopCostSummary({ sessionId: row.sessionId, now });
}

async function ensureGcpEphemeralIpv4Resource(input: {
  allocation: typeof runtimeProviderAllocations.$inferSelect;
  now: number;
}): Promise<void> {
  if (
    input.allocation.providerKind !== "gcp_compute" ||
    !input.allocation.externalIpv4
  ) {
    return;
  }
  const db = drizzle(env.DB);
  const instances = await db
    .select()
    .from(runtimeProviderResources)
    .where(
      and(
        eq(
          runtimeProviderResources.allocationId,
          input.allocation.id,
        ),
        eq(
          runtimeProviderResources.locationAttempt,
          input.allocation.locationAttempt,
        ),
        eq(runtimeProviderResources.resourceKind, "instance"),
      ),
    )
    .limit(1);
  const instance = instances[0];
  if (!instance) return;
  const providerResourceId = `${instance.providerResourceId}:ephemeral-ipv4`;
  await db
    .insert(runtimeProviderResources)
    .values({
      id: createAppId(),
      allocationId: input.allocation.id,
      providerKind: "gcp_compute",
      resourceKind: "ipv4",
      providerResourceId,
      locationAttempt: input.allocation.locationAttempt,
      location: input.allocation.location,
      providerState: instance.providerState,
      configurationJson: {
        deterministicName: `${input.allocation.deterministicName}-ipv4`,
        address: input.allocation.externalIpv4,
        lifecycle: "ephemeral_with_instance",
      },
      providerCreatedAt:
        instance.providerCreatedAt ?? input.allocation.createdAt,
      disappearanceConfirmedAt: instance.disappearanceConfirmedAt,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing({
      target: [
        runtimeProviderResources.allocationId,
        runtimeProviderResources.locationAttempt,
        runtimeProviderResources.resourceKind,
      ],
    });
  const stored = await db
    .select({ providerResourceId: runtimeProviderResources.providerResourceId })
    .from(runtimeProviderResources)
    .where(
      and(
        eq(runtimeProviderResources.allocationId, input.allocation.id),
        eq(
          runtimeProviderResources.locationAttempt,
          input.allocation.locationAttempt,
        ),
        eq(runtimeProviderResources.resourceKind, "ipv4"),
      ),
    )
    .limit(1);
  if (stored[0]?.providerResourceId !== providerResourceId) {
    throw appError(
      409,
      "provider_resource_identity_changed",
      "provider IPv4 identity changed within one allocation",
    );
  }
}

function priceAppliesToResource(
  providerKind: "hetzner_cloud" | "gcp_compute",
  resourceKind: BillableResourceKind,
  priceResourceKind: string,
): boolean {
  if (providerKind === "hetzner_cloud") {
    return resourceKind === priceResourceKind;
  }
  if (resourceKind === "instance") {
    return (
      priceResourceKind === "compute_core" ||
      priceResourceKind === "compute_ram"
    );
  }
  if (resourceKind === "boot_disk") {
    return priceResourceKind === "pd_balanced";
  }
  return priceResourceKind === "external_ipv4";
}

function effectiveProviderCreatedAt(input: {
  providerKind: "hetzner_cloud" | "gcp_compute";
  allocationCreatedAt: number;
  resourceCreatedAt: number | null;
}): number {
  if (input.providerKind === "gcp_compute") {
    // GCP creates the boot disk and ephemeral IPv4 in the same insert request as
    // the instance, but their subsequent observation does not expose a creation
    // timestamp. The persisted allocation time is the conservative common start.
    return input.resourceCreatedAt ?? input.allocationCreatedAt;
  }
  return input.resourceCreatedAt ?? input.allocationCreatedAt;
}

function ledgerPriceInput(
  row: typeof runtimeProviderCostLedger.$inferSelect,
): ProviderCostLineItemInput {
  return {
    sku: row.sku,
    resourceKind: row.resourceKind,
    location: row.location,
    currency: row.currency,
    rawPrice: row.rawPrice,
    priceNanos: row.priceNanos,
    unit: row.unit as ProviderCostLineItemInput["unit"],
    quantityNanos: row.quantityNanos,
    billingIncrementSeconds: row.billingIncrementSeconds,
    minimumDurationSeconds: row.minimumDurationSeconds,
    capPriceNanos: row.capPriceNanos,
    taxTreatment: row.taxTreatment as ProviderCostLineItemInput["taxTreatment"],
  };
}
