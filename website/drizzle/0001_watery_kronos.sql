DELETE FROM `vm_scenario_probes`;--> statement-breakpoint
DELETE FROM `vm_scenario_vms`;--> statement-breakpoint
DELETE FROM `vm_scenarios`;--> statement-breakpoint
ALTER TABLE `vm_scenario_probes` ADD `title` text;--> statement-breakpoint
ALTER TABLE `vm_scenario_probes` ADD `body_markdown` text;--> statement-breakpoint
ALTER TABLE `vm_scenario_probes` ADD `hints_json` text NOT NULL DEFAULT '[]';--> statement-breakpoint
ALTER TABLE `vm_scenario_vms` ADD `image_format` text NOT NULL DEFAULT 'raw_zstd';--> statement-breakpoint
ALTER TABLE `vm_scenario_vms` ADD `image_virtual_size_bytes` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `vm_scenario_vms` ADD `kernel_sha256` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `vm_scenario_vms` ADD `initrd_sha256` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `vm_scenario_vms` ADD `boot_cmdline` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `vm_scenarios` ADD `title` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `vm_scenarios` ADD `difficulty` text NOT NULL DEFAULT 'easy';--> statement-breakpoint
ALTER TABLE `vm_scenarios` ADD `estimated_minutes` integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE `vm_scenarios` ADD `tags_json` text NOT NULL DEFAULT '[]';--> statement-breakpoint
ALTER TABLE `vm_scenarios` ADD `briefing_markdown` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `vm_scenarios` ADD `solution_markdown` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `vm_scenarios` ADD `hints_json` text NOT NULL DEFAULT '[]';
