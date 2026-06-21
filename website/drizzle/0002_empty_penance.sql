CREATE TABLE `host_rpc_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`transport_id` text NOT NULL,
	`message_id` text NOT NULL,
	`call_id` text,
	`kind` text NOT NULL,
	`method` text NOT NULL,
	`payload_json` text NOT NULL,
	`received_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_rpc_receipts_host_transport_message_uidx` ON `host_rpc_receipts` (`host_id`,`transport_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `host_rpc_receipts_host_expiry_idx` ON `host_rpc_receipts` (`host_id`,`expires_at`);
--> statement-breakpoint
DELETE FROM `host_rpc_envelopes` WHERE `direction` = 'host_to_server';
