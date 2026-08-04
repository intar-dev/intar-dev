CREATE INDEX IF NOT EXISTS `workshop_template_revisions_content_idx`
  ON `workshop_template_revisions` (`template_id`, `content_hash`);
DROP INDEX IF EXISTS `workshop_template_revisions_content_uidx`;
