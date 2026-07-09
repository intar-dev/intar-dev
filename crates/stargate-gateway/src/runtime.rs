use std::{env, path::Path, time::Duration};

use anyhow::{Context, anyhow, ensure};
use sd_notify::NotifyState;
use stargate_core::ServerSettings;
use tokio::net::TcpListener;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

use crate::{
    GatewayState, SqliteRouteStore, build_admin_router, build_public_router, run_public_ssh_server,
};

pub fn load_settings(path: &Path) -> anyhow::Result<ServerSettings> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("failed reading config {}", path.display()))?;
    let mut settings = toml::from_str::<ServerSettings>(&raw)
        .with_context(|| format!("failed parsing config {}", path.display()))?;
    apply_env_overrides(&mut settings)?;
    Ok(settings)
}

pub async fn run(settings: ServerSettings) -> anyhow::Result<()> {
    init_tracing(&settings)?;
    validate_runtime_security(&settings)?;
    ensure_parent_dirs(&settings).await?;
    let host_key = load_or_create_host_key(
        &settings.host_key_path,
        russh::keys::ssh_key::Algorithm::Ed25519,
    )
    .await?;
    let store = SqliteRouteStore::connect(&settings.database_path).await?;
    ensure_private_file_permissions(&settings.database_path).await?;
    let gateway = GatewayState::new(
        store,
        settings.admin_auth.clone(),
        &settings.web,
        host_key.public_key().clone(),
        settings.terminal_tokens.clone(),
    )?;
    let expiry_gateway = gateway.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            match expiry_gateway
                .store
                .delete_expired_routes(time::OffsetDateTime::now_utc())
                .await
            {
                Ok(usernames) => {
                    for username in usernames {
                        expiry_gateway.sessions.terminate_username(&username).await;
                    }
                }
                Err(error) => {
                    tracing::warn!(error = %error, "failed to delete expired routes");
                }
            }
        }
    });

    let admin_listener = TcpListener::bind(settings.admin_bind)
        .await
        .with_context(|| format!("failed to bind admin listener on {}", settings.admin_bind))?;
    let public_listener = TcpListener::bind(settings.web.bind)
        .await
        .with_context(|| format!("failed to bind public listener on {}", settings.web.bind))?;
    let public_ssh_listener = TcpListener::bind(settings.ssh_bind)
        .await
        .with_context(|| {
            format!(
                "failed to bind public ssh listener on {}",
                settings.ssh_bind
            )
        })?;
    let admin_router = build_admin_router(gateway.clone());
    let public_router = build_public_router(gateway.clone());
    let public_ssh_gateway = gateway.clone();

    let admin_task = tokio::spawn(async move {
        axum::serve(admin_listener, admin_router)
            .await
            .context("admin server failed")
    });
    let public_task =
        tokio::spawn(async move { serve_public(public_router, public_listener).await });
    let public_ssh_task = tokio::spawn(async move {
        run_public_ssh_server(public_ssh_gateway, public_ssh_listener, host_key).await
    });

    let _ = sd_notify::notify(&[NotifyState::Ready]);

    tokio::select! {
        result = supervise_server_tasks(admin_task, public_task, public_ssh_task) => result,
        signal = tokio::signal::ctrl_c() => {
            if let Err(error) = signal {
                tracing::warn!(error = %error, "failed to listen for ctrl-c");
            }
            let _ = sd_notify::notify(&[NotifyState::Stopping]);
            Ok(())
        }
    }
}

