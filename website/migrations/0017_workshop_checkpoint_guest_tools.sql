ALTER TABLE `runtime_provider_checkpoint_artifacts`
ADD COLUMN `workspace_agent_sha256` text;

ALTER TABLE `runtime_provider_checkpoint_artifacts`
ADD COLUMN `kino_sha256` text;

CREATE TRIGGER `runtime_provider_checkpoint_guest_tools_insert_guard`
BEFORE INSERT ON `runtime_provider_checkpoint_artifacts`
WHEN NEW.`provider_kind` = 'hetzner_cloud' AND (
  NEW.`workspace_agent_sha256` IS NULL OR
  length(NEW.`workspace_agent_sha256`) != 64 OR
  NEW.`workspace_agent_sha256` GLOB '*[^0-9a-f]*' OR
  NEW.`kino_sha256` IS NULL OR
  length(NEW.`kino_sha256`) != 64 OR
  NEW.`kino_sha256` GLOB '*[^0-9a-f]*'
)
BEGIN
  SELECT RAISE(ABORT, 'verified provider checkpoints require pinned guest-tool digests');
END;
