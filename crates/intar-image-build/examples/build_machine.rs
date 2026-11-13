//! Developer tool for the image format 3 build (Linux/KVM):
//!
//! ```text
//! build_machine build <repo dir | bundle.json.gz> <base | image:NAME | SCENARIO/MACHINE> <out dir> [config.hcl] [sha256:KEY]
//! build_machine verify <out dir> <sha256:MANIFEST>
//! build_machine reconstruct <out dir> <sha256:MANIFEST> <disk.raw>
//! ```
//!
//! `config.hcl` is the builder's `BuildConfig` (a `qemu { … }` block).

use std::io::Read as _;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};
use intar_contracts::oci::OciDigest;
use intar_contracts::source::SourceBundleV2;
use intar_image_build::{
    BuildConfig, BuildTarget, MachineBuildRequest, build_machine_image, reconstruct_machine_disk,
    verify_machine_image,
};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["build", source, target, out, rest @ ..] => {
            let config = match rest.first() {
                Some(path) => BuildConfig::from_file(Path::new(path))?.qemu,
                None => BuildConfig::default().qemu,
            };
            let expected_key = rest.get(1).map(|key| digest(key)).transpose()?;
            let output = build_machine_image(&MachineBuildRequest {
                bundle: bundle(Path::new(source))?,
                target: target_of(target)?,
                expected_key,
                config,
                output_dir: PathBuf::from(out),
            })?;
            let image = &output.image;
            verify_machine_image(Path::new(out), &image.manifest_digest)?;
            println!("build_key={}", output.plan.build_key.as_str());
            println!("manifest={}", image.manifest_digest.as_str());
            println!(
                "stages={} disk_bytes={} chunks={} chunk_layers={} manifest_bytes={} config_bytes={}",
                output.plan.stages.len(),
                image.disk_bytes,
                image.chunk_count,
                image.chunk_layers,
                image.manifest_bytes,
                image.config_bytes
            );
            println!(
                "base_s={:.1} build_s={:.1} output_s={:.1} log={}",
                output.base_seconds,
                output.build_seconds,
                output.output_seconds,
                output.log_path.display()
            );
            Ok(())
        }
        ["verify", out, manifest] => {
            let image = verify_machine_image(Path::new(out), &digest(manifest)?)?;
            println!(
                "ok build_key={} chunks={} layers={}",
                image.config.build_key.as_str(),
                image.config.disk.chunks.len(),
                image.manifest.layers.len()
            );
            Ok(())
        }
        ["reconstruct", out, manifest, raw] => {
            reconstruct_machine_disk(Path::new(out), &digest(manifest)?, Path::new(raw))
        }
        _ => bail!("usage: see the header of examples/build_machine.rs"),
    }
}

fn digest(text: &str) -> Result<OciDigest> {
    OciDigest::try_from(text.to_owned()).map_err(anyhow::Error::msg)
}

fn target_of(text: &str) -> Result<BuildTarget> {
    if text == "base" {
        return Ok(BuildTarget::Base);
    }
    if let Some(name) = text.strip_prefix("image:") {
        return Ok(BuildTarget::Image(name.to_owned()));
    }
    let (scenario, machine) = text
        .split_once('/')
        .context("a target is base, image:NAME or SCENARIO/MACHINE")?;
    Ok(BuildTarget::Machine {
        scenario: scenario.to_owned(),
        machine: machine.to_owned(),
    })
}

/// A repository is compiled; a file is a gzipped bundle.
fn bundle(source: &Path) -> Result<SourceBundleV2> {
    if source.is_dir() {
        return intar_image_scenario::loader::compile(source)
            .map(|(bundle, _)| bundle)
            .map_err(|problems| anyhow::anyhow!("{problems:?}"));
    }
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(std::fs::File::open(source)?).read_to_end(&mut json)?;
    serde_json::from_slice(&json).context("not a v2 bundle")
}
