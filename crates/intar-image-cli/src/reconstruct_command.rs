use std::fs;
use std::path::PathBuf;

use anyhow::{Context as _, Result};
use clap::Args;
use intar_contracts::catalog::ImageChunkManifestV1;
use intar_image_build::reconstruct_chunked_image;

#[derive(Debug, Args)]
pub struct ReconstructCommand {
    #[arg(long)]
    chunk_manifest: PathBuf,
    #[arg(long)]
    chunks_dir: PathBuf,
    #[arg(long)]
    output: PathBuf,
}

pub fn reconstruct(args: &ReconstructCommand) -> Result<()> {
    let manifest: ImageChunkManifestV1 = serde_json::from_slice(
        &fs::read(&args.chunk_manifest)
            .with_context(|| format!("failed to read '{}'", args.chunk_manifest.display()))?,
    )
    .context("failed to parse image chunk manifest")?;
    reconstruct_chunked_image(&manifest, &args.output, |chunk| {
        args.chunks_dir
            .join(format!("{}.raw.zst", chunk.raw_sha256))
    })?;
    println!("reconstructed {}", args.output.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Seek as _, SeekFrom, Write as _};

    use super::*;

    #[test]
    fn reconstructs_local_chunks_without_overwriting_an_existing_disk() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let raw = directory.path().join("source.raw");
        let mut file = fs::File::create(&raw)?;
        file.set_len(8 * 1024 * 1024)?;
        file.seek(SeekFrom::Start(4 * 1024 * 1024 + 512))?;
        file.write_all(b"intar reconstructed image")?;
        drop(file);

        let args = ReconstructCommand {
            chunk_manifest: directory.path().join("image.chunks.json"),
            chunks_dir: directory.path().join("chunks"),
            output: directory.path().join("reconstructed.raw"),
        };
        intar_image_build::write_chunked_image_artifact(
            &raw,
            &args.chunks_dir,
            &args.chunk_manifest,
        )?;
        reconstruct(&args)?;
        let expected = fs::read(&raw)?;
        assert_eq!(fs::read(&args.output)?, expected);
        assert!(reconstruct(&args).is_err());
        assert_eq!(fs::read(&args.output)?, expected);
        Ok(())
    }
}
