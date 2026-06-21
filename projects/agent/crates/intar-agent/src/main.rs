#![forbid(unsafe_code)]

mod bridge;
mod bridge_core;
#[cfg(test)]
mod bridge_sim;
mod config;
mod db;
mod firmware_cache;
mod host_profile;
mod image_cache;
mod kino_probe;
mod proto;
mod tls_provider;
mod vm;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, Result};
use axum::extract::Path;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::Parser;
use tracing::info;

#[derive(Debug, Parser)]
#[command(name = "intar-agent")]
struct Cli {
    /// Path to the TOML configuration file.
    #[arg(long, value_name = "PATH")]
    config: std::path::PathBuf,
}

#[derive(Debug, Clone)]
struct AppState {
    vm: vm::VmManager,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    tls_provider::ensure_ring_provider()
        .context("failed to initialize rustls ring crypto provider")?;

    let cli = Cli::parse();
    let cfg = config::load(&cli.config)?;

    firmware_cache::spawn_warm_cache(cfg.firmwares.clone());
    image_cache::spawn_warm_cache(cfg.image_registry.clone());

    let bind: SocketAddr = cfg
        .server
        .bind
        .parse()
        .context("failed to parse server.bind")?;

    let (db, persisted) = db::Db::open()
        .await
        .context("failed to open sqlite db for persisted vm state")?;
    let vm = vm::VmManager::new(&cfg, db.clone(), persisted);
    vm.ensure_host_networking()
        .await
        .context("failed to reconcile vm host networking")?;
    vm.reconcile_tracked_vms()
        .await
        .context("failed to reconcile tracked vm state on startup")?;
    vm.restore_probe_workers()
        .await
        .context("failed to restore vm probe workers")?;
    vm.retry_archive_jobs()
        .await
        .context("failed to restore queued archive uploads")?;
    tokio::spawn({
        let vm = vm.clone();
        async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                if let Err(e) = vm.cleanup_expired_leases().await {
                    tracing::error!(error = %e, "vm lease cleanup iteration failed");
                }
            }
        }
    });
    tokio::spawn({
        let vm = vm.clone();
        async move {
            let mut interval = tokio::time::interval(Duration::from_secs(10));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                if let Err(e) = vm.retry_archive_jobs().await {
                    tracing::error!(error = %e, "archive upload retry iteration failed");
                }
            }
        }
    });

    if cfg.bridge.enabled {
        let bridge_cfg = cfg.bridge.clone();
        let bridge_vm = vm.clone();
        let bridge_disk_path = cfg
            .vm_defaults
            .work_dir
            .clone()
            .unwrap_or_else(|| PathBuf::from("/"));
        let bridge_db = db.clone();
        tokio::spawn(async move {
            bridge::run(bridge_cfg, bridge_vm, bridge_db, bridge_disk_path).await;
        });
    }

    let state = Arc::new(AppState { vm });

    let app = Router::new()
        .route("/ping", get(ping_handler))
        .route("/vms", get(list_vms_handler))
        .route("/vms/prune", post(prune_vms_handler))
        .route("/vms/{name}", get(get_vm_handler))
        .route("/runs/{run_id}", axum::routing::delete(delete_vm_handler))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("failed to bind to {bind}"))?;

    info!(bind = %bind, "intar-agent listening");
    firmware_cache::spawn_log_cache_state(cfg.firmwares.clone());
    image_cache::spawn_log_cache_state(cfg.image_registry.clone());

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server error")?;

    Ok(())
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}

async fn ping_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let vm_count = state.vm.list_vms().await.len();
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "trackedVms": vm_count
        })),
    )
        .into_response()
}

#[derive(Debug, serde::Serialize)]
struct ErrorResponse {
    error: String,
}

async fn list_vms_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let vms = state.vm.list_vms().await;
    (StatusCode::OK, Json(vms)).into_response()
}

async fn get_vm_handler(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    match state.vm.get_vm(&name).await {
        Some(vm) => (StatusCode::OK, Json(vm)).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "vm not found".to_string(),
            }),
        )
            .into_response(),
    }
}

async fn prune_vms_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let resp = state.vm.prune_vms().await;
    (StatusCode::OK, Json(resp)).into_response()
}

async fn delete_vm_handler(
    State(state): State<Arc<AppState>>,
    Path(run_id): Path<String>,
) -> impl IntoResponse {
    match state.vm.delete_vm_by_run_id(&run_id).await {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "run_id": run_id })),
        )
            .into_response(),
        Err(e) => (e.status, Json(ErrorResponse { error: e.message })).into_response(),
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let term = async {
        let mut sigterm =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(s) => s,
                Err(_) => return,
            };
        let _ = sigterm.recv().await;
    };

    #[cfg(not(unix))]
    let term = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_requires_config() {
        match Cli::try_parse_from(["intar-agent"]) {
            Ok(_) => panic!("expected clap parsing to fail without --config"),
            Err(e) => {
                let msg = e.to_string();
                assert!(msg.contains("--config"), "unexpected clap error: {msg}");
            }
        }
    }

    #[test]
    fn cli_accepts_config() -> Result<()> {
        let cli = Cli::try_parse_from(["intar-agent", "--config", "config.toml"])?;
        assert_eq!(cli.config, std::path::PathBuf::from("config.toml"));
        Ok(())
    }
}
