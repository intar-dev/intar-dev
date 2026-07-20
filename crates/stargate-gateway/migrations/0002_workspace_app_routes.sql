CREATE TABLE workspace_app_routes (
    route_id TEXT PRIMARY KEY NOT NULL,
    target_username TEXT NOT NULL,
    target_ip TEXT NOT NULL,
    target_ssh_port INTEGER NOT NULL,
    target_host_key_openssh TEXT NOT NULL,
    target_private_key_openssh TEXT NOT NULL,
    target_app_port INTEGER NOT NULL,
    protocol TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    host_id TEXT,
    run_id TEXT,
    vm_id TEXT,
    user_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX workspace_app_routes_expiry_idx
    ON workspace_app_routes (expires_at);
