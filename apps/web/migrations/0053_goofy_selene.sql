DROP TABLE `organization_entitlements`;--> statement-breakpoint
DROP TABLE `scenario_revision_holds`;--> statement-breakpoint
ALTER TABLE `scenario_sources` DROP COLUMN `promotion`;--> statement-breakpoint
ALTER TABLE `scenario_sources` DROP COLUMN `promotion_after`;--> statement-breakpoint
ALTER TABLE `scenarios` DROP COLUMN `play`;