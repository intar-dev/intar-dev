use std::{
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use rusqlite::{Connection, OptionalExtension as _, Row, Transaction, params};
use serde_json::{from_str as json_from_str, to_string as json_to_string};
use stargate_core::{
    RegisteredWorkspaceAppRoute, Result, RouteMetadata, StargateError, StoredTarget,
    StoredTerminalRoute, TerminalSessionMode, TerminalTarget, WorkspaceAppMetadata,
    WorkspaceAppProtocol, WorkspaceAppRouteRecord, new_attachment_id,
};
use time::OffsetDateTime;

/// Schema versions, recorded in `PRAGMA user_version`: entry `n` moves a
/// database from version `n` to `n + 1`. Version 1 is the baseline, the schema
/// stargate 0.6's sqlx migrations left behind. Append new migrations; never
/// edit one that shipped.
const MIGRATIONS: &[&str] = &[include_str!("../migrations/0001_baseline.sql")];

/// The `_sqlx_migrations` rows of a database that stargate 0.6 migrated. Only
/// that exact history is adopted as the baseline.
const SQLX_MIGRATIONS: &[(i64, &str)] = &[
    (1, "routes"),
    (2, "workspace app routes"),
    (3, "workspace app browser sessions"),
    (4, "workspace app upstream host"),
    (5, "terminal route targets"),
    (6, "run mirrors"),
];

/// ponytail: one connection behind a mutex, and queries run inline on the
/// async worker. Every statement is a small indexed read or write on a local
/// file; move them to spawn_blocking if store latency ever shows in the proxy.
#[derive(Clone)]
pub struct SqliteRouteStore {
    connection: Arc<Mutex<Connection>>,
}

/// The terminal route state visible to a route replacement. This deliberately
/// includes expired records: their live SSH sessions can still be present
/// until the expiry worker observes and terminates them.
pub(crate) enum RouteRotationPrevious {
    Missing,
    Present(Box<StoredTerminalRoute>),
    Malformed,
}

impl SqliteRouteStore {
    pub async fn connect<P: AsRef<Path>>(database_path: P) -> Result<Self> {
        let path = database_path.as_ref();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let mut connection = Connection::open(path).map_err(db)?;
        // The stage and activate calls read, then write, inside one
        // transaction. A deferred transaction takes its write lock at the
        // first write, so a second writer must wait for the first rather than
        // fail with SQLITE_BUSY. The gateway guards the write path with one
        // in-process mutex, and this timeout is the backstop if a second
        // process ever shares the file. The journal mode stays whatever the
        // file already uses.
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(db)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(db)?;
        migrate(&mut connection)?;

        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| StargateError::Internal("route store lock is poisoned".to_owned()))
    }

    pub async fn healthcheck(&self) -> Result<()> {
        self.lock()?
            .query_row("SELECT 1", [], |_| Ok(()))
            .map_err(db)
    }

    /// Create or replace one terminal route. A replacement writes the route
    /// first, then clears any target that the previous record held, so a reissue
    /// can not inherit the target of the generation it replaced. A create call
    /// that carries an active target (the native route) writes it back at once.
    pub async fn upsert_route(&self, route: StoredTerminalRoute) -> Result<StoredTerminalRoute> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        {
            let mut connection = self.lock()?;
            let transaction = connection.transaction().map_err(db)?;
            transaction
                .execute(
                    r#"
                    INSERT INTO routes (
                        route_username,
                        generation,
                        mode,
                        expires_at,
                        host_id,
                        run_id,
                        vm_id,
                        user_id,
                        created_at,
                        updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(route_username) DO UPDATE SET
                        generation = excluded.generation,
                        mode = excluded.mode,
                        expires_at = excluded.expires_at,
                        host_id = excluded.host_id,
                        run_id = excluded.run_id,
                        vm_id = excluded.vm_id,
                        user_id = excluded.user_id,
                        updated_at = excluded.updated_at
                    "#,
                    params![
                        route.route_username,
                        route.generation,
                        terminal_mode_slug(route.mode),
                        route.expires_at.unix_timestamp(),
                        route.metadata.host_id,
                        route.metadata.run_id,
                        route.metadata.vm_id,
                        route.metadata.user_id,
                        now,
                        now,
                    ],
                )
                .map_err(db)?;

            transaction
                .execute(
                    "DELETE FROM terminal_route_targets WHERE route_username = ?",
                    [&route.route_username],
                )
                .map_err(db)?;
            // A create call can carry an active target, which is how a native
            // route is born ready. A browser route is created with no target,
            // so the row that the delete above removed stays removed.
            if let StoredTarget::Active {
                attachment_id,
                target,
            } = &route.target
            {
                insert_target(
                    &transaction,
                    &route.route_username,
                    attachment_id,
                    Some(now),
                    target,
                    now,
                )?;
            }
            transaction.commit().map_err(db)?;
        }

        self.get_route(&route.route_username).await?.ok_or_else(|| {
            StargateError::Internal("terminal route disappeared after upsert".to_owned())
        })
    }

    pub async fn get_route(&self, route_username: &str) -> Result<Option<StoredTerminalRoute>> {
        self.load_route(
            route_username,
            Some(OffsetDateTime::now_utc().unix_timestamp()),
        )
    }

    pub(crate) async fn get_route_for_rotation(
        &self,
        route_username: &str,
    ) -> Result<RouteRotationPrevious> {
        match self.load_route(route_username, None) {
            Ok(Some(route)) => Ok(RouteRotationPrevious::Present(Box::new(route))),
            Ok(None) => Ok(RouteRotationPrevious::Missing),
            Err(error) => {
                // A valid replacement call must be able to repair a malformed
                // row. The issuer treats this as an authorization change and
                // revokes sessions bound to it.
                tracing::warn!(
                    route_username,
                    error = %error,
                    "terminal route record is malformed during replacement"
                );
                Ok(RouteRotationPrevious::Malformed)
            }
        }
    }

    fn load_route(
        &self,
        route_username: &str,
        live_after: Option<i64>,
    ) -> Result<Option<StoredTerminalRoute>> {
        // A missing bound makes the expiry check pass for every row.
        self.lock()?
            .query_row(
                r#"
                SELECT
                    route.route_username,
                    route.generation,
                    route.mode,
                    route.expires_at,
                    route.host_id,
                    route.run_id,
                    route.vm_id,
                    route.user_id,
                    route.created_at,
                    route.updated_at,
                    target.route_username AS target_route_username,
                    target.attachment_id,
                    target.activated_at,
                    target.target_username,
                    target.target_host,
                    target.target_port,
                    target.target_host_key_openssh,
                    target.target_private_key_openssh,
                    target.authorized_client_public_keys_json
                FROM routes AS route
                LEFT JOIN terminal_route_targets AS target
                    ON target.route_username = route.route_username
                WHERE route.route_username = ?1
                  AND (?2 IS NULL OR route.expires_at > ?2)
                "#,
                params![route_username, live_after],
                |row| Ok(row_to_route(row)),
            )
            .optional()
            .map_err(db)?
            .transpose()
    }

    /// Stage a target on a live pending route. The write binds the exact
    /// identity that the control plane repeated, and it leaves the target
    /// inactive: `ready_target` returns nothing until activation, so no socket
    /// dials the guest from a stage call.
    pub async fn stage_route_target(
        &self,
        route_username: &str,
        run_id: &str,
        vm_id: &str,
        user_id: &str,
        generation: &str,
        target_to_stage: TerminalTarget,
    ) -> Result<StageOutcome> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let mut connection = self.lock()?;
        // Dropping the transaction without a commit rolls it back.
        let transaction = connection.transaction().map_err(db)?;
        let row = transaction
            .query_row(
                r#"
                SELECT
                    route.generation,
                    route.run_id,
                    route.vm_id,
                    route.user_id,
                    target.route_username AS target_route_username,
                    target.attachment_id,
                    target.activated_at,
                    target.target_username,
                    target.target_host,
                    target.target_port,
                    target.target_host_key_openssh,
                    target.target_private_key_openssh,
                    target.authorized_client_public_keys_json
                FROM routes AS route
                LEFT JOIN terminal_route_targets AS target
                    ON target.route_username = route.route_username
                WHERE route.route_username = ?
                  AND route.expires_at > ?
                "#,
                params![route_username, now],
                |row| Ok((RouteIdentity::read(row), row_to_target(row))),
            )
            .optional()
            .map_err(db)?;

        let Some((identity, existing)) = row else {
            return Ok(StageOutcome::RouteNotFound);
        };
        if !identity?.matches(generation, run_id, vm_id, user_id) {
            return Ok(StageOutcome::IdentityMismatch);
        }
        if let Some(existing) = existing? {
            // An identical repeat returns the same attachment, so a lost
            // answer is safe to retry. Another target is a conflict, and it
            // leaves the stored target untouched.
            let same = match &existing {
                StoredTarget::Missing => false,
                StoredTarget::Staged { target, .. } | StoredTarget::Active { target, .. } => {
                    *target == target_to_stage
                }
            };
            return Ok(match (same, existing.attachment_id()) {
                (true, Some(attachment_id)) => StageOutcome::AlreadyStaged {
                    attachment_id: attachment_id.to_owned(),
                },
                _ => StageOutcome::TargetConflict,
            });
        }
        let attachment_id = new_attachment_id();
        insert_target(
            &transaction,
            route_username,
            &attachment_id,
            None,
            &target_to_stage,
            now,
        )?;
        transaction.commit().map_err(db)?;
        Ok(StageOutcome::Staged { attachment_id })
    }

    /// Activate exactly the staged attachment that the control plane named.
    /// The row must still carry that attachment and must not be active yet.
    pub async fn activate_route_target(
        &self,
        route_username: &str,
        run_id: &str,
        vm_id: &str,
        user_id: &str,
        generation: &str,
        attachment_id: &str,
    ) -> Result<ActivateOutcome> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let already_active = {
            let mut connection = self.lock()?;
            // Dropping the transaction without a commit rolls it back.
            let transaction = connection.transaction().map_err(db)?;
            let row = transaction
                .query_row(
                    r#"
                    SELECT
                        route.generation,
                        route.run_id,
                        route.vm_id,
                        route.user_id,
                        target.route_username AS target_route_username,
                        target.activated_at
                    FROM routes AS route
                    LEFT JOIN terminal_route_targets AS target
                        ON target.route_username = route.route_username
                    WHERE route.route_username = ?
                      AND route.expires_at > ?
                    "#,
                    params![route_username, now],
                    |row| {
                        Ok((
                            RouteIdentity::read(row),
                            row.get::<_, Option<String>>("target_route_username"),
                            row.get::<_, Option<i64>>("activated_at"),
                        ))
                    },
                )
                .optional()
                .map_err(db)?;

            let Some((identity, target_route_username, activated_at)) = row else {
                return Ok(ActivateOutcome::RouteNotFound);
            };
            if !identity?.matches(generation, run_id, vm_id, user_id) {
                return Ok(ActivateOutcome::IdentityMismatch);
            }
            if target_route_username.map_err(db)?.is_none() {
                return Ok(ActivateOutcome::NothingStaged);
            }
            let activated_at = activated_at.map_err(db)?;
            let updated = transaction
                .execute(
                    r#"
                    UPDATE terminal_route_targets
                    SET activated_at = ?
                    WHERE route_username = ?
                      AND attachment_id = ?
                      AND activated_at IS NULL
                    "#,
                    params![now, route_username, attachment_id],
                )
                .map_err(db)?;
            if updated > 0 {
                transaction.commit().map_err(db)?;
                return Ok(ActivateOutcome::Activated);
            }
            activated_at.is_some()
        };
        // Already active under this exact attachment is an idempotent retry of
        // an activation whose answer was lost.
        if !already_active {
            return Ok(ActivateOutcome::StaleAttachment);
        }
        let stored = self.get_route(route_username).await?;
        Ok(
            match stored
                .as_ref()
                .and_then(|route| route.target.attachment_id())
            {
                Some(stored) if stored == attachment_id => ActivateOutcome::AlreadyActive,
                _ => ActivateOutcome::StaleAttachment,
            },
        )
    }

    pub async fn delete_route(&self, route_username: &str) -> Result<bool> {
        let rows = self
            .lock()?
            .execute(
                "DELETE FROM routes WHERE route_username = ?",
                [route_username],
            )
            .map_err(db)?;
        Ok(rows > 0)
    }

    /// Delete the route only when it still carries the expected generation. A
    /// control plane that tears down run A must not delete a route that the
    /// same name was reissued to for run B. The check and the delete are one
    /// statement, so no reissue can slip between them.
    pub async fn delete_route_if_generation(
        &self,
        route_username: &str,
        generation: &str,
    ) -> Result<GenerationDeleteOutcome> {
        let connection = self.lock()?;
        let rows = connection
            .execute(
                "DELETE FROM routes WHERE route_username = ? AND generation = ?",
                [route_username, generation],
            )
            .map_err(db)?;
        if rows > 0 {
            return Ok(GenerationDeleteOutcome::Deleted);
        }
        let exists = connection
            .query_row(
                "SELECT 1 FROM routes WHERE route_username = ?",
                [route_username],
                |_| Ok(()),
            )
            .optional()
            .map_err(db)?
            .is_some();
        Ok(if exists {
            GenerationDeleteOutcome::GenerationMismatch
        } else {
            GenerationDeleteOutcome::Missing
        })
    }

    pub async fn delete_expired_routes(&self, now: OffsetDateTime) -> Result<Vec<String>> {
        let connection = self.lock()?;
        delete_expired(
            &connection,
            "SELECT route_username FROM routes WHERE expires_at <= ?",
            "DELETE FROM routes WHERE expires_at <= ?",
            now,
        )
    }

    pub async fn upsert_workspace_app_route(
        &self,
        route: RegisteredWorkspaceAppRoute,
        bootstrap_token_sha256: &str,
        bootstrap_expires_at: OffsetDateTime,
    ) -> Result<WorkspaceAppRouteRecord> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        {
            let mut connection = self.lock()?;
            // Dropping the transaction without a commit rolls it back.
            let transaction = connection.transaction().map_err(db)?;
            if !route.create_only {
                // Reissuing an existing route is an authorization rotation.
                // Invalidate every browser session before replacing bootstrap.
                transaction
                    .execute(
                        "DELETE FROM workspace_app_browser_sessions WHERE route_id = ?",
                        [&route.route_id],
                    )
                    .map_err(db)?;
            }
            macro_rules! insert_workspace_app_route_sql {
                ($conflict:literal) => {
                    concat!(
                        r#"
                INSERT INTO workspace_app_routes (
                    route_id,
                    target_username,
                    target_ip,
                    target_ssh_port,
                    target_host_key_openssh,
                    target_private_key_openssh,
                    target_app_port,
                    protocol,
                    upstream_host,
                    expires_at,
                    bootstrap_token_sha256,
                    bootstrap_expires_at,
                    host_id,
                    run_id,
                    vm_id,
                    user_id,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                "#,
                        $conflict
                    )
                };
            }
            let statement: &'static str = if route.create_only {
                insert_workspace_app_route_sql!("ON CONFLICT(route_id) DO NOTHING")
            } else {
                insert_workspace_app_route_sql!(
                    r#"ON CONFLICT(route_id) DO UPDATE SET
                    target_username = excluded.target_username,
                    target_ip = excluded.target_ip,
                    target_ssh_port = excluded.target_ssh_port,
                    target_host_key_openssh = excluded.target_host_key_openssh,
                    target_private_key_openssh = excluded.target_private_key_openssh,
                    target_app_port = excluded.target_app_port,
                    protocol = excluded.protocol,
                    upstream_host = excluded.upstream_host,
                    expires_at = excluded.expires_at,
                    bootstrap_token_sha256 = excluded.bootstrap_token_sha256,
                    bootstrap_expires_at = excluded.bootstrap_expires_at,
                    host_id = excluded.host_id,
                    run_id = excluded.run_id,
                    vm_id = excluded.vm_id,
                    user_id = excluded.user_id,
                    updated_at = excluded.updated_at"#
                )
            };
            let rows = transaction
                .execute(
                    statement,
                    params![
                        route.route_id,
                        route.target_username,
                        serde_json::to_string(&route.transport)?,
                        0_i64,
                        route.target_host_key_openssh,
                        route.target_private_key_openssh,
                        i64::from(route.target_app_port),
                        workspace_app_protocol_slug(route.protocol),
                        route.upstream_host,
                        route.expires_at.unix_timestamp(),
                        bootstrap_token_sha256,
                        bootstrap_expires_at.unix_timestamp(),
                        route.metadata.host_id,
                        route.metadata.run_id,
                        route.metadata.vm_id,
                        route.metadata.user_id,
                        now,
                        now,
                    ],
                )
                .map_err(db)?;
            if route.create_only && rows == 0 {
                return Err(StargateError::WorkspaceAppRouteAlreadyExists(
                    route.route_id,
                ));
            }
            transaction.commit().map_err(db)?;
        }

        self.get_workspace_app_route(&route.route_id)
            .await?
            .ok_or_else(|| {
                StargateError::Internal("workspace app route disappeared after upsert".to_owned())
            })
    }

    /// Atomically consumes a one-time bootstrap capability and creates the
    /// opaque browser session that replaces it. Only token digests are stored.
    pub async fn exchange_workspace_app_bootstrap(
        &self,
        route_id: &str,
        bootstrap_token_sha256: &str,
        browser_session_token_sha256: &str,
        requested_session_expires_at: OffsetDateTime,
    ) -> Result<Option<OffsetDateTime>> {
        let now = OffsetDateTime::now_utc();
        let mut connection = self.lock()?;
        // Dropping the transaction without a commit rolls it back.
        let transaction = connection.transaction().map_err(db)?;
        let route_expires_at = transaction
            .query_row(
                r#"
                UPDATE workspace_app_routes
                SET bootstrap_token_sha256 = NULL,
                    bootstrap_expires_at = NULL
                WHERE route_id = ?
                  AND bootstrap_token_sha256 = ?
                  AND bootstrap_expires_at > ?
                  AND expires_at > ?
                RETURNING expires_at
                "#,
                params![
                    route_id,
                    bootstrap_token_sha256,
                    now.unix_timestamp(),
                    now.unix_timestamp()
                ],
                |row| row.get::<_, i64>("expires_at"),
            )
            .optional()
            .map_err(db)?;
        let Some(route_expires_at) = route_expires_at else {
            return Ok(None);
        };
        let route_expires_at = parse_timestamp(route_expires_at)?;
        let expires_at = requested_session_expires_at.min(route_expires_at);
        if expires_at <= now {
            return Ok(None);
        }
        transaction
            .execute(
                r#"
                INSERT INTO workspace_app_browser_sessions (
                    route_id,
                    token_sha256,
                    expires_at,
                    created_at
                )
                VALUES (?, ?, ?, ?)
                "#,
                params![
                    route_id,
                    browser_session_token_sha256,
                    expires_at.unix_timestamp(),
                    now.unix_timestamp()
                ],
            )
            .map_err(db)?;
        transaction.commit().map_err(db)?;
        Ok(Some(expires_at))
    }

    /// Loads a route only when the presented opaque browser session is bound
    /// to that exact route and both records are still live.
    pub async fn get_authorized_workspace_app_route(
        &self,
        route_id: &str,
        browser_session_token_sha256: &str,
    ) -> Result<Option<(WorkspaceAppRouteRecord, OffsetDateTime)>> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        self.lock()?
            .query_row(
                r#"
                SELECT
                    route.route_id,
                    route.target_username,
                    route.target_ip,
                    route.target_ssh_port,
                    route.target_host_key_openssh,
                    route.target_private_key_openssh,
                    route.target_app_port,
                    route.protocol,
                    route.upstream_host,
                    route.expires_at,
                    route.host_id,
                    route.run_id,
                    route.vm_id,
                    route.user_id,
                    route.created_at,
                    route.updated_at,
                    browser.expires_at AS browser_expires_at
                FROM workspace_app_routes AS route
                INNER JOIN workspace_app_browser_sessions AS browser
                    ON browser.route_id = route.route_id
                WHERE route.route_id = ?
                  AND browser.token_sha256 = ?
                  AND route.expires_at > ?
                  AND browser.expires_at > ?
                "#,
                params![route_id, browser_session_token_sha256, now, now],
                |row| {
                    Ok((|| {
                        let browser_expires_at =
                            parse_timestamp(row.get("browser_expires_at").map_err(db)?)?;
                        Ok((row_to_workspace_app_route(row)?, browser_expires_at))
                    })())
                },
            )
            .optional()
            .map_err(db)?
            .transpose()
    }

    pub async fn delete_expired_workspace_app_browser_sessions(
        &self,
        now: OffsetDateTime,
    ) -> Result<u64> {
        let rows = self
            .lock()?
            .execute(
                "DELETE FROM workspace_app_browser_sessions WHERE expires_at <= ?",
                [now.unix_timestamp()],
            )
            .map_err(db)?;
        Ok(rows as u64)
    }

    pub async fn get_workspace_app_route(
        &self,
        route_id: &str,
    ) -> Result<Option<WorkspaceAppRouteRecord>> {
        self.lock()?
            .query_row(
                r#"
                SELECT
                    route_id,
                    target_username,
                    target_ip,
                    target_ssh_port,
                    target_host_key_openssh,
                    target_private_key_openssh,
                    target_app_port,
                    protocol,
                    upstream_host,
                    expires_at,
                    host_id,
                    run_id,
                    vm_id,
                    user_id,
                    created_at,
                    updated_at
                FROM workspace_app_routes
                WHERE route_id = ?
                  AND expires_at > ?
                "#,
                params![route_id, OffsetDateTime::now_utc().unix_timestamp()],
                |row| Ok(row_to_workspace_app_route(row)),
            )
            .optional()
            .map_err(db)?
            .transpose()
    }

    pub async fn delete_workspace_app_route(&self, route_id: &str) -> Result<bool> {
        let rows = self
            .lock()?
            .execute(
                "DELETE FROM workspace_app_routes WHERE route_id = ?",
                [route_id],
            )
            .map_err(db)?;
        Ok(rows > 0)
    }

    /// Every run mirror as `(run_id, share_id, write_token)`.
    pub(crate) async fn list_run_mirrors(&self) -> Result<Vec<(String, String, String)>> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT run_id, share_id, write_token FROM run_mirrors")
            .map_err(db)?;
        let mirrors = statement
            .query_map([], |row| {
                Ok((
                    row.get("run_id")?,
                    row.get("share_id")?,
                    row.get("write_token")?,
                ))
            })
            .map_err(db)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db)?;
        Ok(mirrors)
    }

    /// Store the run's mirror unless the run streams to another share that
    /// was claimed later. Returns false, and changes nothing, in that case. A
    /// repeat of the stored share and token always succeeds and keeps the
    /// newer claim.
    pub(crate) async fn upsert_run_mirror(
        &self,
        run_id: &str,
        share_id: &str,
        write_token: &str,
        claimed_at_ms: i64,
    ) -> Result<bool> {
        let rows = self
            .lock()?
            .execute(
                r#"
                INSERT INTO run_mirrors (run_id, share_id, write_token, claimed_at_ms, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                    share_id = excluded.share_id,
                    write_token = excluded.write_token,
                    claimed_at_ms = MAX(run_mirrors.claimed_at_ms, excluded.claimed_at_ms),
                    updated_at = excluded.updated_at
                WHERE excluded.claimed_at_ms >= run_mirrors.claimed_at_ms
                   OR (excluded.share_id = run_mirrors.share_id
                       AND excluded.write_token = run_mirrors.write_token)
                "#,
                params![
                    run_id,
                    share_id,
                    write_token,
                    claimed_at_ms,
                    OffsetDateTime::now_utc().unix_timestamp()
                ],
            )
            .map_err(db)?;
        Ok(rows > 0)
    }

    /// Delete the run's mirror only while it still streams to `share_id`, so
    /// stopping an old share can not stop the share that replaced it. Returns
    /// false, and deletes nothing, when the run streams to another share.
    pub(crate) async fn delete_run_mirror(&self, run_id: &str, share_id: &str) -> Result<bool> {
        let connection = self.lock()?;
        let rows = connection
            .execute(
                "DELETE FROM run_mirrors WHERE run_id = ? AND share_id = ?",
                [run_id, share_id],
            )
            .map_err(db)?;
        if rows > 0 {
            return Ok(true);
        }
        let other_share = connection
            .query_row(
                "SELECT 1 FROM run_mirrors WHERE run_id = ?",
                [run_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(db)?
            .is_some();
        Ok(!other_share)
    }

    pub async fn delete_expired_workspace_app_routes(
        &self,
        now: OffsetDateTime,
    ) -> Result<Vec<String>> {
        let connection = self.lock()?;
        delete_expired(
            &connection,
            "SELECT route_id FROM workspace_app_routes WHERE expires_at <= ?",
            "DELETE FROM workspace_app_routes WHERE expires_at <= ?",
            now,
        )
    }
}

/// The result of one stage call. Each variant maps to exactly one HTTP status,
/// so the endpoint holds no decision of its own.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StageOutcome {
    Staged {
        attachment_id: String,
    },
    /// The same target is already staged under this attachment.
    AlreadyStaged {
        attachment_id: String,
    },
    TargetConflict,
    IdentityMismatch,
    RouteNotFound,
}

/// The result of one activation call.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActivateOutcome {
    Activated,
    /// The same attachment is already active, so the retry is idempotent.
    AlreadyActive,
    /// The named attachment is not the staged one, so nothing was activated.
    StaleAttachment,
    NothingStaged,
    IdentityMismatch,
    RouteNotFound,
}

