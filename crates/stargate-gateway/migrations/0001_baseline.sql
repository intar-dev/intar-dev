-- The schema that stargate 0.6's six sqlx migrations produced, as one file.
-- Columns keep the order those migrations left them in, so a fresh database
-- and an adopted one are identical (store.rs tests both).

CREATE TABLE routes (
    route_username TEXT PRIMARY KEY NOT NULL,
    expires_at INTEGER NOT NULL,
    host_id TEXT,
    run_id TEXT,
    vm_id TEXT,
    user_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    generation TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'browser'
);

CREATE INDEX routes_expiry_idx ON routes (expires_at);

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
    updated_at INTEGER NOT NULL,
    bootstrap_token_sha256 TEXT,
    bootstrap_expires_at INTEGER,
    upstream_host TEXT
);

CREATE INDEX workspace_app_routes_expiry_idx
    ON workspace_app_routes (expires_at);

CREATE TABLE workspace_app_browser_sessions (
    route_id TEXT NOT NULL,
    token_sha256 TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (route_id, token_sha256),
    FOREIGN KEY (route_id) REFERENCES workspace_app_routes (route_id)
        ON DELETE CASCADE
);

CREATE INDEX workspace_app_browser_sessions_expiry_idx
    ON workspace_app_browser_sessions (expires_at);

-- One row per run whose terminals stream to a public share. The write token is
-- the bearer secret Stargate presents to the control plane's ingest socket.
CREATE TABLE run_mirrors (
    run_id TEXT PRIMARY KEY NOT NULL,
    share_id TEXT NOT NULL,
    write_token TEXT NOT NULL,
    -- Unix milliseconds when the control plane claimed the share. A late call
    -- for an older claim can not replace a newer share.
    claimed_at_ms INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
