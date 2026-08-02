# ADR 0001: Clean-slate multi-cloud Workshop runtime

- Status: accepted
- Date: 2026-08-01

## Context

The first direct-cloud Workshop runtime coupled public API shapes, D1 tables,
and orchestration code to Hetzner Cloud. The repository also installed the web
application and provider Worker as separate JavaScript projects, which produced
duplicate dependency locks and encouraged cross-project relative imports.

The production control plane has one owner and its current D1 contents are not a
migration requirement. A clean cut therefore has lower operational and code
risk than retaining compatibility layers for data and contracts that are not
needed.

## Decision

Intar will cut over the Workshop control plane as a new application/database
unit:

- a newly provisioned, empty D1 database receives one baseline schema;
- the old Worker artifact and old D1 binding form the rollback unit and are
  never mixed with the new application;
- Workshop manifests support format version 2 only;
- each immutable Workshop revision contains one or more named, certified
  runtime profiles;
- sessions require an exact profile selection and, for direct cloud, a matching
  organization provider connection;
- `agent_kvm`, `hetzner_cloud`, and `gcp_compute` implement one provider-neutral
  lifecycle contract;
- D1 is canonical for generic lifecycle state, while route-less provider
  Workers own credentials, catalog/API calls, retries, and provider-specific
  reconciliation;
- the Hetzner and GCP Workers are Astro auxiliary Workers for local composition
  and independent production services for deployment and rollback;
- learners stay on the same VM during normal module progression. Restore or
  recovery creates a new generation from a signed reconstruction bundle;
- forecasts and final estimates are immutable provider-native line items, not
  invoices.

No old manifest parser, API fallback, dual write, backfill, comparison read, or
compatibility view is retained.

## Consequences

The owner must sign in again, recreate the pilot organization, reconnect the
dedicated Hetzner and GCP projects, and republish content after cutover. That is
intentional and testable through repeatable bootstrap commands.

The old database remains read-only for a bounded rollback window. Deleting it,
old Worker identities, or old provider Durable Object namespaces requires a
separate explicit confirmation after all new-provider resources are proven
deleted.

Provider feature flags stop allocation and restore issuance but never disable
observation, deletion, cost accrual, or reconciliation.
