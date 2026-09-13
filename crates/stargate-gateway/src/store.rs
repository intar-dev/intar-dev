use std::path::Path;

use serde_json::{from_str as json_from_str, to_string as json_to_string};
use sqlx::{
    Row, SqlitePool, migrate::Migrator, sqlite::SqliteConnectOptions, sqlite::SqlitePoolOptions,
};
use stargate_core::{
    RegisteredWorkspaceAppRoute, Result, RouteMetadata, StargateError, StoredTarget,
    StoredTerminalRoute, TerminalSessionMode, TerminalTarget, WorkspaceAppMetadata,
    WorkspaceAppProtocol, WorkspaceAppRouteRecord, new_attachment_id,
};
use time::OffsetDateTime;

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

#[derive(Clone)]
pub struct SqliteRouteStore {
    pool: SqlitePool,
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

        let options = SqliteConnectOptions::new()
            .filename(path)
            // The stage and activate calls read, then write, inside one
            // transaction. A deferred transaction takes its write lock at the
            // first write, so a second writer must wait for the first rather
            // than fail with SQLITE_BUSY. The gateway guards the write path
            // with one in-process mutex, and this timeout is the backstop if a
            // second process ever shares the file.
            .busy_timeout(std::time::Duration::from_secs(5))
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(10)
            .connect_with(options)
            .await
            .map_err(sqlx_error)?;

        MIGRATOR
            .run(&pool)
            .await
            .map_err(|error| StargateError::Database(error.to_string()))?;

