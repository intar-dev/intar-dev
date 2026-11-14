//! Developer tool for the image format 3 build (Linux/KVM):
//!
//! ```text
//! build_machine build <bundle.json.gz> <base | image:NAME | SCENARIO/MACHINE> <out dir> [qemu.json] [sha256:KEY]
//! build_machine verify <out dir> <sha256:MANIFEST>
//! build_machine reconstruct <out dir> <sha256:MANIFEST> <disk.raw>
//! build_machine wake-ram <out dir> <sha256:MANIFEST> <ram>
//! ```
//!
//! `wake-ram` writes the RAM file a wake image wakes from: the base's chunks,
//! and on a pack its delta applied to them.
//!
//! `qemu.json` is a `QemuBuildConfig`; make the bundle with `intar-image-cli bundle`.

use std::io::Read as _;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};
use intar_contracts::oci::OciDigest;
use intar_contracts::source::SourceBundleV2;
use intar_image_build::{
    BuildTarget, MachineBuildRequest, QemuBuildConfig, WAKE_CHILD_ARG, build_machine_image,
    reconstruct_machine_disk, run_wake_child, verify_machine_image,
};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        [child, job] if *child == WAKE_CHILD_ARG => run_wake_child(Path::new(job)),
        ["build", source, target, out, rest @ ..] => {
            let config = match rest.first() {
                Some(path) => serde_json::from_slice(&std::fs::read(path)?)?,
                None => QemuBuildConfig::default(),
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
                "ok build_key={} chunks={} layers={} wake={}",
                image.config.build_key.as_str(),
                image.config.disk.chunks.len(),
                image.manifest.layers.len(),
                image
                    .config
                    .wake
                    .as_ref()
                    .map_or("none".to_owned(), |wake| format!(
                        "ram_chunks={} pack={}",
                        wake.ram.chunks.len(),
                        wake.pack.is_some()
                    ))
            );
            Ok(())
        }
        ["reconstruct", out, manifest, raw] => {
            reconstruct_machine_disk(Path::new(out), &digest(manifest)?, Path::new(raw))
        }
        ["wake-ram", out, manifest, ram] => {
            wake_ram(Path::new(out), &digest(manifest)?, Path::new(ram))
        }
        _ => bail!("usage: see the header of examples/build_machine.rs"),
    }
}

fn wake_ram(out: &Path, manifest: &OciDigest, ram: &Path) -> Result<()> {
    use std::io::{Seek as _, SeekFrom, Write as _};
    let image = verify_machine_image(out, manifest)?;
    let wake = image.config.wake.context("not a wake image")?;
    let blob = |index: u32| -> Result<Vec<u8>> {
        let layer = &image.manifest.layers[index as usize];
        Ok(std::fs::read(out.join("sha256").join(layer.digest.hex()))?)
    };
    let base = if wake.pack.is_some() {
        ram.with_extension("base")
    } else {
        ram.to_path_buf()
    };
    let mut file = std::fs::File::create(&base)?;
    file.set_len(wake.ram.size_bytes)?;
    for (index, layer, _) in &wake.ram.chunks {
        file.seek(SeekFrom::Start(index * wake.ram.chunk_size))?;
        file.write_all(&zstd::stream::decode_all(blob(*layer)?.as_slice())?)?;
    }
    drop(file);
    if wake.pack.is_some() {
        let delta = ram.with_extension("delta");
        let mut parts = std::fs::File::create(&delta)?;
        for layer in &image.manifest.layers {
            if layer.media_type == intar_contracts::oci::WAKE_DELTA_MEDIA_TYPE {
                parts.write_all(&std::fs::read(out.join("sha256").join(layer.digest.hex()))?)?;
            }
        }
        drop(parts);
        let threads = std::thread::available_parallelism().map_or(1, usize::from);
        intar_snapdelta::apply(&base, &delta, ram, threads)?;
        std::fs::remove_file(&delta)?;
        std::fs::remove_file(&base)?;
    }
    Ok(())
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

/// A gzipped bundle, as `intar-image-cli bundle` writes it.
fn bundle(source: &Path) -> Result<SourceBundleV2> {
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(std::fs::File::open(source)?).read_to_end(&mut json)?;
    serde_json::from_slice(&json).context("not a v2 bundle")
}
