-- Contract identity cannot be reconstructed safely for an already-live lease.
-- The breaking V2 cutover therefore requires the exclusive benchmark ledger
-- to be empty rather than manufacturing a permissive legacy contract.
CREATE TABLE IF NOT EXISTS `_intar_benchmark_contract_cutover_guard` (
	`ok` integer NOT NULL,
	CONSTRAINT `_intar_benchmark_contract_cutover_guard_drained` CHECK (`ok` = 1)
);
--> statement-breakpoint
DELETE FROM `_intar_benchmark_contract_cutover_guard`;
--> statement-breakpoint
INSERT INTO `_intar_benchmark_contract_cutover_guard` (`ok`)
SELECT CASE WHEN EXISTS (SELECT 1 FROM `host_benchmark_leases`)
	THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `_intar_benchmark_contract_cutover_guard`;
--> statement-breakpoint
ALTER TABLE `host_benchmark_leases` ADD `contract_sha256` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `host_benchmark_leases` ADD `credential_not_before_unix_ms` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `host_benchmark_leases` ADD `credential_expires_at_unix_ms` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `host_benchmark_lease_contract_is_valid`
BEFORE INSERT ON `host_benchmark_leases`
WHEN length(NEW.`contract_sha256`) != 64
	OR NEW.`contract_sha256` GLOB '*[^0-9a-f]*'
	OR NEW.`credential_not_before_unix_ms` <= 0
	OR NEW.`credential_expires_at_unix_ms` <= NEW.`credential_not_before_unix_ms`
	OR NEW.`acquired_at` < NEW.`credential_not_before_unix_ms`
	OR NEW.`acquired_at` >= NEW.`credential_expires_at_unix_ms`
BEGIN
	SELECT RAISE(ABORT, 'invalid benchmark admission contract');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `host_benchmark_lease_contract_is_immutable`
BEFORE UPDATE OF `contract_sha256`, `credential_not_before_unix_ms`, `credential_expires_at_unix_ms` ON `host_benchmark_leases`
WHEN NEW.`contract_sha256` IS NOT OLD.`contract_sha256`
	OR NEW.`credential_not_before_unix_ms` IS NOT OLD.`credential_not_before_unix_ms`
	OR NEW.`credential_expires_at_unix_ms` IS NOT OLD.`credential_expires_at_unix_ms`
BEGIN
	SELECT RAISE(ABORT, 'benchmark admission contract is immutable');
END;
