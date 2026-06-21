ALTER TABLE `agent_hosts` ADD `server_transport_id` text;--> statement-breakpoint
ALTER TABLE `agent_hosts` ADD `host_transport_id` text;--> statement-breakpoint
UPDATE `agent_hosts`
SET
  `server_transport_id` = NULLIF(trim(CAST(json_extract(`runtime_state_json`, '$.serverTransportId') AS text)), ''),
  `host_transport_id` = NULLIF(trim(CAST(json_extract(`runtime_state_json`, '$.hostTransportId') AS text)), '')
WHERE `runtime_state_json` IS NOT NULL;
