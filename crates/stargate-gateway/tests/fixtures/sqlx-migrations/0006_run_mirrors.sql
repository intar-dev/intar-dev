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
