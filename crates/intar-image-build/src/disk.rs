use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context as _, Result, bail};

use crate::config::QemuBuildConfig;

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ScenarioDiskCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ScenarioDiskPlan {
    pub base_ext4_path: PathBuf,
    pub root_disk_path: PathBuf,
    pub virtual_size_bytes: u64,
    pub commands: Vec<ScenarioDiskCommand>,
}

#[must_use]
pub fn render_scenario_disk_plan(
    base_ext4_path: &Path,
    root_disk_path: &Path,
    disk_gib: u32,
    config: &QemuBuildConfig,
) -> ScenarioDiskPlan {
    let virtual_size_bytes = u64::from(disk_gib) * 1024 * 1024 * 1024;
    ScenarioDiskPlan {
        base_ext4_path: base_ext4_path.to_path_buf(),
        root_disk_path: root_disk_path.to_path_buf(),
        virtual_size_bytes,
        commands: vec![
            ScenarioDiskCommand {
                program: config.e2fsck_binary.clone(),
                args: vec!["-fy".to_string(), root_disk_path.display().to_string()],
            },
            ScenarioDiskCommand {
                program: config.resize2fs_binary.clone(),
                args: vec![root_disk_path.display().to_string()],
            },
        ],
    }
}

/// Prepare a raw ext4 root disk for a scenario VM.
///
/// # Errors
/// Returns an error if the base image cannot be copied or filesystem tools fail.
pub fn prepare_scenario_disk(plan: &ScenarioDiskPlan) -> Result<()> {
    if let Some(parent) = plan.root_disk_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create '{}'", parent.display()))?;
    }
    fs::copy(&plan.base_ext4_path, &plan.root_disk_path).with_context(|| {
        format!(
            "failed to copy base ext4 '{}' to '{}'",
            plan.base_ext4_path.display(),
            plan.root_disk_path.display()
        )
    })?;
    let root_disk = fs::OpenOptions::new()
        .write(true)
        .open(&plan.root_disk_path)
        .with_context(|| format!("failed to open '{}'", plan.root_disk_path.display()))?;
    root_disk
        .set_len(plan.virtual_size_bytes)
        .with_context(|| {
            format!(
                "failed to resize raw root disk '{}'",
                plan.root_disk_path.display()
            )
        })?;
    drop(root_disk);

    for command in &plan.commands {
        run_command(command)?;
    }
    Ok(())
}

fn run_command(command: &ScenarioDiskCommand) -> Result<()> {
    let status = Command::new(&command.program)
        .args(&command.args)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .with_context(|| format!("failed to execute '{}'", command.program.display()))?;
    if status.success() {
        return Ok(());
    }
    bail!(
        "command '{}' failed with status {status}",
        command.program.display()
    )
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::path::Path;

    use super::render_scenario_disk_plan;
    use crate::config::QemuBuildConfig;

    #[test]
    fn disk_plan_copies_base_and_resizes_ext4_raw_disk() {
        let config = QemuBuildConfig {
            e2fsck_binary: "/sbin/e2fsck".into(),
            resize2fs_binary: "/sbin/resize2fs".into(),
            ..QemuBuildConfig::default()
        };

        let plan = render_scenario_disk_plan(
            Path::new("/cache/base.ext4"),
            Path::new("/work/root.raw"),
            6,
            &config,
        );

        assert_eq!(plan.base_ext4_path, Path::new("/cache/base.ext4"));
        assert_eq!(plan.root_disk_path, Path::new("/work/root.raw"));
        assert_eq!(plan.virtual_size_bytes, 6 * 1024 * 1024 * 1024);
        assert_eq!(plan.commands[0].program, Path::new("/sbin/e2fsck"));
        assert_eq!(plan.commands[0].args, vec!["-fy", "/work/root.raw"]);
        assert_eq!(plan.commands[1].program, Path::new("/sbin/resize2fs"));
        assert_eq!(plan.commands[1].args, vec!["/work/root.raw"]);
    }
}
