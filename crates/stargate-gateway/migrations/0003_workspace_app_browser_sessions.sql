ALTER TABLE workspace_app_routes
    ADD COLUMN bootstrap_token_sha256 TEXT;

ALTER TABLE workspace_app_routes
    ADD COLUMN bootstrap_expires_at INTEGER;

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
