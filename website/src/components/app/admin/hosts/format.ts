// Formatting helpers and badge tones for the hosts console. Extracted
// verbatim from the old Dashboard monolith.

import type { AgentVmRunRecord } from "./types";

export const formatTimestamp = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";

export const formatTimestampMs = (value: number | null | undefined) =>
  typeof value === "number" ? new Date(value).toLocaleString() : "—";

export const formatLoad = (value: number | null | undefined) =>
  typeof value === "number" ? value.toFixed(2) : "—";

export const formatBytes = (value: number | null | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "—";
  }
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
};

export const formatDurationMs = (value: number | null | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "—";
  }
  const totalSeconds = Math.floor(value / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts = hours > 0 ? [hours, minutes, seconds] : [minutes, seconds];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
};

export const artifactKindLabel = (kind: string) => {
  switch (kind) {
    case "console_log":
      return "Console";
    case "serial_log":
      return "Serial";
    case "ssh_recording_segment":
      return "Session Cast";
    case "ssh_recording_raw":
      return "Raw";
    default:
      return kind.replace(/_/g, " ");
  }
};

export const milestoneLabel = (kind: string) =>
  kind.replace(/_/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());

export const runStatusTone = (uploadStatus: string) => {
  switch (uploadStatus) {
    case "complete":
      return {
        rail: "bg-primary",
        badgeVariant: "secondary" as const,
        label: "Archived",
      };
    case "uploading":
      return {
        rail: "bg-secondary-foreground/40",
        badgeVariant: "outline" as const,
        label: "Uploading",
      };
    default:
      return {
        rail: "bg-destructive/80",
        badgeVariant: "destructive" as const,
        label: "Needs retry",
      };
  }
};

export const runOutcomeTone = (outcome: AgentVmRunRecord["outcome"]) => {
  switch (outcome) {
    case "succeeded":
      return {
        badgeVariant: "secondary" as const,
        label: "Succeeded",
      };
    case "cancelled":
      return {
        badgeVariant: "outline" as const,
        label: "Cancelled",
      };
    case "failed":
      return {
        badgeVariant: "destructive" as const,
        label: "Failed",
      };
    case "in_progress":
      return {
        badgeVariant: "outline" as const,
        label: "In progress",
      };
  }
};

export const probeStatusTone = (status: string) => {
  switch (status) {
    case "pass":
      return "secondary" as const;
    case "fail":
      return "destructive" as const;
    default:
      return "outline" as const;
  }
};

export const probeCollectionTone = (state: string) =>
  state === "error"
    ? "border-destructive/30 bg-destructive/5 text-destructive"
    : "border-border bg-secondary text-secondary-foreground";

export const summarizeProbeValue = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  const object = value as Record<string, unknown>;
  if (typeof object.path === "string" && typeof object.exists === "boolean") {
    return `${object.path} ${object.exists ? "exists" : "missing"}`;
  }
  if (
    typeof object.host === "string" &&
    typeof object.port === "number" &&
    typeof object.open === "boolean"
  ) {
    return `${object.host}:${object.port} ${object.open ? "open" : "closed"}`;
  }
  if (
    typeof object.service === "string" &&
    typeof object.desiredState === "string"
  ) {
    const actualState =
      typeof object.actualState === "string" && object.actualState.trim()
        ? ` (${object.actualState})`
        : "";
    return `${object.service} -> ${object.desiredState}${actualState}`;
  }
  const serialized = JSON.stringify(object);
  return serialized.length > 120
    ? `${serialized.slice(0, 117)}...`
    : serialized;
};

export const parseTimestamp = (value: string | null | undefined) => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
