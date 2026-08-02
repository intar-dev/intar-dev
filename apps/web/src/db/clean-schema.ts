/**
 * Schema entrypoint for the clean-slate database.
 *
 * During the cutover the former `schema.ts` remains coupled to the offline
 * rollback database. New provider/runtime code imports this module only.
 */
export {
  account,
  invitation,
  member,
  organization,
  session,
  ssoProvider,
  user,
  userSshKeys,
  verification,
} from "./schema/core";
export {
  gcpConnectionDetails,
  hetznerConnectionDetails,
  providerAuditEvents,
  providerConnections,
  providerCredentialVersions,
  providerPriceLineItems,
  providerPriceObservations,
  runtimeActualState,
  runtimeArtifactUploadGrants,
  runtimeCheckpointBundles,
  runtimeGuestCredentials,
  runtimeGuestReports,
  runtimeProviderAllocations,
  runtimeProviderCostLedger,
  runtimeProviderOperations,
  runtimeProviderReconciliation,
  runtimeProviderResources,
  workshopRuntimeProfileCertifications,
  workshopRuntimeProfiles,
  workshopSessionCostForecastLineItems,
  workshopSessionCostForecasts,
  workshopSessionCostSummaries,
  workshopSessionRuntimeSelections,
} from "./schema/multicloud";
export type {
  DirectCloudProviderKind,
  ProviderConnectionState,
  ProviderOperationState,
  StoredResolvedRuntimeProfile,
} from "./schema/multicloud";
export {
  activeRuntimeSlots,
  hostResourceReservations,
  runtimeAllocationLocks,
  runtimeArtifactUploads,
  runtimeArtifacts,
  runtimeExecutions,
  runtimeTerminalSessions,
  runtimeVmAccessKeys,
  runtimeVmActualState,
  runtimeVms,
} from "./schema/runtime";
export {
  workshopAssistGrants,
  workshopEvents,
  workshopHelpRequests,
  workshopModuleProgress,
  workshopSessionMembers,
  workshopSessions,
  workshopTemplateRevisions,
  workshopTemplates,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
} from "./schema/workshops";
