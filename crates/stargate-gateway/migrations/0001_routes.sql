CREATE TABLE routes (
    route_username TEXT PRIMARY KEY NOT NULL,
    target_username TEXT NOT NULL,
    target_ip TEXT NOT NULL,
    target_port INTEGER NOT NULL,
    authorized_client_public_keys_json TEXT NOT NULL,
    target_host_key_openssh TEXT NOT NULL,
    target_private_key_openssh TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    host_id TEXT,
    run_id TEXT,
    vm_id TEXT,
    user_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX routes_expiry_idx ON routes (expires_at);
