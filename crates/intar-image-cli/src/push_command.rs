//! `intar-image-cli push`: the last step of a pipeline's image job (#441).
//! It trades the run's OIDC token for a session, pushes the image `build`
//! wrote under it, and records it as the source's image of its build key.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use clap::Args;
use intar_contracts::oci::{Architecture, OciDigest};
use intar_image_upload::{Error as UploadError, PipelineSession, RegistryPusher};

use crate::bundle_command::{EXIT_SUPERSEDED, EXIT_TRANSIENT, UploadFailed};

/// `build` leaves this beside the image, so a push needs nothing copied from
/// its output.
pub(crate) const IMAGE_FILE: &str = "image.json";

/// What `build cluster:` leaves beside a cluster's images in place of
/// [`IMAGE_FILE`]: they are pushed and recorded as one set.
pub(crate) const CLUSTER_FILE: &str = "images.json";

/// What `images.json` says of a cluster's images in its directory.
#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct BuiltCluster {
    pub(crate) cluster_key: OciDigest,
    /// `amd64` or `arm64`.
    pub(crate) arch: String,
    pub(crate) images: Vec<BuiltClusterImage>,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct BuiltClusterImage {
    pub(crate) machine: String,
    pub(crate) build_key: OciDigest,
    pub(crate) manifest: OciDigest,
}

impl BuiltCluster {
    pub(crate) fn write(&self, dir: &Path) -> Result<()> {
        let path = dir.join(CLUSTER_FILE);
        std::fs::write(&path, serde_json::to_vec_pretty(self)?)
            .with_context(|| format!("failed to write {}", path.display()))
    }

    fn read(dir: &Path) -> Result<Option<Self>> {
        let path = dir.join(CLUSTER_FILE);
        match std::fs::read(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            read => {
                serde_json::from_slice(&read.with_context(|| format!("read {}", path.display()))?)
                    .map(Some)
                    .with_context(|| {
                        format!("{} does not describe a built cluster", path.display())
                    })
            }
        }
    }
}

/// What `image.json` says of the image in its directory.
#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct BuiltImage {
    pub(crate) build_key: OciDigest,
    pub(crate) manifest: OciDigest,
    /// `amd64` or `arm64`.
    pub(crate) arch: String,
}

impl BuiltImage {
    pub(crate) fn write(&self, dir: &Path) -> Result<()> {
        let path = dir.join(IMAGE_FILE);
        std::fs::write(&path, serde_json::to_vec_pretty(self)?)
            .with_context(|| format!("failed to write {}", path.display()))
    }

