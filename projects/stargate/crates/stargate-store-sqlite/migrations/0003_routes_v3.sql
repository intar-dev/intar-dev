ALTER TABLE routes RENAME TO routes_v2;
DROP INDEX IF EXISTS routes_expiry_idx;

CREATE TABLE routes (
    route_username TEXT PRIMARY KEY NOT NULL,
    target_username TEXT NOT NULL,
    target_ip TEXT NOT NULL,
    target_port INTEGER NOT NULL,
    authorized_client_public_keys_json TEXT NOT NULL,
    target_host_key_openssh TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    host_id TEXT,
    run_id TEXT,
    vm_id TEXT,
    user_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

INSERT INTO routes (
    route_username,
    target_username,
    target_ip,
    target_port,
    authorized_client_public_keys_json,
    target_host_key_openssh,
    expires_at,
    host_id,
    run_id,
    vm_id,
    user_id,
    created_at,
    updated_at
)
SELECT
    route_username,
    target_username,
    target_ip,
    target_port,
    CASE
        WHEN native_client_public_key_openssh IS NULL THEN '[]'
        ELSE json_array(native_client_public_key_openssh)
    END AS authorized_client_public_keys_json,
    target_host_key_openssh,
    expires_at,
    host_id,
    run_id,
    vm_id,
    user_id,
    created_at,
    updated_at
FROM routes_v2;

DROP TABLE routes_v2;

CREATE INDEX routes_expiry_idx ON routes (expires_at);