fn apply_env_overrides(settings: &mut ServerSettings) -> anyhow::Result<()> {
    if let Ok(value) = env::var("STARGATE_ADMIN_BIND") {
        settings.admin_bind = value.parse()?;
    }
    if let Ok(value) = env::var("STARGATE_SSH_BIND") {
        settings.ssh_bind = value.parse()?;
    }
    if let Ok(value) = env::var("STARGATE_WEB_BIND") {
        settings.web.bind = value.parse()?;
    }
    if let Ok(value) = env::var("STARGATE_PUBLIC_BASE_URL") {
        settings.web.public_base_url = value.parse()?;
    }
    if let Ok(value) = env::var("STARGATE_PUBLIC_SSH_HOST") {
        settings.web.public_ssh_host = value;
    }
    if let Ok(value) = env::var("STARGATE_PUBLIC_SSH_PORT") {
        settings.web.public_ssh_port = value.parse()?;
    }
    if let Ok(value) = env::var("STARGATE_WEB_ALLOWED_ORIGINS") {
        settings.web.allowed_origins = value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect();
    }
    if let Ok(value) = env::var("STARGATE_DATABASE_PATH") {
        settings.database_path = value.into();
    }
    if let Ok(value) = env::var("STARGATE_HOST_KEY_PATH") {
        settings.host_key_path = value.into();
    }
    if let Ok(value) = env::var("STARGATE_ADMIN_ASSERTION_HEADER") {
        settings.admin_auth.assertion_header = value;
    }
    if let Ok(value) = env::var("STARGATE_ADMIN_AUDIENCE") {
        settings.admin_auth.audience = value;
    }
    if let Ok(value) = env::var("STARGATE_ADMIN_ISSUER") {
        settings.admin_auth.issuer = value;
    }
    if let Ok(value) = env::var("STARGATE_ADMIN_JWKS_URL") {
        settings.admin_auth.jwks_url = Some(value.parse()?);
    }
    if let Ok(value) = env::var("STARGATE_ADMIN_HS256_SECRET") {
        settings.admin_auth.hs256_secret = Some(value);
    }
    if let Ok(value) = env::var("STARGATE_TERMINAL_TOKEN_ISSUER") {
        settings.terminal_tokens.issuer = value;
    }
    if let Ok(value) = env::var("STARGATE_TERMINAL_TOKEN_AUDIENCE") {
        settings.terminal_tokens.audience = value;
    }
    if let Ok(value) = env::var("STARGATE_TERMINAL_TOKEN_HS256_SECRET") {
        settings.terminal_tokens.hs256_secret = value;
    }
    if let Ok(value) = env::var("STARGATE_CF_AUDIENCE") {
        settings.admin_auth.audience = value;
    }
    if let Ok(value) = env::var("STARGATE_CF_ISSUER") {
        settings.admin_auth.issuer = value;
    }
    if let Ok(value) = env::var("STARGATE_CF_JWKS_URL") {
        settings.admin_auth.jwks_url = Some(value.parse()?);
    }
    if let Ok(value) = env::var("STARGATE_CF_HS256_SECRET") {
        settings.admin_auth.hs256_secret = Some(value);
    }
    Ok(())
}

fn validate_runtime_security(settings: &ServerSettings) -> anyhow::Result<()> {
    ensure!(
        settings.admin_bind.ip().is_loopback(),
        "admin_bind must be a loopback address"
    );
    ensure!(
        settings.web.bind.ip().is_loopback(),
        "web.bind must be a loopback address"
    );
    ensure!(
        !settings.web.allowed_origins.is_empty(),
        "web.allowed_origins must not be empty"
    );
    ensure!(
        matches!(settings.web.public_base_url.scheme(), "http" | "https"),
        "web.public_base_url must use http or https"
    );
    ensure!(
        !settings.web.public_ssh_host.trim().is_empty(),
        "web.public_ssh_host must not be empty"
    );
    ensure!(
        !settings.terminal_tokens.hs256_secret.trim().is_empty(),
        "terminal_tokens.hs256_secret must not be empty"
    );
    validate_jwks_url("admin_auth", settings.admin_auth.jwks_url.as_ref())?;
    Ok(())
}

fn validate_jwks_url(name: &str, url: Option<&url::Url>) -> anyhow::Result<()> {
    if let Some(url) = url {
        ensure!(url.scheme() == "https", "{name}.jwks_url must use https");
    }
    Ok(())
}

async fn ensure_parent_dirs(settings: &ServerSettings) -> anyhow::Result<()> {
    if let Some(parent) = settings.database_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if let Some(parent) = settings.host_key_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::create_dir_all(&settings.state_dir).await?;
    ensure_private_dir_permissions(&settings.state_dir).await?;
    Ok(())
}

async fn serve_public(router: axum::Router, listener: TcpListener) -> anyhow::Result<()> {
    axum::serve(listener, router)
        .await
        .context("public http server failed")?;
    Ok(())
}

