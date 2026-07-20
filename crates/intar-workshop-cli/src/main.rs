use anyhow::{Context, Result, anyhow, bail};
use clap::{Args, Parser, Subcommand};
use intar_workshop_manifest::{WorkshopBundle, build_bundle, load_and_validate};
use reqwest::StatusCode;
use reqwest::blocking::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

const TOKEN_ENV: &str = "INTAR_WORKSHOP_PUBLISH_TOKEN";
const REGISTRY_URL_ENV: &str = "INTAR_WORKSHOP_REGISTRY_URL";
const REGISTRY_PATH: &str = "/registry/v1/workshop-bundles";

#[derive(Debug, Parser)]
#[command(name = "intar-workshop-cli")]
#[command(about = "Validate, bundle, and publish standalone Intar workshops")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Validate workshop.hcl and every referenced source.
    Validate(SourceArgs),
    /// Create a reproducible workshop source bundle.
    Bundle(BundleArgs),
    /// Validate, bundle, and upload a workshop revision.
    Publish(PublishArgs),
    /// Read the asynchronous publication status.
    Status(StatusArgs),
}

#[derive(Debug, Args)]
struct SourceArgs {
    #[arg(default_value = ".")]
    root: PathBuf,
}

#[derive(Debug, Args)]
struct BundleArgs {
    #[arg(default_value = ".")]
    root: PathBuf,
    #[arg(short, long)]
    output: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct PublishArgs {
    #[arg(default_value = ".")]
    root: PathBuf,
    /// Intar origin or the full workshop-bundles endpoint.
    #[arg(long)]
    url: Option<String>,
    /// Organization-scoped publisher token. Prefer the environment variable.
    #[arg(long)]
    token: Option<String>,
}

#[derive(Debug, Args)]
struct StatusArgs {
    publication_id: String,
    /// Intar origin or the full workshop-bundles endpoint.
    #[arg(long)]
    url: Option<String>,
    /// Organization-scoped publisher token. Prefer the environment variable.
    #[arg(long)]
    token: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PublishReceipt {
    #[serde(alias = "id", alias = "bundle_id")]
    publication_id: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    status_url: Option<String>,
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Validate(args) => validate_command(&args),
        Command::Bundle(args) => bundle_command(&args),
        Command::Publish(args) => publish_command(&args),
        Command::Status(args) => status_command(&args),
    }
}

fn validate_command(args: &SourceArgs) -> Result<()> {
    let validated = load_and_validate(&args.root)
        .with_context(|| format!("failed to validate {}", args.root.display()))?;
    println!(
        "validated {}: {} modules, {} scheduled minutes, {} source files",
        validated.manifest.workshop.id,
        validated.manifest.modules.len(),
        validated.scheduled_duration_minutes,
        validated.source_files.len()
    );
    Ok(())
}

fn bundle_command(args: &BundleArgs) -> Result<()> {
    let bundle = build_bundle(&args.root)
        .with_context(|| format!("failed to bundle {}", args.root.display()))?;
    let output = args.output.clone().unwrap_or_else(|| {
        args.root
            .join("dist")
            .join(format!("{}.tar.gz", bundle.workshop.manifest.workshop.id))
    });
    write_bundle_file(&output, &bundle)?;
    println!(
        "bundled {} -> {} (sha256 {})",
        bundle.workshop.manifest.workshop.id,
        output.display(),
        bundle.sha256
    );
    Ok(())
}

fn publish_command(args: &PublishArgs) -> Result<()> {
    let endpoint = registry_endpoint(resolve_url(args.url.as_deref())?)?;
    let token = resolve_token(args.token.as_deref())?;
    let bundle = build_bundle(&args.root)
        .with_context(|| format!("failed to bundle {}", args.root.display()))?;
    let receipt = upload_bundle(&endpoint, &token, &bundle)?;
    println!("{}", serde_json::to_string_pretty(&receipt)?);
    Ok(())
}

fn status_command(args: &StatusArgs) -> Result<()> {
    validate_publication_id(&args.publication_id)?;
    let endpoint = registry_endpoint(resolve_url(args.url.as_deref())?)?;
    let token = resolve_token(args.token.as_deref())?;
    let url = format!("{endpoint}/{}", args.publication_id);
    let response = http_client()?
        .get(&url)
        .bearer_auth(token.trim())
        .send()
        .with_context(|| format!("failed to read workshop publication status from {url}"))?;
    let status = response.status();
    let body = response
        .text()
        .context("failed to read workshop publication status response")?;
    require_success(status, &body, "workshop publication status")?;
    match serde_json::from_str::<serde_json::Value>(&body) {
        Ok(value) => println!("{}", serde_json::to_string_pretty(&value)?),
        Err(_) => println!("{body}"),
    }
    Ok(())
}

fn upload_bundle(endpoint: &str, token: &str, bundle: &WorkshopBundle) -> Result<PublishReceipt> {
    let workshop_id = &bundle.workshop.manifest.workshop.id;
    let part = Part::bytes(bundle.bytes.clone())
        .file_name(format!("{workshop_id}.tar.gz"))
        .mime_str("application/gzip")?;
    let form = Form::new()
        .text("workshop_id", workshop_id.clone())
        .text("sha256", bundle.sha256.clone())
        .part("bundle", part);
    let response = http_client()?
        .post(endpoint)
        .bearer_auth(token.trim())
        .multipart(form)
        .send()
        .with_context(|| format!("failed to upload workshop bundle to {endpoint}"))?;
    let status = response.status();
    let body = response
        .text()
        .context("failed to read workshop publication response")?;
    parse_publish_response(status, &body)
}

fn parse_publish_response(status: StatusCode, body: &str) -> Result<PublishReceipt> {
    require_success(status, body, "workshop publication")?;
    let receipt: PublishReceipt =
        serde_json::from_str(body).context("workshop publication response is not valid JSON")?;
    validate_publication_id(&receipt.publication_id)
        .context("workshop publication response contains an invalid publication_id")?;
    Ok(receipt)
}

fn require_success(status: StatusCode, body: &str, operation: &str) -> Result<()> {
    if !status.is_success() {
        let excerpt: String = body.chars().take(4096).collect();
        bail!("{operation} failed with status {status}: {excerpt}");
    }
    Ok(())
}

fn http_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .user_agent(concat!("intar-workshop-cli/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("failed to configure HTTP client")
}

fn resolve_url(argument: Option<&str>) -> Result<String> {
    argument
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            env::var(REGISTRY_URL_ENV)
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
        .ok_or_else(|| anyhow!("missing --url or {REGISTRY_URL_ENV}"))
}

fn resolve_token(argument: Option<&str>) -> Result<String> {
    argument
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            env::var(TOKEN_ENV)
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
        .ok_or_else(|| anyhow!("missing --token or {TOKEN_ENV}"))
}

fn registry_endpoint(base: String) -> Result<String> {
    let base = base.trim().trim_end_matches('/');
    let url = reqwest::Url::parse(base).context("workshop registry URL is invalid")?;
    if !url.username().is_empty() || url.password().is_some() {
        bail!("workshop registry URL must not contain credentials");
    }
    if url.query().is_some() || url.fragment().is_some() {
        bail!("workshop registry URL must not contain a query or fragment");
    }
    let loopback_http = url.scheme() == "http"
        && url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        });
    if url.scheme() != "https" && !loopback_http {
        bail!("workshop registry URL must use HTTPS (HTTP is allowed only for localhost)");
    }
    if base.ends_with(REGISTRY_PATH) {
        Ok(base.to_string())
    } else {
        Ok(format!("{base}{REGISTRY_PATH}"))
    }
}

