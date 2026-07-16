-- Organizations are a hard product cutover. Existing Better Auth organization
-- and member rows remain valid; the GitHub-username invitation model is
-- deliberately removed with its retired table below.

ALTER TABLE `session` ADD COLUMN `active_organization_id` text;

-- Preserve any historical owner rows, but prevent every new insert or role
-- change from giving one user ownership of more than one organization.
CREATE TRIGGER `member_single_owner_insert_guard`
BEFORE INSERT ON `member`
WHEN NEW.`role` = 'owner' AND EXISTS (
	SELECT 1 FROM `member`
	WHERE `user_id` = NEW.`user_id` AND `role` = 'owner'
)
BEGIN
	SELECT RAISE(ABORT, 'member owner limit reached');
END;
CREATE TRIGGER `member_single_owner_update_guard`
BEFORE UPDATE OF `role`, `user_id` ON `member`
WHEN NEW.`role` = 'owner' AND EXISTS (
	SELECT 1 FROM `member`
	WHERE `user_id` = NEW.`user_id`
		AND `role` = 'owner'
		AND `id` <> OLD.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'member owner limit reached');
END;

CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`inviter_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `invitation_organizationId_idx` ON `invitation` (`organization_id`);
CREATE INDEX `invitation_email_idx` ON `invitation` (`email`);
CREATE INDEX `invitation_status_idx` ON `invitation` (`status`);

CREATE TABLE `sso_provider` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`domain` text NOT NULL,
	`oidc_config` text,
	`saml_config` text,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`organization_id` text,
	`domain_verified` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `sso_provider_provider_id_uidx` ON `sso_provider` (`provider_id`);
CREATE UNIQUE INDEX `sso_provider_organization_id_uidx` ON `sso_provider` (`organization_id`);
CREATE UNIQUE INDEX `sso_provider_domain_uidx` ON `sso_provider` (`domain`);
CREATE INDEX `sso_provider_user_id_idx` ON `sso_provider` (`user_id`);

DROP TABLE `team_invites`;

ALTER TABLE `scenario_sources` ADD COLUMN `organization_id` text REFERENCES `organization`(`id`) ON DELETE restrict;
CREATE INDEX `scenario_sources_organization_idx` ON `scenario_sources` (`organization_id`, `updated_at`);

ALTER TABLE `vm_scenarios` ADD COLUMN `organization_id` text REFERENCES `organization`(`id`) ON DELETE restrict;
CREATE INDEX `vm_scenarios_organization_enabled_idx` ON `vm_scenarios` (`organization_id`, `enabled`, `enabled_at`);

ALTER TABLE `image_build_bundles` ADD COLUMN `organization_id` text REFERENCES `organization`(`id`) ON DELETE restrict;
CREATE INDEX `image_build_bundles_organization_idx` ON `image_build_bundles` (`organization_id`, `updated_at`);

ALTER TABLE `image_builds` ADD COLUMN `organization_id` text REFERENCES `organization`(`id`) ON DELETE restrict;
CREATE INDEX `image_builds_organization_idx` ON `image_builds` (`organization_id`, `status`, `updated_at`);

ALTER TABLE `scenario_runs` ADD COLUMN `organization_id` text REFERENCES `organization`(`id`) ON DELETE restrict;
CREATE INDEX `scenario_runs_organization_idx` ON `scenario_runs` (`organization_id`, `created_at`);

ALTER TABLE `agent_hosts` ADD COLUMN `organization_id` text REFERENCES `organization`(`id`) ON DELETE restrict;
CREATE INDEX `agent_hosts_organization_idx` ON `agent_hosts` (`organization_id`, `role`, `connected`);

-- New bootstrap credentials live until explicit rotation, revocation, host
-- disablement, or host deletion. Preserve expired/revoked legacy rows as-is;
-- only credentials that are still valid at migration time become unbounded.
CREATE TABLE `agent_bootstrap_tokens_next` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
INSERT INTO `agent_bootstrap_tokens_next` (`id`, `host_id`, `token_hash`, `expires_at`, `revoked_at`, `created_at`)
SELECT
	`id`,
	`host_id`,
	`token_hash`,
	CASE
		WHEN `revoked_at` IS NULL AND `expires_at` > cast(unixepoch('subsecond') * 1000 as integer) THEN NULL
		ELSE `expires_at`
	END,
	`revoked_at`,
	`created_at`
FROM `agent_bootstrap_tokens`;
DROP TABLE `agent_bootstrap_tokens`;
ALTER TABLE `agent_bootstrap_tokens_next` RENAME TO `agent_bootstrap_tokens`;
CREATE INDEX `agent_bootstrap_tokens_host_idx` ON `agent_bootstrap_tokens` (`host_id`);
CREATE INDEX `agent_bootstrap_tokens_hash_idx` ON `agent_bootstrap_tokens` (`token_hash`);
