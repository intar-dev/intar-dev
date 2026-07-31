DROP INDEX `workshop_publications_org_hash_uidx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_publications_org_hash_active_uidx`
ON `workshop_publications` (`organization_id`, `content_hash`)
WHERE `status` <> 'failed';