fn validate_publication_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || value
            .bytes()
            .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(byte, b'-' | b'_'))
    {
        bail!("publication id must contain only ASCII letters, digits, '-' and '_'");
    }
    Ok(())
}

fn write_bundle_file(output: &Path, bundle: &WorkshopBundle) -> Result<()> {
    if let Some(parent) = output.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let mut file = fs::File::create(output)
        .with_context(|| format!("failed to create {}", output.display()))?;
    file.write_all(&bundle.bytes)
        .with_context(|| format!("failed to write {}", output.display()))?;
    file.sync_all()
        .with_context(|| format!("failed to sync {}", output.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_registry_endpoint_from_an_origin() -> Result<()> {
        assert_eq!(
            registry_endpoint("https://intar.dev/".to_string())?,
            "https://intar.dev/registry/v1/workshop-bundles"
        );
        assert_eq!(
            registry_endpoint("https://intar.dev/registry/v1/workshop-bundles".to_string())?,
            "https://intar.dev/registry/v1/workshop-bundles"
        );
        Ok(())
    }

    #[test]
    fn rejects_plain_http_for_remote_registries() {
        assert!(registry_endpoint("http://intar.dev".to_string()).is_err());
        assert!(registry_endpoint("http://localhost:8787".to_string()).is_ok());
        assert!(registry_endpoint("http://127.0.0.1:8787".to_string()).is_ok());
        assert!(registry_endpoint("http://[::1]:8787".to_string()).is_ok());
        assert!(registry_endpoint("http://localhost.evil.test".to_string()).is_err());
        assert!(registry_endpoint("http://127.0.0.1.evil.test".to_string()).is_err());
    }

    #[test]
    fn accepts_asynchronous_publish_receipts() -> Result<()> {
        let receipt = parse_publish_response(
            StatusCode::ACCEPTED,
            r#"{"publication_id":"01j-workshop","status":"queued"}"#,
        )?;
        assert_eq!(receipt.publication_id, "01j-workshop");
        assert_eq!(receipt.status.as_deref(), Some("queued"));
        Ok(())
    }

    #[test]
    fn rejects_unsuccessful_publish_responses() {
        let result = parse_publish_response(StatusCode::FORBIDDEN, "token scope mismatch");
        assert!(result.is_err());
    }
}
