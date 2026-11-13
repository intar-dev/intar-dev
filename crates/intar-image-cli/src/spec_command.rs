//! `spec`: what a machine's Kino receives, with every check lowered, plus
//! the lowered setup stages. It loads the repository with the new loader, so
//! it fails with every problem `validate` will report.

use anyhow::{Context, bail};
use clap::Args;
use intar_contracts::scenario::SpecMode;
use intar_image_scenario::loader::load_repository;
use std::path::PathBuf;

#[derive(Debug, Args)]
pub(crate) struct SpecCommand {
    /// The scenario's slug, the directory name under `scenarios/`.
    slug: String,
    /// One machine instead of all.
    #[arg(long)]
    machine: Option<String>,
    /// The verify spec, with the solve scripts.
    #[arg(long)]
    verify: bool,
    /// The repository root.
    #[arg(long, default_value = ".")]
    root: PathBuf,
}

pub(crate) fn spec_command(args: &SpecCommand) -> anyhow::Result<()> {
    let repository = match load_repository(&args.root) {
        Ok(repository) => repository,
        Err(problems) => {
            for problem in &problems {
                eprintln!("{problem}");
            }
            bail!("{} problem(s)", problems.len());
        }
    };
    let scenario = repository
        .scenarios
        .iter()
        .find(|scenario| scenario.slug == args.slug)
        .with_context(|| format!("no scenario `{}`", args.slug))?;
    let mode = if args.verify {
        SpecMode::Verify
    } else {
        SpecMode::Learn
    };
    let machines: Vec<_> = scenario
        .machines
        .iter()
        .filter(|machine| {
            args.machine
                .as_ref()
                .is_none_or(|name| *name == machine.name)
        })
        .collect();
    if machines.is_empty() {
        bail!("no such machine in `{}`", args.slug);
    }
    for machine in machines {
        // The namespace comes from the repository's binding; `-` stands in.
        let spec = scenario.machine_spec(&format!("-/{}", scenario.slug), &machine.name, mode);
        println!("# machine {}: spec", machine.name);
        println!("{}", serde_json::to_string_pretty(&spec)?);
        for stage in &machine.setup {
            println!("# machine {}: setup {}", machine.name, stage.name);
            print!("{}", stage.script);
            if !stage.script.ends_with('\n') {
                println!();
            }
        }
    }
    Ok(())
}
