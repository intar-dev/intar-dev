import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ImageKey, ScenarioHintManifestV3 } from "@/generated/catalog";
import { jsonText, nowMsDefault } from "./shared";

export const vmScenarios = sqliteTable(
  "vm_scenarios",
  {
    scenarioId: text("scenario_id").primaryKey(),
    title: text("title").notNull(),
    category: text("category").default("").notNull(),
    description: text("description").notNull(),
    difficulty: text("difficulty").notNull(),
    estimatedMinutes: integer("estimated_minutes").notNull(),
    tagsJson: jsonText<string[]>("tags_json").notNull(),
    briefingMarkdown: text("briefing_markdown").notNull(),
    solutionMarkdown: text("solution_markdown").notNull(),
    hintsJson: jsonText<ScenarioHintManifestV3[]>("hints_json").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).default(false).notNull(),
    enabledAt: integer("enabled_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("vm_scenarios_enabled_idx").on(table.enabled, table.enabledAt),
  ],
);

export const vmScenarioVms = sqliteTable(
  "vm_scenario_vms",
  {
    id: text("id").primaryKey(),
    scenarioId: text("scenario_id")
      .notNull()
      .references(() => vmScenarios.scenarioId, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    vmName: text("vm_name").notNull(),
    image: text("image").notNull(),
    imageKeyJson: jsonText<ImageKey>("image_key_json"),
    imageSha256: text("image_sha256"),
    imageFormat: text("image_format").notNull(),
    imageVirtualSizeBytes: integer("image_virtual_size_bytes").notNull(),
    kernelSha256: text("kernel_sha256").notNull(),
    initrdSha256: text("initrd_sha256").notNull(),
    bootCmdline: text("boot_cmdline").notNull(),
    cpuMillis: integer("cpu_millis").notNull(),
    vcpuCount: integer("vcpu_count").notNull(),
    memoryMib: integer("memory_mib").notNull(),
    diskMib: integer("disk_mib").notNull(),
  },
  (table) => [
    uniqueIndex("vm_scenario_vms_scenario_ordinal_uidx").on(
      table.scenarioId,
      table.ordinal,
    ),
    uniqueIndex("vm_scenario_vms_scenario_name_uidx").on(
      table.scenarioId,
      table.vmName,
    ),
    index("vm_scenario_vms_scenario_idx").on(table.scenarioId, table.ordinal),
  ],
);

export const vmScenarioProbes = sqliteTable(
  "vm_scenario_probes",
  {
    id: text("id").primaryKey(),
    scenarioId: text("scenario_id")
      .notNull()
      .references(() => vmScenarios.scenarioId, { onDelete: "cascade" }),
    scenarioVmId: text("scenario_vm_id")
      .notNull()
      .references(() => vmScenarioVms.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    title: text("title"),
    bodyMarkdown: text("body_markdown"),
    hintsJson: jsonText<ScenarioHintManifestV3[]>("hints_json").notNull(),
    phase: text("phase").default("scenario").notNull(),
    // Probe kind from the manifest (file_exists, port_open, service, …) —
    // drives the per-kind "why is this failing" rendering on the run page.
    kind: text("kind").default("probe").notNull(),
  },
  (table) => [
    uniqueIndex("vm_scenario_probes_vm_ordinal_uidx").on(
      table.scenarioVmId,
      table.ordinal,
    ),
    index("vm_scenario_probes_scenario_idx").on(
      table.scenarioId,
      table.scenarioVmId,
      table.ordinal,
    ),
  ],
);