/// The result of a generation-fenced delete. Only `Deleted` cancels sessions.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GenerationDeleteOutcome {
    Deleted,
    GenerationMismatch,
    Missing,
}

/// Bring a database to the newest schema version in one transaction. A fresh
/// file gets the baseline; a file that stargate 0.6's sqlx migrator brought to
/// migration 6 is adopted as the baseline as it stands. Anything else, such as a
/// partly migrated file, refuses to start rather than guess.
fn migrate(connection: &mut Connection) -> Result<()> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db)?;
    let mut version = transaction
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(db)
        .and_then(|version| {
            usize::try_from(version)
                .map_err(|_| StargateError::Database(format!("invalid schema version {version}")))
        })?;
    if version == 0 && adopt_sqlx_database(&transaction)? {
        version = 1;
    }
    if version > MIGRATIONS.len() {
        return Err(StargateError::Database(format!(
            "the route database is at schema version {version}, newer than this gateway's {}",
            MIGRATIONS.len()
        )));
    }
    for migration in &MIGRATIONS[version..] {
        transaction.execute_batch(migration).map_err(db)?;
    }
    transaction
        .pragma_update(None, "user_version", MIGRATIONS.len() as i64)
        .map_err(db)?;
    transaction.commit().map_err(db)
}

/// Returns true when the file holds stargate 0.6's sqlx-migrated schema, which
/// is the baseline. Returns false for an empty file. The sqlx bookkeeping
/// stays: a deploy script that still checks it, and a stargate 0.6 restored by
/// a failed apply, both read it, and with all six rows present 0.6 migrates
/// nothing.
fn adopt_sqlx_database(transaction: &Transaction<'_>) -> Result<bool> {
    let objects: Vec<String> = {
        let mut statement = transaction
            .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
            .map_err(db)?;
        statement
            .query_map([], |row| row.get(0))
            .map_err(db)?
            .collect::<rusqlite::Result<_>>()
            .map_err(db)?
    };
    if objects.is_empty() {
        return Ok(false);
    }
    if !objects.iter().any(|name| name == "_sqlx_migrations") {
        return Err(StargateError::Database(
            "the route database has tables but no schema version".to_owned(),
        ));
    }
    let applied: Vec<(i64, String, bool)> = {
        let mut statement = transaction
            .prepare("SELECT version, description, success FROM _sqlx_migrations ORDER BY version")
            .map_err(db)?;
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(db)?
            .collect::<rusqlite::Result<_>>()
            .map_err(db)?
    };
    let expected = SQLX_MIGRATIONS
        .iter()
        .map(|(version, description)| (*version, (*description).to_owned(), true))
        .collect::<Vec<_>>();
    if applied != expected {
        return Err(StargateError::Database(
            "the route database is not at stargate 0.6's last sqlx migration; \
             run stargate 0.6 against it once before upgrading"
                .to_owned(),
        ));
    }
    Ok(true)
}

