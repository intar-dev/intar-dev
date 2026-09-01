INSERT INTO `runtime_operation_gates` (`key`, `state`, `updated_at`)
SELECT 'image_cutover', `state`, `updated_at`
FROM `runtime_operation_gates`
WHERE `key` = 'image_v10_cutover'
ON CONFLICT(`key`) DO UPDATE SET
  `state` = excluded.`state`,
  `updated_at` = excluded.`updated_at`;--> statement-breakpoint
DELETE FROM `runtime_operation_gates`
WHERE `key` = 'image_v10_cutover';
