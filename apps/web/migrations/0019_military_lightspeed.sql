ALTER TABLE `agent_hosts` ADD `scope` text;--> statement-breakpoint
ALTER TABLE `agent_hosts` ADD `credential_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `metal_placement` text DEFAULT 'platform' NOT NULL;