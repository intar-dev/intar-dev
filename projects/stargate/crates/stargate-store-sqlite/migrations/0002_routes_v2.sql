ALTER TABLE routes RENAME TO routes_legacy;

CREATE TABLE routes (
    route_username TEXT PRIMARY KEY NOT NULL,
    target_username TEXT NOT NULL,
    target_ip TEXT NOT NULL,
    target_port INTEGER NOT NULL,
    native_client_public_key_openssh TEXT,
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
    native_client_public_key_openssh,
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
    username AS route_username,
    username AS target_username,
    target_ip,
    target_port,
    public_key_openssh AS native_client_public_key_openssh,
    target_host_key_openssh,
    253402300799 AS expires_at,
    NULL AS host_id,
    NULL AS run_id,
    NULL AS vm_id,
    NULL AS user_id,
    created_at,
    updated_at
FROM routes_legacy;

DROP TABLE routes_legacy;

CREATE INDEX routes_expiry_idx ON routes (expires_at);