async fn load_or_create_host_key(
    path: &Path,
    algorithm: russh::keys::ssh_key::Algorithm,
) -> anyhow::Result<russh::keys::PrivateKey> {
    let key = if path.exists() {
        let key = russh::keys::load_secret_key(path, None)
            .with_context(|| format!("failed loading host key {}", path.display()))?;
        if key.algorithm() != algorithm {
            return Err(anyhow!(
                "host key {} must use algorithm {}",
                path.display(),
                algorithm.as_str()
            ));
        }
        key
    } else {
        let mut rng = russh::keys::key::safe_rng();
        let key = russh::keys::PrivateKey::random(&mut rng, algorithm.clone())?;
        let contents = key.to_openssh(russh::keys::ssh_key::LineEnding::LF)?;
        tokio::fs::write(path, contents)
            .await
            .with_context(|| format!("failed writing host key {}", path.display()))?;
        key
    };
    ensure_private_file_permissions(path).await?;
    Ok(key)
}

#[cfg(unix)]
async fn ensure_private_dir_permissions(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = tokio::fs::metadata(path).await?.permissions();
    permissions.set_mode(0o700);
    tokio::fs::set_permissions(path, permissions).await?;
    Ok(())
}

#[cfg(not(unix))]
async fn ensure_private_dir_permissions(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(unix)]
async fn ensure_private_file_permissions(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    if !path.exists() {
        return Ok(());
    }
    let mut permissions = tokio::fs::metadata(path).await?.permissions();
    permissions.set_mode(0o600);
    tokio::fs::set_permissions(path, permissions).await?;
    Ok(())
}

#[cfg(not(unix))]
async fn ensure_private_file_permissions(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

fn init_tracing(settings: &ServerSettings) -> anyhow::Result<()> {
    let filter = settings
        .trace
        .as_ref()
        .map(|trace| trace.filter.clone())
        .unwrap_or_else(|| "info,stargate=debug".to_owned());
    let env_filter = EnvFilter::new(filter);
    let registry = tracing_subscriber::registry().with(env_filter);
    if settings.trace.as_ref().is_some_and(|trace| trace.json) {
        registry.with(fmt::layer().json()).try_init()?;
    } else {
        registry.with(fmt::layer()).try_init()?;
    }
    Ok(())
}

async fn join_task<T>(handle: tokio::task::JoinHandle<anyhow::Result<T>>) -> anyhow::Result<T> {
    handle.await.context("task join failed")?
}

async fn supervise_server_tasks(
    admin_task: tokio::task::JoinHandle<anyhow::Result<()>>,
    public_task: tokio::task::JoinHandle<anyhow::Result<()>>,
    public_ssh_task: tokio::task::JoinHandle<anyhow::Result<()>>,
) -> anyhow::Result<()> {
    tokio::select! {
        result = join_task(admin_task) => server_task_result("admin", result),
        result = join_task(public_task) => server_task_result("public", result),
        result = join_task(public_ssh_task) => server_task_result("public ssh", result),
    }
}

fn server_task_result(name: &str, result: anyhow::Result<()>) -> anyhow::Result<()> {
    match result {
        Ok(()) => Err(anyhow!("{name} server exited unexpectedly")),
        Err(error) => Err(error).with_context(|| format!("{name} server exited")),
    }
}

#[cfg(test)]
mod tests {
    use std::{future::pending, time::Duration};

    use super::supervise_server_tasks;

    #[tokio::test]
    async fn supervisor_reports_any_server_failure_without_waiting_for_earlier_tasks() {
        let admin_task = tokio::spawn(pending::<anyhow::Result<()>>());
        let public_task = tokio::spawn(async { Err(anyhow::anyhow!("public failed")) });
        let public_ssh_task = tokio::spawn(pending::<anyhow::Result<()>>());

        let error = tokio::time::timeout(
            Duration::from_secs(1),
            supervise_server_tasks(admin_task, public_task, public_ssh_task),
        )
        .await
        .expect("supervisor should observe the public server failure")
        .expect_err("server failure should fail supervision");

        let message = format!("{error:#}");
        assert!(message.contains("public server exited"));
        assert!(message.contains("public failed"));
    }
}
