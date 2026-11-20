//! `intar-image-cli plan`: the first step of a scenario repository's pipeline
//! (#441). It uploads the bundle as `bundle` does and prints which images the
//! pipeline has to build: the receipt's missing keys, each as a target of
//! `build`.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Args;
use intar_contracts::scenario::build_keys;
use intar_contracts::source::SourceBundleV2;
use intar_image_scenario::loader::{compile, encode_bundle};

use crate::bundle_command::{
    BundleUploadTarget, PipelineReceipt, default_bundle_output_path, default_bundle_rev,
    upload_bundle, validate_bundle_rev,
};

#[derive(Debug, Args)]
pub(crate) struct PlanCommand {
    /// The bundles route to upload to.
    #[arg(long)]
    url: String,
    /// The bearer token of the upload.
    #[arg(long)]
    token: String,
    /// Defaults to the first 12 hex digits of GITHUB_SHA or HEAD.
    #[arg(long)]
    rev: Option<String>,
    /// Defaults to dist/bundles/<rev>.json.gz.
    #[arg(long)]
    output: Option<PathBuf>,
    /// Also append `rev`, `producer`, `images=<json>` and `jobs=<json>` to
    /// this file, as a workflow step's outputs (`$GITHUB_OUTPUT`).
    #[arg(long)]
    github_output: Option<PathBuf>,
    /// The repository root.
    #[arg(long, default_value = ".")]
    root: PathBuf,
}

/// One image in one architecture.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct Job {
    target: String,
    build_key: String,
    arch: String,
}

/// One image with every architecture it is missing in.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct Image {
    target: String,
    build_key: String,
    archs: Vec<String>,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct Plan {
    rev: String,
    /// Who builds this commit's images: `pipeline`, or `builder` with nothing to do here.
    producer: &'static str,
    jobs: Vec<Job>,
    images: Vec<Image>,
}

/// The missing images as targets: for each key the first `SCENARIO/MACHINE`
/// of the bundle that has it, so `build` always has a lab to boot.
pub(crate) fn plan_of(
    bundle: &SourceBundleV2,
    rev: &str,
    receipt: Option<&PipelineReceipt>,
) -> Result<Plan> {
    let Some(receipt) = receipt else {
        return Ok(Plan {
            rev: rev.to_owned(),
            producer: "builder",
            jobs: Vec::new(),
            images: Vec::new(),
        });
    };
    let mut targets = BTreeMap::new();
    for scenario in &bundle.scenarios {
        let keys = build_keys(scenario, &bundle.images).map_err(anyhow::Error::msg)?;
        for machine in &scenario.machines {
            if let Some(key) = keys.machines.get(&machine.name) {
                targets
                    .entry(key.as_str().to_owned())
                    .or_insert_with(|| format!("{}/{}", scenario.slug, machine.name));
            }
        }
    }
    let mut jobs = Vec::new();
    let mut images: Vec<Image> = Vec::new();
    for missing in &receipt.missing {
        let target = targets.get(&missing.build_key).with_context(|| {
            format!(
                "the service asks for image {} which no machine of this commit has",
                missing.build_key
            )
        })?;
        jobs.push(Job {
            target: target.clone(),
            build_key: missing.build_key.clone(),
            arch: missing.architecture.clone(),
        });
        match images
            .iter_mut()
            .find(|image| image.build_key == missing.build_key)
        {
            Some(image) => image.archs.push(missing.architecture.clone()),
            None => images.push(Image {
                target: target.clone(),
                build_key: missing.build_key.clone(),
                archs: vec![missing.architecture.clone()],
            }),
        }
    }
    Ok(Plan {
        rev: rev.to_owned(),
        producer: "pipeline",
        jobs,
        images,
    })
}

pub(crate) fn plan_command(args: &PlanCommand) -> Result<()> {
    let rev = match &args.rev {
        Some(rev) => rev.clone(),
        None => default_bundle_rev()?,
    };
    validate_bundle_rev(&rev)?;
    let target = BundleUploadTarget::new(&args.url, Some(&args.token))?;
    let (bundle, _) = compile(&args.root).map_err(|problems| crate::report(&problems))?;
    let encoded = encode_bundle(&bundle).map_err(anyhow::Error::msg)?;
    let output = args
        .output
        .clone()
        .unwrap_or_else(|| default_bundle_output_path(&rev));
    if let Some(parent) = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    std::fs::write(&output, &encoded)
        .with_context(|| format!("failed to create {}", output.display()))?;
    let receipt = upload_bundle(&target, &output, &rev)?;
    let plan = plan_of(&bundle, &rev, receipt.pipeline.as_ref())?;
    println!("{}", serde_json::to_string(&plan)?);
    if let Some(path) = &args.github_output {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .with_context(|| format!("failed to open {}", path.display()))?;
        writeln!(file, "rev={}", plan.rev)?;
        writeln!(file, "producer={}", plan.producer)?;
        writeln!(file, "images={}", serde_json::to_string(&plan.images)?)?;
        writeln!(file, "jobs={}", serde_json::to_string(&plan.jobs)?)?;
    }
    Ok(())
}
