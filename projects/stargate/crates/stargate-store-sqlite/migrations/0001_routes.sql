CREATE TABLE IF NOT EXISTS routes (
    username TEXT PRIMARY KEY NOT NULL,
    target_ip TEXT NOT NULL,
    target_port INTEGER NOT NULL,
    public_key_openssh TEXT NOT NULL,
    private_key_openssh TEXT NOT NULL,
    target_host_key_openssh TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
