CREATE TABLE `personal_image_preparations` (
	`user_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`credential_generation` integer NOT NULL,
	`request_key` text NOT NULL,
	`access_json` text NOT NULL,
	`beta_json` text NOT NULL,
	`images_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