        Ok(Self { pool })
    }

    pub async fn healthcheck(&self) -> Result<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map_err(sqlx_error)?;
        Ok(())
    }

    /// Create or replace one terminal route. A replacement writes the route
    /// first, then clears any target that the previous record held, so a reissue
    /// can not inherit the target of the generation it replaced. A create call
    /// that carries an active target (the native route) writes it back at once.
    pub async fn upsert_route(&self, route: StoredTerminalRoute) -> Result<StoredTerminalRoute> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let mut transaction = self.pool.begin().await.map_err(sqlx_error)?;
        sqlx::query(
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
        )
        .bind(&route.route_username)
        .bind(&route.generation)
        .bind(terminal_mode_slug(route.mode))
        .bind(route.expires_at.unix_timestamp())
        .bind(&route.metadata.host_id)
        .bind(&route.metadata.run_id)
        .bind(&route.metadata.vm_id)
        .bind(&route.metadata.user_id)
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(sqlx_error)?;

        sqlx::query("DELETE FROM terminal_route_targets WHERE route_username = ?")
            .bind(&route.route_username)
            .execute(&mut *transaction)
            .await
            .map_err(sqlx_error)?;
        // A create call can carry an active target, which is how a native
        // route is born ready. A browser route is created with no target, so
        // the row that the delete above removed stays removed.
        if let StoredTarget::Active {
            attachment_id,
            target,
        } = &route.target
        {
            sqlx::query(
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
            )
            .bind(&route.route_username)
            .bind(attachment_id)
            .bind(now)
            .bind(&target.username)
            .bind(&target.host)
            .bind(i64::from(target.port))
            .bind(&target.host_key_openssh)
            .bind(&target.private_key_openssh)
            .bind(authorized_client_public_keys_json(target)?)
            .bind(now)
            .execute(&mut *transaction)
            .await
            .map_err(sqlx_error)?;
        }
        transaction.commit().await.map_err(sqlx_error)?;

        self.get_route(&route.route_username).await?.ok_or_else(|| {
            StargateError::Internal("terminal route disappeared after upsert".to_owned())
        })
    }

    pub async fn get_route(&self, route_username: &str) -> Result<Option<StoredTerminalRoute>> {
        self.load_route(
            route_username,
            Some(OffsetDateTime::now_utc().unix_timestamp()),
        )
        .await
    }

    pub(crate) async fn get_route_for_rotation(
        &self,
        route_username: &str,
    ) -> Result<RouteRotationPrevious> {
        match self.load_route(route_username, None).await {
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

    async fn load_route(
        &self,
        route_username: &str,
        live_after: Option<i64>,
    ) -> Result<Option<StoredTerminalRoute>> {
        let statement: &str = if live_after.is_some() {
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
            WHERE route.route_username = ?
              AND route.expires_at > ?
            "#
        } else {
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
            WHERE route.route_username = ?
            "#
        };
        let mut query = sqlx::query(statement).bind(route_username);
        if let Some(live_after) = live_after {
            query = query.bind(live_after);
        }
        let row = query.fetch_optional(&self.pool).await.map_err(sqlx_error)?;

        row.map(row_to_route).transpose()
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
        let mut transaction = self.pool.begin().await.map_err(sqlx_error)?;
        let row = sqlx::query(
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
        )
        .bind(route_username)
        .bind(now)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(sqlx_error)?;

        let Some(row) = row else {
            transaction.rollback().await.map_err(sqlx_error)?;
            return Ok(StageOutcome::RouteNotFound);
        };
        if row.get::<String, _>("generation") != generation
            || row.get::<Option<String>, _>("run_id").as_deref() != Some(run_id)
            || row.get::<Option<String>, _>("vm_id").as_deref() != Some(vm_id)
            || row.get::<Option<String>, _>("user_id").as_deref() != Some(user_id)
        {
            transaction.rollback().await.map_err(sqlx_error)?;
            return Ok(StageOutcome::IdentityMismatch);
        }
        if let Some(existing) = row_to_target(&row)? {
            transaction.rollback().await.map_err(sqlx_error)?;
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
        sqlx::query(
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
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(route_username)
        .bind(&attachment_id)
        .bind(&target_to_stage.username)
        .bind(&target_to_stage.host)
        .bind(i64::from(target_to_stage.port))
        .bind(&target_to_stage.host_key_openssh)
        .bind(&target_to_stage.private_key_openssh)
        .bind(authorized_client_public_keys_json(&target_to_stage)?)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(sqlx_error)?;
        transaction.commit().await.map_err(sqlx_error)?;
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
        let mut transaction = self.pool.begin().await.map_err(sqlx_error)?;
        let row = sqlx::query(
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
        )
        .bind(route_username)
        .bind(now)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(sqlx_error)?;

        let Some(row) = row else {
            transaction.rollback().await.map_err(sqlx_error)?;
            return Ok(ActivateOutcome::RouteNotFound);
        };
        if row.get::<String, _>("generation") != generation
            || row.get::<Option<String>, _>("run_id").as_deref() != Some(run_id)
            || row.get::<Option<String>, _>("vm_id").as_deref() != Some(vm_id)
            || row.get::<Option<String>, _>("user_id").as_deref() != Some(user_id)
        {
            transaction.rollback().await.map_err(sqlx_error)?;
            return Ok(ActivateOutcome::IdentityMismatch);
        }
        if row
            .get::<Option<String>, _>("target_route_username")
            .is_none()
        {
            transaction.rollback().await.map_err(sqlx_error)?;
            return Ok(ActivateOutcome::NothingStaged);
        }
        let activated_at = row.get::<Option<i64>, _>("activated_at");
        let updated = sqlx::query(
            r#"
            UPDATE terminal_route_targets
            SET activated_at = ?
            WHERE route_username = ?
              AND attachment_id = ?
              AND activated_at IS NULL
            "#,
        )
        .bind(now)
        .bind(route_username)
        .bind(attachment_id)
        .execute(&mut *transaction)
        .await
        .map_err(sqlx_error)?
        .rows_affected();
        if updated == 0 {
            transaction.rollback().await.map_err(sqlx_error)?;
            // Already active under this exact attachment is an idempotent
            // retry of an activation whose answer was lost.
            if activated_at.is_some() {
                let stored = self.get_route(route_username).await?;
                return Ok(
                    match stored
                        .as_ref()
                        .and_then(|route| route.target.attachment_id())
                    {
                        Some(stored) if stored == attachment_id => ActivateOutcome::AlreadyActive,
                        _ => ActivateOutcome::StaleAttachment,
                    },
                );
            }
            return Ok(ActivateOutcome::StaleAttachment);
        }
        transaction.commit().await.map_err(sqlx_error)?;
        Ok(ActivateOutcome::Activated)
    }

    pub async fn delete_route(&self, route_username: &str) -> Result<bool> {
        let rows = sqlx::query("DELETE FROM routes WHERE route_username = ?")
            .bind(route_username)
            .execute(&self.pool)
            .await
            .map_err(sqlx_error)?
            .rows_affected();
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
        let rows = sqlx::query("DELETE FROM routes WHERE route_username = ? AND generation = ?")
            .bind(route_username)
            .bind(generation)
            .execute(&self.pool)
            .await
            .map_err(sqlx_error)?
            .rows_affected();
        if rows > 0 {
            return Ok(GenerationDeleteOutcome::Deleted);
        }
        let exists = sqlx::query("SELECT 1 FROM routes WHERE route_username = ?")
            .bind(route_username)
            .fetch_optional(&self.pool)
            .await
            .map_err(sqlx_error)?
            .is_some();
        Ok(if exists {
            GenerationDeleteOutcome::GenerationMismatch
        } else {
            GenerationDeleteOutcome::Missing
        })
    }

    pub async fn delete_expired_routes(&self, now: OffsetDateTime) -> Result<Vec<String>> {
        let usernames = sqlx::query(
            r#"
            SELECT route_username
            FROM routes
            WHERE expires_at <= ?
            "#,
        )
        .bind(now.unix_timestamp())
        .fetch_all(&self.pool)
        .await
        .map_err(sqlx_error)?
        .into_iter()
        .map(|row| row.get::<String, _>("route_username"))
        .collect::<Vec<_>>();

        if usernames.is_empty() {
            return Ok(Vec::new());
        }

        sqlx::query("DELETE FROM routes WHERE expires_at <= ?")
            .bind(now.unix_timestamp())
            .execute(&self.pool)
            .await
            .map_err(sqlx_error)?;

        Ok(usernames)
    }

    pub async fn upsert_workspace_app_route(
        &self,
        route: RegisteredWorkspaceAppRoute,
        bootstrap_token_sha256: &str,
        bootstrap_expires_at: OffsetDateTime,
    ) -> Result<WorkspaceAppRouteRecord> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let mut transaction = self.pool.begin().await.map_err(sqlx_error)?;
        if !route.create_only {
            // Reissuing an existing route is an authorization rotation.
            // Invalidate every browser session before replacing bootstrap.
            sqlx::query("DELETE FROM workspace_app_browser_sessions WHERE route_id = ?")
                .bind(&route.route_id)
                .execute(&mut *transaction)
                .await
                .map_err(sqlx_error)?;
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
        let result = sqlx::query(statement)
            .bind(&route.route_id)
            .bind(&route.target_username)
            .bind(&route.target_ip)
            .bind(i64::from(route.target_ssh_port))
            .bind(&route.target_host_key_openssh)
            .bind(&route.target_private_key_openssh)
            .bind(i64::from(route.target_app_port))
            .bind(workspace_app_protocol_slug(route.protocol))
            .bind(route.upstream_host.as_deref())
            .bind(route.expires_at.unix_timestamp())
            .bind(bootstrap_token_sha256)
            .bind(bootstrap_expires_at.unix_timestamp())
            .bind(route.metadata.host_id.as_deref())
            .bind(route.metadata.run_id.as_deref())
            .bind(route.metadata.vm_id.as_deref())
            .bind(route.metadata.user_id.as_deref())
            .bind(now)
            .bind(now)
            .execute(&mut *transaction)
            .await
            .map_err(sqlx_error)?;
        if route.create_only && result.rows_affected() == 0 {
            transaction.rollback().await.map_err(sqlx_error)?;
            return Err(StargateError::WorkspaceAppRouteAlreadyExists(
                route.route_id,
            ));
        }
        transaction.commit().await.map_err(sqlx_error)?;

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
        let mut transaction = self.pool.begin().await.map_err(sqlx_error)?;
        let route = sqlx::query(
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
        )
        .bind(route_id)
        .bind(bootstrap_token_sha256)
        .bind(now.unix_timestamp())
        .bind(now.unix_timestamp())
        .fetch_optional(&mut *transaction)
        .await
        .map_err(sqlx_error)?;
        let Some(route) = route else {
            transaction.rollback().await.map_err(sqlx_error)?;
            return Ok(None);
        };
        let route_expires_at =
            OffsetDateTime::from_unix_timestamp(route.get::<i64, _>("expires_at"))
                .map_err(|error| StargateError::Internal(error.to_string()))?;
        let expires_at = requested_session_expires_at.min(route_expires_at);
        if expires_at <= now {
            transaction.rollback().await.map_err(sqlx_error)?;
            return Ok(None);
        }
        sqlx::query(
            r#"
            INSERT INTO workspace_app_browser_sessions (
                route_id,
                token_sha256,
                expires_at,
                created_at
            )
            VALUES (?, ?, ?, ?)
            "#,
        )
        .bind(route_id)
        .bind(browser_session_token_sha256)
        .bind(expires_at.unix_timestamp())
        .bind(now.unix_timestamp())
        .execute(&mut *transaction)
        .await
        .map_err(sqlx_error)?;
        transaction.commit().await.map_err(sqlx_error)?;
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
        let row = sqlx::query(
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
        )
        .bind(route_id)
        .bind(browser_session_token_sha256)
        .bind(now)
        .bind(now)
        .fetch_optional(&self.pool)
        .await
        .map_err(sqlx_error)?;

        row.map(|row| {
            let browser_expires_at =
                OffsetDateTime::from_unix_timestamp(row.get::<i64, _>("browser_expires_at"))
                    .map_err(|error| StargateError::Internal(error.to_string()))?;
            Ok((row_to_workspace_app_route(row)?, browser_expires_at))
        })
        .transpose()
    }

    pub async fn delete_expired_workspace_app_browser_sessions(
        &self,
        now: OffsetDateTime,
    ) -> Result<u64> {
        let rows = sqlx::query("DELETE FROM workspace_app_browser_sessions WHERE expires_at <= ?")
            .bind(now.unix_timestamp())
            .execute(&self.pool)
            .await
            .map_err(sqlx_error)?
            .rows_affected();
        Ok(rows)
    }

    pub async fn get_workspace_app_route(
        &self,
        route_id: &str,
    ) -> Result<Option<WorkspaceAppRouteRecord>> {
        let row = sqlx::query(
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
        )
        .bind(route_id)
        .bind(OffsetDateTime::now_utc().unix_timestamp())
        .fetch_optional(&self.pool)
        .await
        .map_err(sqlx_error)?;

        row.map(row_to_workspace_app_route).transpose()
    }

    pub async fn delete_workspace_app_route(&self, route_id: &str) -> Result<bool> {
        let rows = sqlx::query("DELETE FROM workspace_app_routes WHERE route_id = ?")
            .bind(route_id)
            .execute(&self.pool)
            .await
            .map_err(sqlx_error)?
            .rows_affected();
        Ok(rows > 0)
    }

    pub async fn delete_expired_workspace_app_routes(
        &self,
        now: OffsetDateTime,
    ) -> Result<Vec<String>> {
        let ids = sqlx::query("SELECT route_id FROM workspace_app_routes WHERE expires_at <= ?")
            .bind(now.unix_timestamp())
            .fetch_all(&self.pool)
            .await
            .map_err(sqlx_error)?
            .into_iter()
            .map(|row| row.get::<String, _>("route_id"))
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(ids);
        }
        sqlx::query("DELETE FROM workspace_app_routes WHERE expires_at <= ?")
            .bind(now.unix_timestamp())
            .execute(&self.pool)
            .await
            .map_err(sqlx_error)?;
        Ok(ids)
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

fn row_to_route(row: sqlx::sqlite::SqliteRow) -> Result<StoredTerminalRoute> {
    let parse_time = |column: &str| {
        OffsetDateTime::from_unix_timestamp(row.get::<i64, _>(column))
            .map_err(|error| StargateError::Internal(error.to_string()))
    };
    let mode = match row.get::<String, _>("mode").as_str() {
        "browser" => TerminalSessionMode::Browser,
        "native" => TerminalSessionMode::Native,
        value => {
            return Err(StargateError::Internal(format!(
                "unsupported terminal session mode {value:?}"
            )));
        }
    };
    Ok(StoredTerminalRoute {
        route_username: row.get("route_username"),
        generation: row.get("generation"),
        expires_at: parse_time("expires_at")?,
        mode,
        metadata: RouteMetadata {
            host_id: row.get("host_id"),
            run_id: row.get("run_id"),
            vm_id: row.get("vm_id"),
            user_id: row.get("user_id"),
        },
        target: row_to_target(&row)?.unwrap_or(StoredTarget::Missing),
        created_at: parse_time("created_at")?,
        updated_at: parse_time("updated_at")?,
    })
}

/// The target row, as the stored state. A row that carries `activated_at` is
/// active; a row without it is staged and never reaches a dial path.
fn row_to_target(row: &sqlx::sqlite::SqliteRow) -> Result<Option<StoredTarget>> {
    let Some(route_username) = row.get::<Option<String>, _>("target_route_username") else {
        return Ok(None);
    };
    if route_username.is_empty() {
        return Ok(None);
    }
    let port = row.get::<i64, _>("target_port");
    let port = u16::try_from(port)
        .map_err(|_| StargateError::Internal("target_port overflowed".to_owned()))?;
    let target = TerminalTarget {
        username: row.get("target_username"),
        host: row.get("target_host"),
        port,
        host_key_openssh: row.get("target_host_key_openssh"),
        private_key_openssh: row.get("target_private_key_openssh"),
        authorized_client_public_keys_openssh: authorized_client_public_keys_from_row(row)?,
    };
    let attachment_id = row
        .try_get::<Option<String>, _>("attachment_id")
        .map_err(sqlx_error)?
        .ok_or_else(|| StargateError::Internal("target row has no attachment_id".to_owned()))?;
    let activated_at = row
        .try_get::<Option<i64>, _>("activated_at")
        .map_err(sqlx_error)?;
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

fn row_to_workspace_app_route(row: sqlx::sqlite::SqliteRow) -> Result<WorkspaceAppRouteRecord> {
    let parse_time = |column: &str| {
        OffsetDateTime::from_unix_timestamp(row.get::<i64, _>(column))
            .map_err(|error| StargateError::Internal(error.to_string()))
    };
    let parse_port = |column: &str| {
        u16::try_from(row.get::<i64, _>(column))
            .map_err(|_| StargateError::Internal(format!("{column} overflowed")))
    };
    let protocol = match row.get::<String, _>("protocol").as_str() {
        "http" => WorkspaceAppProtocol::Http,
        value => {
            return Err(StargateError::Internal(format!(
                "unsupported workspace app protocol {value:?}"
            )));
        }
    };
    Ok(WorkspaceAppRouteRecord {
        route_id: row.get("route_id"),
        target_username: row.get("target_username"),
        target_ip: row.get("target_ip"),
        target_ssh_port: parse_port("target_ssh_port")?,
        target_host_key_openssh: row.get("target_host_key_openssh"),
        target_private_key_openssh: row.get("target_private_key_openssh"),
        target_app_port: parse_port("target_app_port")?,
        protocol,
        upstream_host: row.get("upstream_host"),
        expires_at: parse_time("expires_at")?,
        metadata: WorkspaceAppMetadata {
            host_id: row.get("host_id"),
            run_id: row.get("run_id"),
            vm_id: row.get("vm_id"),
            user_id: row.get("user_id"),
        },
        created_at: parse_time("created_at")?,
        updated_at: parse_time("updated_at")?,
    })
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

fn sqlx_error(error: sqlx::Error) -> StargateError {
    StargateError::Database(error.to_string())
}

fn authorized_client_public_keys_json(target: &TerminalTarget) -> Result<String> {
    json_to_string(&target.authorized_client_public_keys_openssh)
        .map_err(|error| StargateError::Internal(error.to_string()))
}

fn authorized_client_public_keys_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Vec<String>> {
    let raw = row.get::<String, _>("authorized_client_public_keys_json");
    json_from_str(&raw).map_err(|error| StargateError::Internal(error.to_string()))
}

#[cfg(test)]
mod tests {
    use sqlx::{Row, sqlite::SqliteConnectOptions};

    use super::{MIGRATOR, SqliteRouteStore};

    /// The cutover runs against a database that an older gateway populated.
    /// This test builds that database, fills it with a complete legacy route,
    /// and runs the real migrator over it. The migration must leave no row
    /// behind and must leave a schema that serves the new contract.
    #[tokio::test]
    async fn migration_from_a_populated_old_database_leaves_no_invalid_route() -> anyhow::Result<()>
    {
        let temp_dir = tempfile::tempdir()?;
        let path = temp_dir.path().join("stargate.db");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = sqlx::SqlitePool::connect_with(options).await?;

        // Apply every migration before the terminal target cutover.
        for migration in MIGRATOR.iter().filter(|migration| migration.version < 5) {
            // These are the checked-in migration files, not user input.
            sqlx::raw_sql(sqlx::AssertSqlSafe(migration.sql.as_str().to_owned()))
                .execute(&pool)
                .await?;
        }
        sqlx::raw_sql(
            "CREATE TABLE _sqlx_migrations (\
             version BIGINT PRIMARY KEY, description TEXT NOT NULL, \
             installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \
             success BOOLEAN NOT NULL, checksum BLOB NOT NULL, \
             execution_time BIGINT NOT NULL);",
        )
        .execute(&pool)
        .await?;
        for migration in MIGRATOR.iter().filter(|migration| migration.version < 5) {
            sqlx::query(
                "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
                 VALUES (?, ?, TRUE, ?, 0)",
            )
            .bind(migration.version)
            .bind(migration.description.as_ref())
            .bind(migration.checksum.as_ref())
            .execute(&pool)
            .await?;
        }
        sqlx::query(
            "INSERT INTO routes (route_username, target_username, target_ip, target_port, \
             authorized_client_public_keys_json, target_host_key_openssh, \
             target_private_key_openssh, expires_at, created_at, updated_at) \
             VALUES ('run-01-web', 'ubuntu', '127.0.0.1', 22, '[]', 'host-key', \
             'private-key', 4102444800, 1, 1)",
        )
        .execute(&pool)
        .await?;
        assert_eq!(legacy_route_count(&pool).await?, 1);
        pool.close().await;

        // The real migrator runs the cutover over the populated database.
        let store = SqliteRouteStore::connect(&path).await?;

        let pool = sqlx::SqlitePool::connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .foreign_keys(true),
        )
        .await?;
        assert_eq!(
            legacy_route_count(&pool).await?,
            0,
            "the cutover left a route that carries no generation"
        );
        let columns = sqlx::query("SELECT name FROM pragma_table_info('routes')")
            .fetch_all(&pool)
            .await?
            .into_iter()
            .map(|row| row.get::<String, _>("name"))
            .collect::<Vec<_>>();
        assert!(!columns.contains(&"target_private_key_openssh".to_owned()));
        assert!(columns.contains(&"generation".to_owned()));
        assert!(columns.contains(&"mode".to_owned()));
        pool.close().await;

        // The migrated schema serves a new pending route end to end.
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

    async fn legacy_route_count(pool: &sqlx::SqlitePool) -> anyhow::Result<i64> {
        let row = sqlx::query("SELECT COUNT(*) AS total FROM routes")
            .fetch_one(pool)
            .await?;
        Ok(row.get::<i64, _>("total"))
    }
}
