use std::path::Path;

use serde_json::{from_str as json_from_str, to_string as json_to_string};
use sqlx::{
    Row, SqlitePool, migrate::Migrator, sqlite::SqliteConnectOptions, sqlite::SqlitePoolOptions,
};
use stargate_core::{
    RegisteredRoute, RegisteredWorkspaceAppRoute, Result, RouteRecord, StargateError,
    WorkspaceAppProtocol, WorkspaceAppRouteRecord,
};
use time::OffsetDateTime;

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

#[derive(Clone)]
pub struct SqliteRouteStore {
    pool: SqlitePool,
}

impl SqliteRouteStore {
    pub async fn connect<P: AsRef<Path>>(database_path: P) -> Result<Self> {
        let path = database_path.as_ref();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let options = SqliteConnectOptions::new()
            .filename(path)
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

    pub async fn upsert_route(&self, route: RegisteredRoute) -> Result<RouteRecord> {
        let now = OffsetDateTime::now_utc();
        sqlx::query(
            r#"
            INSERT INTO routes (
                route_username,
                target_username,
                target_ip,
                target_port,
                authorized_client_public_keys_json,
                target_host_key_openssh,
                target_private_key_openssh,
                expires_at,
                host_id,
                run_id,
                vm_id,
                user_id,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(route_username) DO UPDATE SET
                target_username = excluded.target_username,
                target_ip = excluded.target_ip,
                target_port = excluded.target_port,
                authorized_client_public_keys_json = excluded.authorized_client_public_keys_json,
                target_host_key_openssh = excluded.target_host_key_openssh,
                target_private_key_openssh = excluded.target_private_key_openssh,
                expires_at = excluded.expires_at,
                host_id = excluded.host_id,
                run_id = excluded.run_id,
                vm_id = excluded.vm_id,
                user_id = excluded.user_id,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(&route.route_username)
        .bind(&route.target_username)
        .bind(&route.target_ip)
        .bind(i64::from(route.target_port))
        .bind(authorized_client_public_keys_json(&route)?)
        .bind(&route.target_host_key_openssh)
        .bind(&route.target_private_key_openssh)
        .bind(route.expires_at.unix_timestamp())
        .bind(route.metadata.host_id.as_deref())
        .bind(route.metadata.run_id.as_deref())
        .bind(route.metadata.vm_id.as_deref())
        .bind(route.metadata.user_id.as_deref())
        .bind(now.unix_timestamp())
        .bind(now.unix_timestamp())
        .execute(&self.pool)
        .await
        .map_err(sqlx_error)?;

        self.get_route(&route.route_username)
            .await?
            .ok_or_else(|| StargateError::Internal("route disappeared after upsert".to_owned()))
    }

    pub async fn get_route(&self, route_username: &str) -> Result<Option<RouteRecord>> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let row = sqlx::query(
            r#"
            SELECT
                route_username,
                target_username,
                target_ip,
                target_port,
                authorized_client_public_keys_json,
                target_host_key_openssh,
                target_private_key_openssh,
                expires_at,
                host_id,
                run_id,
                vm_id,
                user_id,
                created_at,
                updated_at
            FROM routes
            WHERE route_username = ?
              AND expires_at > ?
            "#,
        )
        .bind(route_username)
        .bind(now)
        .fetch_optional(&self.pool)
        .await
        .map_err(sqlx_error)?;

        row.map(row_to_route).transpose()
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
        // Reissuing an existing route is an authorization rotation. Invalidate
        // every browser session before replacing the bootstrap capability.
        sqlx::query("DELETE FROM workspace_app_browser_sessions WHERE route_id = ?")
            .bind(&route.route_id)
            .execute(&mut *transaction)
            .await
            .map_err(sqlx_error)?;
        sqlx::query(
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
            ON CONFLICT(route_id) DO UPDATE SET
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
                updated_at = excluded.updated_at
            "#,
        )
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

fn row_to_route(row: sqlx::sqlite::SqliteRow) -> Result<RouteRecord> {
    let created_at = OffsetDateTime::from_unix_timestamp(row.get::<i64, _>("created_at"))
        .map_err(|error| StargateError::Internal(error.to_string()))?;
    let updated_at = OffsetDateTime::from_unix_timestamp(row.get::<i64, _>("updated_at"))
        .map_err(|error| StargateError::Internal(error.to_string()))?;
    let expires_at = OffsetDateTime::from_unix_timestamp(row.get::<i64, _>("expires_at"))
        .map_err(|error| StargateError::Internal(error.to_string()))?;

    let target_port = row.get::<i64, _>("target_port");
    let target_port = u16::try_from(target_port)
        .map_err(|_| StargateError::Internal("target_port overflowed".to_owned()))?;

    Ok(RouteRecord {
        route_username: row.get("route_username"),
        target_username: row.get("target_username"),
        target_ip: row.get("target_ip"),
        target_port,
        authorized_client_public_keys_openssh: authorized_client_public_keys_from_row(&row)?,
        target_host_key_openssh: row.get("target_host_key_openssh"),
        target_private_key_openssh: row.get("target_private_key_openssh"),
        expires_at,
        metadata: stargate_core::RouteMetadata {
            host_id: row.get("host_id"),
            run_id: row.get("run_id"),
            vm_id: row.get("vm_id"),
            user_id: row.get("user_id"),
        },
        created_at,
        updated_at,
    })
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
        metadata: stargate_core::RouteMetadata {
            host_id: row.get("host_id"),
            run_id: row.get("run_id"),
            vm_id: row.get("vm_id"),
            user_id: row.get("user_id"),
        },
        created_at: parse_time("created_at")?,
        updated_at: parse_time("updated_at")?,
    })
}

fn workspace_app_protocol_slug(protocol: WorkspaceAppProtocol) -> &'static str {
    match protocol {
        WorkspaceAppProtocol::Http => "http",
    }
}

fn sqlx_error(error: sqlx::Error) -> StargateError {
    StargateError::Database(error.to_string())
}

fn authorized_client_public_keys_json(route: &RegisteredRoute) -> Result<String> {
    json_to_string(&route.authorized_client_public_keys_openssh)
        .map_err(|error| StargateError::Internal(error.to_string()))
}

fn authorized_client_public_keys_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Vec<String>> {
    let raw = row.get::<String, _>("authorized_client_public_keys_json");
    json_from_str(&raw).map_err(|error| StargateError::Internal(error.to_string()))
}
