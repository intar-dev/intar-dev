use std::{env, path::Path, time::Duration};

use anyhow::{Context, anyhow, ensure};
use sd_notify::NotifyState;
use stargate_core::ServerSettings;
use stargate_gateway::{
    GatewayState, build_admin_router, build_public_router, run_public_ssh_server,
};
use stargate_store_sqlite::SqliteRouteStore;
use tokio::net::TcpListener;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

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
    let _target_key = load_or_create_host_key(
        &settings.target_key_path,
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
        settings.ssh_binary.clone(),
        settings.ssh_keyscan_binary.clone(),
        settings.target_key_path.clone(),
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
    let admin_router = build_admin_router(gateway.clone());
    let public_router = build_public_router(gateway.clone());
    let web_settings = settings.web.clone();
    let ssh_bind = settings.ssh_bind;
    let public_ssh_gateway = gateway.clone();

    let admin_task = tokio::spawn(async move {
        axum::serve(admin_listener, admin_router)
            .await
            .context("admin server failed")
    });
    let public_task = tokio::spawn(async move { serve_public(public_router, web_settings).await });
    let public_ssh_task =
        tokio::spawn(
            async move { run_public_ssh_server(public_ssh_gateway, ssh_bind, host_key).await },
        );

    let _ = sd_notify::notify(true, &[NotifyState::Ready]);

    tokio::select! {
        result = async {
            join_task(admin_task).await?;
            join_task(public_task).await?;
            join_task(public_ssh_task).await?;
            Ok::<(), anyhow::Error>(())
        } => result,
        signal = tokio::signal::ctrl_c() => {
            if let Err(error) = signal {
                tracing::warn!(error = %error, "failed to listen for ctrl-c");
            }
            let _ = sd_notify::notify(true, &[NotifyState::Stopping]);
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
    if let Ok(value) = env::var("STARGATE_TARGET_KEY_PATH") {
        settings.target_key_path = value.into();
    }
    if let Ok(value) = env::var("STARGATE_SSH_BINARY") {
        settings.ssh_binary = value.into();
    }
    if let Ok(value) = env::var("STARGATE_SSH_KEYSCAN_BINARY") {
        settings.ssh_keyscan_binary = value.into();
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
    if let Some(parent) = settings.target_key_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::create_dir_all(&settings.state_dir).await?;
    ensure_private_dir_permissions(&settings.state_dir).await?;
    Ok(())
}

async fn serve_public(
    router: axum::Router,
    settings: stargate_core::WebSettings,
) -> anyhow::Result<()> {
    let listener = TcpListener::bind(settings.bind)
        .await
        .with_context(|| format!("failed to bind public listener on {}", settings.bind))?;
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
        let key = russh::keys::PrivateKey::random(
            &mut russh::keys::ssh_key::rand_core::OsRng,
            algorithm.clone(),
        )?;
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
