ALTER TABLE `agent_hosts` ADD `organization_id` text REFERENCES organization(id);--> statement-breakpoint
ALTER TABLE `host_enrollments` ADD `organization_id` text REFERENCES organization(id);--> statement-breakpoint
ALTER TABLE `organization` ADD `metal_placement` text DEFAULT 'platform' NOT NULL;