/// A route's identity columns, as the stage and activate calls compare them.
struct RouteIdentity {
    generation: String,
    run_id: Option<String>,
    vm_id: Option<String>,
    user_id: Option<String>,
}

impl RouteIdentity {
    fn read(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            generation: row.get("generation").map_err(db)?,
            run_id: row.get("run_id").map_err(db)?,
            vm_id: row.get("vm_id").map_err(db)?,
            user_id: row.get("user_id").map_err(db)?,
        })
    }

    fn matches(&self, generation: &str, run_id: &str, vm_id: &str, user_id: &str) -> bool {
        self.generation == generation
            && self.run_id.as_deref() == Some(run_id)
            && self.vm_id.as_deref() == Some(vm_id)
            && self.user_id.as_deref() == Some(user_id)
    }
}

/// Writes one target row. A target with `activated_at` is active; one without
/// it is staged.
fn insert_target(
    transaction: &Transaction<'_>,
    route_username: &str,
    attachment_id: &str,
    activated_at: Option<i64>,
    target: &TerminalTarget,
    now: i64,
) -> Result<()> {
    transaction
        .execute(
            r#"
            INSERT INTO terminal_route_targets (
                route_username,
                attachment_id,
                activated_at,
                target_username,
                target_host,
                target_port,
                target_host_key_openssh,
                target_private_key_openssh,
                authorized_client_public_keys_json,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            params![
                route_username,
                attachment_id,
                activated_at,
                target.username,
                serde_json::to_string(&target.transport)?,
                0_i64,
                target.host_key_openssh,
                target.private_key_openssh,
                authorized_client_public_keys_json(target)?,
                now,
            ],
        )
        .map_err(db)?;
    Ok(())
}

/// Deletes the rows that `select` names and returns their keys.
fn delete_expired(
    connection: &Connection,
    select: &str,
    delete: &str,
    now: OffsetDateTime,
) -> Result<Vec<String>> {
    let keys = connection
        .prepare(select)
        .map_err(db)?
        .query_map([now.unix_timestamp()], |row| row.get(0))
        .map_err(db)?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(db)?;
    if !keys.is_empty() {
        connection
            .execute(delete, [now.unix_timestamp()])
            .map_err(db)?;
    }
    Ok(keys)
}

fn row_to_route(row: &Row<'_>) -> Result<StoredTerminalRoute> {
    let parse_time = |column: &str| parse_timestamp(row.get(column).map_err(db)?);
    let mode = match row.get::<_, String>("mode").map_err(db)?.as_str() {
        "browser" => TerminalSessionMode::Browser,
        "native" => TerminalSessionMode::Native,
        value => {
            return Err(StargateError::Internal(format!(
                "unsupported terminal session mode {value:?}"
            )));
        }
    };
    Ok(StoredTerminalRoute {
        route_username: row.get("route_username").map_err(db)?,
        generation: row.get("generation").map_err(db)?,
        expires_at: parse_time("expires_at")?,
        mode,
        metadata: RouteMetadata {
            host_id: row.get("host_id").map_err(db)?,
            run_id: row.get("run_id").map_err(db)?,
            vm_id: row.get("vm_id").map_err(db)?,
            user_id: row.get("user_id").map_err(db)?,
        },
        target: row_to_target(row)?.unwrap_or(StoredTarget::Missing),
        created_at: parse_time("created_at")?,
        updated_at: parse_time("updated_at")?,
    })
}

/// The target row, as the stored state. A row that carries `activated_at` is
/// active; a row without it is staged and never reaches a dial path.
// The existing TEXT endpoint columns hold the tagged transport JSON. The old
// numeric port columns are inert (zero). Old untagged endpoints fail closed.
fn row_to_target(row: &Row<'_>) -> Result<Option<StoredTarget>> {
    let Some(route_username) = row
        .get::<_, Option<String>>("target_route_username")
        .map_err(db)?
    else {
        return Ok(None);
    };
    if route_username.is_empty() {
        return Ok(None);
    }
    let target = TerminalTarget {
        username: row.get("target_username").map_err(db)?,
        transport: serde_json::from_str(&row.get::<_, String>("target_host").map_err(db)?)?,
        host_key_openssh: row.get("target_host_key_openssh").map_err(db)?,
        private_key_openssh: row.get("target_private_key_openssh").map_err(db)?,
        authorized_client_public_keys_openssh: authorized_client_public_keys_from_row(row)?,
    };
    let attachment_id = row
        .get::<_, Option<String>>("attachment_id")
        .map_err(db)?
        .ok_or_else(|| StargateError::Internal("target row has no attachment_id".to_owned()))?;
    let activated_at = row.get::<_, Option<i64>>("activated_at").map_err(db)?;
    Ok(Some(if activated_at.is_some() {
        StoredTarget::Active {
            attachment_id,
            target,
        }
    } else {
        StoredTarget::Staged {
            attachment_id,
            target,
        }
    }))
}

fn row_to_workspace_app_route(row: &Row<'_>) -> Result<WorkspaceAppRouteRecord> {
    let parse_time = |column: &str| parse_timestamp(row.get(column).map_err(db)?);
    let parse_port = |column: &str| {
        u16::try_from(row.get::<_, i64>(column).map_err(db)?)
            .map_err(|_| StargateError::Internal(format!("{column} overflowed")))
    };
    let protocol = match row.get::<_, String>("protocol").map_err(db)?.as_str() {
        "http" => WorkspaceAppProtocol::Http,
        value => {
            return Err(StargateError::Internal(format!(
                "unsupported workspace app protocol {value:?}"
            )));
        }
    };
    Ok(WorkspaceAppRouteRecord {
        route_id: row.get("route_id").map_err(db)?,
        target_username: row.get("target_username").map_err(db)?,
        transport: serde_json::from_str(&row.get::<_, String>("target_ip").map_err(db)?)?,
        target_host_key_openssh: row.get("target_host_key_openssh").map_err(db)?,
        target_private_key_openssh: row.get("target_private_key_openssh").map_err(db)?,
        target_app_port: parse_port("target_app_port")?,
        protocol,
        upstream_host: row.get("upstream_host").map_err(db)?,
        expires_at: parse_time("expires_at")?,
        metadata: WorkspaceAppMetadata {
            host_id: row.get("host_id").map_err(db)?,
            run_id: row.get("run_id").map_err(db)?,
            vm_id: row.get("vm_id").map_err(db)?,
            user_id: row.get("user_id").map_err(db)?,
        },
        created_at: parse_time("created_at")?,
        updated_at: parse_time("updated_at")?,
    })
}

fn parse_timestamp(seconds: i64) -> Result<OffsetDateTime> {
    OffsetDateTime::from_unix_timestamp(seconds)
        .map_err(|error| StargateError::Internal(error.to_string()))
}

fn terminal_mode_slug(mode: TerminalSessionMode) -> &'static str {
    match mode {
        TerminalSessionMode::Browser => "browser",
        TerminalSessionMode::Native => "native",
    }
}

