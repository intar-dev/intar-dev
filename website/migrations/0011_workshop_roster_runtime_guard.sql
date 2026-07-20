CREATE TRIGGER `workshop_session_members_runtime_insert_guard`
BEFORE INSERT ON `workshop_session_members`
WHEN EXISTS (
	SELECT 1
	FROM `workshop_workspaces` w
	WHERE w.`session_id` = NEW.`session_id`
)
BEGIN
	SELECT RAISE(ABORT, 'workshop roster is immutable after workspace provisioning starts');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_members_runtime_update_guard`
BEFORE UPDATE OF `session_id`, `user_id`, `role` ON `workshop_session_members`
WHEN (
	OLD.`session_id` IS NOT NEW.`session_id`
	OR OLD.`user_id` IS NOT NEW.`user_id`
	OR OLD.`role` IS NOT NEW.`role`
) AND EXISTS (
	SELECT 1
	FROM `workshop_workspaces` w
	WHERE w.`session_id` = OLD.`session_id`
		OR w.`session_id` = NEW.`session_id`
)
BEGIN
	SELECT RAISE(ABORT, 'workshop roster is immutable after workspace provisioning starts');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_members_runtime_delete_guard`
BEFORE DELETE ON `workshop_session_members`
WHEN EXISTS (
	SELECT 1
	FROM `workshop_workspaces` w
	WHERE w.`session_id` = OLD.`session_id`
)
BEGIN
	SELECT RAISE(ABORT, 'workshop roster is immutable after workspace provisioning starts');
END;
