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

    /// Removes the file, if there is one.
    pub(crate) fn forget(dir: &Path) -> Result<()> {
        let path = dir.join(IMAGE_FILE);
        match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err(error).with_context(|| format!("failed to remove {}", path.display()))
            }
            _ => Ok(()),
        }
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
    /// The run's GitHub Actions OIDC token.
    #[arg(long)]
    token: String,
    /// The rev `plan` uploaded the bundle as.
    #[arg(long)]
    rev: String,
}

pub(crate) fn push_command(args: &PushCommand) -> Result<()> {
    let built = BuiltImage::read(&args.image)?;
    let architecture = match built.arch.as_str() {
        "amd64" => Architecture::Amd64,
        "arm64" => Architecture::Arm64,
        other => anyhow::bail!("{IMAGE_FILE} names the architecture '{other}'"),
    };
    let session = PipelineSession::open(&args.url, &args.token, &args.rev).map_err(failed)?;
    let pushed = RegistryPusher::new(&args.url, session.token())
        .and_then(|pusher| {
            pusher.push_image(
                &args.image,
                &built.manifest,
                built.build_key.hex(),
                architecture,
            )
        })
        .map_err(failed);
    // Its place among the source's open sessions is freed either way; a close
    // that fails does not undo a recorded image.
    if let Err(error) = session.close() {
        eprintln!("warning: the upload session did not close: {error}");
    }
    let recorded = pushed?;
    println!(
        "image={} recorded={}",
        recorded.image.as_str(),
        if recorded.first { "first" } else { "existing" }
    );
    Ok(())
}

/// A failed push with the exit code a workflow acts on: 3 when the commit is
/// no longer the one to build for, 75 when trying again may pass. Only the
/// session open says 3: a session that ends while the push runs is refused as
/// unauthorized, and the next open tells why.
pub(crate) fn failed(error: UploadError) -> anyhow::Error {
    let exit_code = match &error {
        UploadError::Http(error) if error.is_builder() => 1,
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
