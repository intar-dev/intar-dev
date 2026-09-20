import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { BetaAdmissionEpoch } from "@/lib/allowlist";
import type { AdmissionContentAccess } from "@/lib/scenario-runs/admission-guards";
import type { RequiredScenarioImage } from "@/lib/scenario-host-readiness";
import { user } from "./core";
import { agentHosts } from "./platform";
import { jsonText } from "./shared";

/** One pending image preparation per owner, replaced by the next start request. */
export const personalImagePreparations = sqliteTable("personal_image_preparations", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  hostId: text("host_id").notNull().references(() => agentHosts.id, { onDelete: "cascade" }),
  credentialGeneration: integer("credential_generation").notNull(),
  requestKey: text("request_key").notNull(),
  accessJson: jsonText<AdmissionContentAccess>("access_json").notNull(),
  betaJson: jsonText<BetaAdmissionEpoch>("beta_json").notNull(),
  imagesJson: jsonText<RequiredScenarioImage[]>("images_json").notNull(),
  expiresAt: integer("expires_at").notNull(),
});
