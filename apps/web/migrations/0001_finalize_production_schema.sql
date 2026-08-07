DROP INDEX IF EXISTS `workshop_template_revisions_content_uidx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `workshop_template_revisions_content_idx`;
--> statement-breakpoint
CREATE INDEX `workshop_template_revisions_content_idx`
  ON `workshop_template_revisions` (`template_id`, `content_hash`);
--> statement-breakpoint
WITH confirmed_delete_operations AS (
  SELECT
    operation.id,
    MAX(
      resource.disappearance_confirmed_at,
      allocation.deletion_confirmed_at
    ) AS confirmed_at
  FROM runtime_provider_operations AS operation
  JOIN runtime_provider_allocations AS allocation
    ON allocation.id = operation.allocation_id
   AND allocation.location_attempt = operation.location_attempt
  JOIN runtime_provider_resources AS resource
    ON resource.allocation_id = operation.allocation_id
   AND resource.location_attempt = operation.location_attempt
  WHERE operation.state IN ('pending', 'running', 'retryable')
    AND allocation.state = 'deleted'
    AND allocation.deletion_confirmed_at IS NOT NULL
    AND resource.disappearance_confirmed_at IS NOT NULL
    AND (
      (resource.resource_kind = 'instance' AND (
        operation.operation_kind = 'delete_server' OR
        operation.operation_kind GLOB 'delete_server:*' OR
        operation.operation_kind = 'delete_instance' OR
        operation.operation_kind GLOB 'delete_instance:*'
      )) OR
      (resource.resource_kind = 'boot_disk' AND (
        operation.operation_kind = 'delete_disk' OR
        operation.operation_kind GLOB 'delete_disk:*'
      )) OR
      (resource.resource_kind = 'ipv4' AND (
        operation.operation_kind = 'delete_primary_ip' OR
        operation.operation_kind GLOB 'delete_primary_ip:*'
      )) OR
      (resource.resource_kind = 'ssh_key' AND (
        operation.operation_kind = 'delete_ssh_key' OR
        operation.operation_kind GLOB 'delete_ssh_key:*'
      ))
    )
)
UPDATE runtime_provider_operations
SET state = 'succeeded',
    retry_at = NULL,
    last_polled_at = COALESCE(
      last_polled_at,
      (SELECT confirmed_at FROM confirmed_delete_operations
       WHERE confirmed_delete_operations.id = runtime_provider_operations.id)
    ),
    completed_at = COALESCE(
      completed_at,
      (SELECT confirmed_at FROM confirmed_delete_operations
       WHERE confirmed_delete_operations.id = runtime_provider_operations.id)
    ),
    error_class = NULL,
    error_code = NULL,
    sanitized_result_json = json_set(
      COALESCE(sanitized_result_json, '{}'),
      '$.confirmedAbsent', json('true'),
      '$.historicalRepair', json('true')
    ),
    updated_at = MAX(
      updated_at,
      (SELECT confirmed_at FROM confirmed_delete_operations
       WHERE confirmed_delete_operations.id = runtime_provider_operations.id)
    )
WHERE id IN (SELECT id FROM confirmed_delete_operations);
--> statement-breakpoint
DROP TABLE `clean_d1_commissioning`;
