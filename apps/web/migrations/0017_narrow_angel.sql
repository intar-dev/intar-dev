CREATE TABLE `host_geo_locations` (
	`ip` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`latitude` real,
	`longitude` real,
	`city` text,
	`country` text,
	`resolved_at` integer NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT "host_geo_locations_status_valid" CHECK("status" in ('resolved', 'unresolved')),
	CONSTRAINT "host_geo_locations_shape_valid" CHECK(("status" = 'resolved' and "latitude" is not null and "longitude" is not null) or ("status" = 'unresolved' and "latitude" is null and "longitude" is null))
);
--> statement-breakpoint
CREATE INDEX `host_geo_locations_resolved_idx` ON `host_geo_locations` (`resolved_at`);--> statement-breakpoint
ALTER TABLE `agent_hosts` ADD `provider` text;