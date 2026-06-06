use std::path::Path;

use serde_json::{from_str as json_from_str, to_string as json_to_string};
use sqlx::{
    Row, SqlitePool, migrate::Migrator, sqlite::SqliteConnectOptions, sqlite::SqlitePoolOptions,
};
use stargate_core::{RegisteredRoute, Result, RouteRecord, StargateError};
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
            .create_if_missing(true);
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
                expires_at,
                host_id,
                run_id,
                vm_id,
                user_id,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(route_username) DO UPDATE SET
                target_username = excluded.target_username,
                target_ip = excluded.target_ip,
                target_port = excluded.target_port,
                authorized_client_public_keys_json = excluded.authorized_client_public_keys_json,
                target_host_key_openssh = excluded.target_host_key_openssh,
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
        .bind(route.target_host_key_openssh.as_deref())
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