fn workspace_app_protocol_slug(protocol: WorkspaceAppProtocol) -> &'static str {
    match protocol {
        WorkspaceAppProtocol::Http => "http",
    }
}

fn db(error: rusqlite::Error) -> StargateError {
    StargateError::Database(error.to_string())
}

fn authorized_client_public_keys_json(target: &TerminalTarget) -> Result<String> {
    json_to_string(&target.authorized_client_public_keys_openssh)
        .map_err(|error| StargateError::Internal(error.to_string()))
}

fn authorized_client_public_keys_from_row(row: &Row<'_>) -> Result<Vec<String>> {
    let raw = row
        .get::<_, String>("authorized_client_public_keys_json")
        .map_err(db)?;
    json_from_str(&raw).map_err(|error| StargateError::Internal(error.to_string()))
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params};

    use super::{SQLX_MIGRATIONS, SqliteRouteStore};

    /// The six migrations stargate 0.6 ran through sqlx, kept to build the
    /// databases that production already holds.
    const SQLX_MIGRATION_SQL: [&str; 6] = [
        include_str!("../tests/fixtures/sqlx-migrations/0001_routes.sql"),
        include_str!("../tests/fixtures/sqlx-migrations/0002_workspace_app_routes.sql"),
        include_str!("../tests/fixtures/sqlx-migrations/0003_workspace_app_browser_sessions.sql"),
        include_str!("../tests/fixtures/sqlx-migrations/0004_workspace_app_upstream_host.sql"),
        include_str!("../tests/fixtures/sqlx-migrations/0005_terminal_route_targets.sql"),
        include_str!("../tests/fixtures/sqlx-migrations/0006_run_mirrors.sql"),
    ];

    /// Builds a database the way stargate 0.6 left it: the sqlx migrations up to
    /// `through`, and their bookkeeping rows.
    fn sqlx_database(path: &std::path::Path, through: usize) -> anyhow::Result<Connection> {
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "CREATE TABLE _sqlx_migrations (\
             version BIGINT PRIMARY KEY, description TEXT NOT NULL, \
             installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \
             success BOOLEAN NOT NULL, checksum BLOB NOT NULL, \
             execution_time BIGINT NOT NULL);",
        )?;
        for (sql, (version, description)) in
            SQLX_MIGRATION_SQL.iter().zip(SQLX_MIGRATIONS).take(through)
        {
            connection.execute_batch(sql)?;
            connection.execute(
                "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
                 VALUES (?, ?, TRUE, x'00', 0)",
                params![version, description],
            )?;
        }
        Ok(connection)
    }

    /// Every table's columns and every index, as SQLite reports them.
    fn schema(path: &std::path::Path) -> anyhow::Result<Vec<String>> {
        let connection = Connection::open(path)?;
        let mut statement = connection.prepare(
            "SELECT object.type || ' ' || object.name || ' ' || coalesce(column.name, '') || ' ' || \
             coalesce(column.type, '') || ' ' || coalesce(column.\"notnull\", '') || ' ' || \
             coalesce(column.dflt_value, '') || ' ' || coalesce(column.pk, '') || ' ' || \
             CASE WHEN object.type = 'index' THEN coalesce(object.sql, '') ELSE '' END \
             FROM sqlite_master AS object \
             LEFT JOIN pragma_table_info(object.name) AS column ON object.type = 'table' \
             WHERE object.name NOT LIKE 'sqlite_%' \
             ORDER BY object.name, column.cid",
        )?;
        let rows = statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    }

    fn foreign_keys(path: &std::path::Path) -> anyhow::Result<Vec<String>> {
        let connection = Connection::open(path)?;
        let mut statement = connection.prepare(
            "SELECT object.name || ' ' || key.\"from\" || ' ' || key.\"table\" || ' ' || \
             key.\"to\" || ' ' || key.on_delete \
             FROM sqlite_master AS object, pragma_foreign_key_list(object.name) AS key \
             WHERE object.type = 'table' ORDER BY object.name, key.id",
        )?;
        let rows = statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    }

    /// A database stargate 0.6 migrated is adopted as it stands, keeps its
    /// rows, and ends with exactly the schema a fresh database gets.
    #[tokio::test]
    async fn adopts_a_stargate_0_6_database_as_the_baseline() -> anyhow::Result<()> {
        let temp_dir = tempfile::tempdir()?;
        let adopted = temp_dir.path().join("adopted.db");
        let connection = sqlx_database(&adopted, 6)?;
        connection.execute(
            "INSERT INTO run_mirrors (run_id, share_id, write_token, claimed_at_ms, updated_at) \
             VALUES ('run-01', 'share-01', 'token-01', 1, 1)",
            [],
        )?;
        drop(connection);

        let store = SqliteRouteStore::connect(&adopted).await?;
        assert_eq!(
            store.list_run_mirrors().await?,
            vec![(
                "run-01".to_owned(),
                "share-01".to_owned(),
                "token-01".to_owned()
            )]
        );
        drop(store);

        let fresh = temp_dir.path().join("fresh.db");
        drop(SqliteRouteStore::connect(&fresh).await?);
        let without_sqlx = |rows: Vec<String>| {
            rows.into_iter()
                .filter(|row| !row.contains("_sqlx_migrations"))
                .collect::<Vec<_>>()
        };
        assert_eq!(without_sqlx(schema(&adopted)?), schema(&fresh)?);
        assert_eq!(foreign_keys(&adopted)?, foreign_keys(&fresh)?);
        let version: i64 =
            Connection::open(&adopted)?
                .pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(version, 1);
        // The sqlx bookkeeping survives, so stargate 0.6 and older deploy
        // scripts still find all six migrations applied.
        let sqlx_rows: i64 = Connection::open(&adopted)?.query_row(
            "SELECT count(*) FROM _sqlx_migrations WHERE success = 1",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(sqlx_rows, 6);

        // A second start is a no-op.
        let store = SqliteRouteStore::connect(&adopted).await?;
        assert_eq!(store.list_run_mirrors().await?.len(), 1);
        Ok(())
    }

    /// A database that never finished stargate 0.6's migrations is not guessed
    /// at: the gateway refuses to start and leaves the file untouched.
    #[tokio::test]
    async fn refuses_a_partly_migrated_database() -> anyhow::Result<()> {
        let temp_dir = tempfile::tempdir()?;
        let path = temp_dir.path().join("partial.db");
        drop(sqlx_database(&path, 5)?);
        let before = schema(&path)?;

        assert!(SqliteRouteStore::connect(&path).await.is_err());
        assert_eq!(schema(&path)?, before);
        Ok(())
    }

    /// The baseline serves a new pending route end to end.
    #[tokio::test]
    async fn a_fresh_database_serves_a_pending_route() -> anyhow::Result<()> {
        let temp_dir = tempfile::tempdir()?;
        let store = SqliteRouteStore::connect(temp_dir.path().join("stargate.db")).await?;
        let now = time::OffsetDateTime::now_utc();
        let stored = store
            .upsert_route(stargate_core::StoredTerminalRoute {
                route_username: "run-02-web".to_owned(),
                generation: "exec-02:1".to_owned(),
                expires_at: now + time::Duration::hours(1),
                mode: stargate_core::TerminalSessionMode::Browser,
                metadata: stargate_core::RouteMetadata {
                    host_id: "host-01".to_owned(),
                    run_id: "run-02".to_owned(),
                    vm_id: "vm-01".to_owned(),
                    user_id: "user-01".to_owned(),
                },
                target: stargate_core::StoredTarget::Missing,
                created_at: now,
                updated_at: now,
            })
            .await?;
        assert!(stored.ready_target().is_none());
        Ok(())
    }
}