    /// Removes what an earlier build left: `image.json` and `images.json`.
    pub(crate) fn forget(dir: &Path) -> Result<()> {
        for name in [IMAGE_FILE, CLUSTER_FILE] {
            let path = dir.join(name);
            match std::fs::remove_file(&path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(error)
                        .with_context(|| format!("failed to remove {}", path.display()));
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn read(dir: &Path) -> Result<Self> {
        let path = dir.join(IMAGE_FILE);
        serde_json::from_slice(
            &std::fs::read(&path)
                .with_context(|| format!("read {}; `build` writes it", path.display()))?,
        )
        .with_context(|| format!("{} does not describe a built image", path.display()))
    }
}

#[derive(Debug, Args)]
pub(crate) struct PushCommand {
    /// The directory `build --out` wrote.
    #[arg(long)]
    image: PathBuf,
    /// The service, as `https://host`.
    #[arg(long)]
    url: String,
    /// The run's GitHub Actions OIDC token. Without it, in a GitHub Actions
    /// job that may ask for one (`id-token: write`), a new one is asked for
    /// on every try, with `--url` as its audience: a token lives for
    /// minutes, and the wait for the bundle can be longer.
    #[arg(long)]
    token: Option<String>,
    /// The rev `plan` uploaded the bundle as.
    #[arg(long)]
    rev: String,
}

/// What one push records: one image, or every image of a cluster.
enum Built {
    Image(BuiltImage),
    Cluster(BuiltCluster),
}

pub(crate) fn push_command(args: &PushCommand) -> Result<()> {
    let built = match BuiltCluster::read(&args.image)? {
        Some(cluster) => Built::Cluster(cluster),
        None => Built::Image(BuiltImage::read(&args.image)?),
    };
    let arch = match &built {
        Built::Image(image) => &image.arch,
        Built::Cluster(cluster) => &cluster.arch,
    };
    let architecture = match arch.as_str() {
        "amd64" => Architecture::Amd64,
        "arm64" => Architecture::Arm64,
        other => anyhow::bail!("the built image names the architecture '{other}'"),
    };
    // Told apart from a runner whose token endpoint fails for a moment:
    // without either there is nothing to try again.
    anyhow::ensure!(
        args.token.is_some() || std::env::var_os("ACTIONS_ID_TOKEN_REQUEST_URL").is_some(),
        "pass --token, or run in a GitHub Actions job with `id-token: write`"
    );
    let audience = args.url.trim().trim_end_matches('/').to_owned();
    // A runner that will never give a token is told apart from one whose
    // endpoint fails for a moment.
    let hopeless = std::cell::Cell::new(false);
    let session = PipelineSession::open(
        &args.url,
        || match &args.token {
            Some(token) => Ok(token.clone()),
            None => github_oidc_token(&audience).map_err(|(error, again)| {
                hopeless.set(!again);
                error
            }),
        },
        &args.rev,
    )
    .map_err(|error| {
        if hopeless.get() {
            anyhow!(UploadFailed {
                exit_code: 1,
                message: format!("the image push failed: {error}"),
            })
        } else {
            failed(error)
        }
    })?;
    let pusher = RegistryPusher::new(&args.url, session.token());
    let pushed = match &built {
        Built::Image(image) => pusher
            .and_then(|pusher| {
                pusher.push_image(
                    &args.image,
                    &image.manifest,
                    image.build_key.hex(),
                    architecture,
                )
            })
            .map(|recorded| {
                println!(
                    "image={} recorded={}",
                    recorded.image.as_str(),
                    if recorded.first { "first" } else { "existing" }
                );
            }),
        Built::Cluster(cluster) => pusher
            .and_then(|pusher| {
                let images = cluster
                    .images
                    .iter()
                    .map(|image| (image.build_key.clone(), image.manifest.clone()))
                    .collect();
                pusher.push_cluster(
                    &args.image,
                    &images,
                    cluster.cluster_key.hex(),
                    architecture,
                )
            })
            .map(|recorded| {
                for (key, image) in &recorded.images {
                    println!(
                        "build_key={} image={} recorded={}",
                        key.as_str(),
                        image.as_str(),
                        if recorded.first { "first" } else { "existing" }
                    );
                }
            }),
    }
    .map_err(failed);
    // Its place among the source's open sessions is freed either way; a close
    // that fails does not undo a recorded image.
    if let Err(error) = session.close() {
        eprintln!("warning: the upload session did not close: {error}");
    }
    pushed
}

/// A new OIDC token of this GitHub Actions job for `audience`, from the
/// endpoint the runner names to a job with `id-token: write`. An error says
/// whether another try may pass.
fn github_oidc_token(audience: &str) -> std::result::Result<String, (String, bool)> {
    let (Ok(url), Ok(bearer)) = (
        std::env::var("ACTIONS_ID_TOKEN_REQUEST_URL"),
        std::env::var("ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
    ) else {
        return Err((
            "pass --token, or run in a GitHub Actions job with `id-token: write`".to_owned(),
            false,
        ));
    };
    let mut url = reqwest::Url::parse(&url).map_err(|error| (error.to_string(), false))?;
    url.query_pairs_mut().append_pair("audience", audience);
    // reqwest has no crypto provider of its own; install ring first.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let answer: serde_json::Value = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .and_then(|client| client.get(url).bearer_auth(bearer).send())
        .and_then(reqwest::blocking::Response::error_for_status)
        .and_then(reqwest::blocking::Response::json)
        // The error names the endpoint without its query, never the bearer.
        // A refusal is final; no answer or a server's failure is not.
        .map_err(|error| {
            let again = !error
                .status()
                .is_some_and(|status| status.is_client_error());
            (error.without_url().to_string(), again)
        })?;
    answer
        .get("value")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ("the runner's answer holds no token".to_owned(), false))
}

/// A failed push with the exit code a workflow acts on: 3 when the commit is
/// no longer the one to build for, 75 when trying again may pass. Only the
/// session open says 3: a session that ends while the push runs is refused as
/// unauthorized, and the next open tells why.
pub(crate) fn failed(error: UploadError) -> anyhow::Error {
    let exit_code = match &error {
        UploadError::Http(error) if error.is_builder() => 1,
        // The runner's token endpoint may answer on another try.
        UploadError::Token(_) => EXIT_TRANSIENT,
        UploadError::Http(_) | UploadError::SessionBroken { .. } => EXIT_TRANSIENT,
        UploadError::HttpStatus { status, body } => {
            let code = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|value| value.get("code")?.as_str().map(str::to_owned));
            match (status.as_u16(), code.as_deref()) {
                (409, Some("superseded")) => EXIT_SUPERSEDED,
                // A paused registry refuses the blob check, a HEAD, which
                // carries no body.
                (409, None) if body.trim().is_empty() => EXIT_TRANSIENT,
                (429 | 500..=599, _)
                | (
                    409,
                    Some(
                        "bundle_pending"
                        | "registry_paused"
                        | "registry_sweep_in_progress"
                        | "registry_writer_expired"
                        | "registry_session_superseded"
                        | "registry_session_closed"
                        | "registry_admission_denied",
                    ),
                ) => EXIT_TRANSIENT,
                _ => 1,
            }
        }
        _ => 1,
    };
    anyhow!(UploadFailed {
        exit_code,
        message: format!("the image push failed: {error}"),
    })
}
