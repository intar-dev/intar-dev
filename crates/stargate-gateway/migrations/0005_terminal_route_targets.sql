ALTER TABLE routes
    ADD COLUMN generation TEXT NOT NULL DEFAULT '';

ALTER TABLE routes
    ADD COLUMN mode TEXT NOT NULL DEFAULT 'browser';

-- A route target is one row, not a set of nullable columns: either the route
-- has a complete target or it has none.
CREATE TABLE terminal_route_targets (
    route_username TEXT PRIMARY KEY NOT NULL,
    -- One staged or active attachment. A row with activated_at NULL is staged:
    -- it is stored and validated, and the gateway still does not dial with it.
    attachment_id TEXT NOT NULL,
    activated_at INTEGER,
    target_username TEXT NOT NULL,
    target_host TEXT NOT NULL,
    target_port INTEGER NOT NULL,
    target_host_key_openssh TEXT NOT NULL,
    target_private_key_openssh TEXT NOT NULL,
    authorized_client_public_keys_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (route_username) REFERENCES routes (route_username)
        ON DELETE CASCADE
);

-- The previous schema stored the target and the guest key in the route row.
-- A pending browser route must hold neither, so the create path no longer
-- writes these columns. Drop them, together with the rows that an older
-- gateway wrote, so no route can serve a target that the new flow did not
-- attach.
DROP INDEX IF EXISTS routes_expiry_idx;

ALTER TABLE routes
    DROP COLUMN target_username;

ALTER TABLE routes
    DROP COLUMN target_ip;

ALTER TABLE routes
    DROP COLUMN target_port;

ALTER TABLE routes
    DROP COLUMN authorized_client_public_keys_json;

ALTER TABLE routes
    DROP COLUMN target_host_key_openssh;

ALTER TABLE routes
    DROP COLUMN target_private_key_openssh;

CREATE INDEX routes_expiry_idx ON routes (expires_at);

-- The old rows carried the target and the guest key in the route row, and an
-- upgraded gateway would give them an empty generation. No compatibility path
-- is wanted: this migration runs during one drained cutover, so the old rows
-- go. A route that a control plane issues after the cutover is unaffected.
DELETE FROM routes;
