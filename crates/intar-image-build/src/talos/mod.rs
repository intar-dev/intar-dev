//! A Talos cluster's images from a `SourceBundleV2`: one build bakes every
//! node of the cluster together (they share its PKI), then builds the
//! management machine with the cluster's credentials. One architecture per
//! build; a cluster's images of one architecture are only ever recorded
//! together.

mod assets;
mod bake;
mod configs;

use std::collections::BTreeMap;
use std::fs;
use std::io::Write as _;
use std::net::Ipv4Addr;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail, ensure};
use intar_contracts::guest::GUEST_USERNAME;
use intar_contracts::oci::{MachineTalosV1, OciDigest};
use intar_contracts::scenario::{ClusterRole, ClusterV1, build_keys, cluster_lab_ips};
use intar_contracts::source::{SourceBundleV2, validate_bundle};

use crate::config::{BuildArch, QemuBuildConfig};
use crate::machine::output::{ImageBoot, write_image};
use crate::machine::plan::plan_cluster_management;
use crate::machine::vm::{PostStageStep, build_disk};
use crate::machine::{MachineImage, build_arch, write_machine_image};
use crate::platform::ensure_platform_base;

/// One cluster build: a cluster of a bundle's scenario, the cluster key the
/// caller expects, and where the images go.
#[derive(Clone, Debug)]
pub struct ClusterBuildRequest {
    pub bundle: SourceBundleV2,
    pub scenario: String,
    pub cluster: String,
    /// Refuse when the bundle builds another cluster key.
    pub expected_key: Option<OciDigest>,
    pub config: QemuBuildConfig,
    /// `sha256/<hex>` blobs land here.
    pub output_dir: PathBuf,
}

/// Every image of a cluster for one architecture, by machine name.
#[derive(Clone, Debug)]
pub struct ClusterBuildOutput {
    pub cluster_key: OciDigest,
    /// Each machine's derived key and image.
    pub images: BTreeMap<String, (OciDigest, MachineImage)>,
    pub log_path: PathBuf,
    pub bake_seconds: f64,
    /// The cold wake of the baked nodes, within `bake_seconds`.
    pub wake_seconds: f64,
    pub management_seconds: f64,
}

/// A node as the bake runs it.
#[derive(Clone, Debug)]
pub(crate) struct PlannedClusterNode {
    pub name: String,
    pub role: ClusterRole,
    pub ip: Ipv4Addr,
    pub cpus: u32,
    pub memory_mib: u32,
    pub disk_mib: u32,
    pub key: OciDigest,
}

/// A checked cluster build.
#[derive(Clone, Debug)]
pub(crate) struct ClusterPlan {
    pub scenario: String,
    pub cluster: ClusterV1,
    pub cluster_key: OciDigest,
    /// The control plane first, then the workers in scenario order.
    pub nodes: Vec<PlannedClusterNode>,
    pub management: String,
    pub management_key: OciDigest,
    pub management_ip: Ipv4Addr,
}

/// Validate `bundle`, recompute the cluster's keys and refuse when
/// `expected` differs.
pub(crate) fn plan_cluster(
    bundle: &SourceBundleV2,
    scenario: &str,
    cluster: &str,
    expected: Option<&OciDigest>,
) -> Result<ClusterPlan> {
    if let Err(problems) = validate_bundle(bundle) {
        bail!("the bundle is invalid:\n{}", problems.join("\n"));
    }
    let found = bundle
        .scenarios
        .iter()
        .find(|candidate| candidate.slug == scenario)
        .with_context(|| format!("the bundle has no scenario `{scenario}`"))?;
    let spec = found
        .clusters
        .iter()
        .find(|candidate| candidate.name == cluster)
        .with_context(|| format!("scenario `{scenario}` has no cluster `{cluster}`"))?;
    let keys = build_keys(found, &bundle.images).map_err(anyhow::Error::msg)?;
    let cluster_key = keys.clusters.get(cluster).context("cluster key")?.clone();
    if let Some(expected) = expected {
        ensure!(
            *expected == cluster_key,
            "the bundle builds cluster {}, not the requested {}",
            cluster_key.as_str(),
            expected.as_str()
        );
    }
    let ips = cluster_lab_ips(found, cluster);
    let mut nodes = Vec::new();
    let mut management = None;
    for machine in &found.machines {
        let Some(member) = machine.cluster.as_ref().filter(|m| m.cluster == cluster) else {
            continue;
        };
        let key = keys
            .machines
            .get(&machine.name)
            .context("machine key")?
            .clone();
        if member.role == ClusterRole::Management {
            management = Some((machine.name.clone(), key));
            continue;
        }
        nodes.push(PlannedClusterNode {
            name: machine.name.clone(),
            role: member.role,
            ip: *ips.get(&machine.name).context("lab address")?,
            cpus: machine.cpu_millis.div_ceil(1000).max(1),
            memory_mib: machine.memory_mib,
            disk_mib: machine.disk_mib,
            key,
        });
    }
    // The control planes boot first, in scenario order, and are shut down
    // last; the first is the endpoint.
    nodes.sort_by_key(|node| node.role != ClusterRole::Controlplane);
    let (management, management_key) =
        management.context("the cluster has no management machine")?;
    let management_ip = *ips.get(&management).context("lab address")?;
    Ok(ClusterPlan {
        scenario: scenario.to_owned(),
        cluster: spec.clone(),
        cluster_key,
        nodes,
        management,
        management_key,
        management_ip,
    })
}

/// The kernel command line a Talos node boots with; runtimes append their
/// own (`ip=` on a platform host).
pub(crate) fn node_cmdline(arch: BuildArch) -> String {
    format!(
        "talos.platform=metal console={} loglevel=3 slab_nomerge pti=on printk.devkmsg=on sysctl.kernel.kexec_load_disabled=1 net.ifnames=0",
        arch.console()
    )
}

/// The build log of `cluster_key` under `work_root`.
#[must_use]
pub fn cluster_build_log_path(work_root: &Path, cluster_key: &OciDigest) -> PathBuf {
    work_root.join(format!("cluster-{}.build.log", cluster_key.hex()))
}

/// Bake the cluster, write every node's image, then build and write the
/// management machine's.
///
/// # Errors
/// Returns an error when the plan is refused or any step fails; nothing is
/// returned for a cluster that did not build completely.
pub fn build_cluster_images(request: &ClusterBuildRequest) -> Result<ClusterBuildOutput> {
    let plan = plan_cluster(
        &request.bundle,
        &request.scenario,
        &request.cluster,
        request.expected_key.as_ref(),
    )?;
    let config = &request.config;
    let arch = build_arch(config)?;
    let host = BuildArch::host().context("the builder's architecture has no images")?;
    fs::create_dir_all(&config.work_root)?;
    fs::create_dir_all(&request.output_dir)?;
    let log_path = cluster_build_log_path(&config.work_root, &plan.cluster_key);
    fs::write(
        &log_path,
        format!("== cluster {} ==\n", plan.cluster_key.as_str()),
    )?;
    let cache = config
        .layered
        .talos_cache_root
        .clone()
        .unwrap_or_else(|| config.work_root.join("talos-cache"));
    let files = assets::release_files(
        &cache,
        &plan.cluster.talos,
        &plan.cluster.kubernetes,
        arch,
        host,
    )?;
    let work = tempfile::Builder::new()
        .prefix("cluster-")
        .tempdir_in(&config.work_root)?;
    fs::set_permissions(work.path(), fs::Permissions::from_mode(0o700))?;

    let started = Instant::now();
    let baked = bake::bake(&plan, &files, config, arch, work.path(), &log_path)?;
    let wake_seconds = bake::wake(&plan, &files, config, arch, work.path(), &log_path, &baked)?;
    let mut images = BTreeMap::new();
    for node in &plan.nodes {
        let raw = baked.disks.get(&node.name).context("baked disk")?;
        let image = write_image(
            raw,
            &files.kernel,
            &files.initramfs,
            &node.key,
            arch,
            ImageBoot {
                cmdline: node_cmdline(arch),
                talos: Some(MachineTalosV1 {
                    role: node.role,
                    lab_ip: node.ip.to_string(),
                }),
            },
            &request.output_dir,
        )?;
        images.insert(node.name.clone(), (node.key.clone(), image));
        // The image holds it now.
        fs::remove_file(raw)?;
    }
    let bake_seconds = started.elapsed().as_secs_f64();

    let started = Instant::now();
    let management = plan_cluster_management(&request.bundle, &plan.scenario, &plan.management)?;
    ensure!(
        management.build_key == plan.management_key,
        "the management machine plans {}, not its cluster key {}",
        management.build_key.as_str(),
        plan.management_key.as_str()
    );
    let base = ensure_platform_base(config)?;
    let step = management_step(&files, &baked, plan.management_ip);
    let management_work = work.path().join("management");
    fs::create_dir_all(&management_work)?;
    let raw = build_disk(
        &management,
        config,
        &base,
        &management_work,
        &log_path.with_extension("management.log"),
        Some(&step),
    )?;
    let image = write_machine_image(
        &raw,
        &base.kernel_path,
        &base.initrd_path,
        &management.build_key,
        arch,
        &request.output_dir,
    )?;
    images.insert(plan.management.clone(), (management.build_key, image));
    Ok(ClusterBuildOutput {
        cluster_key: plan.cluster_key,
        images,
        log_path,
        bake_seconds,
        wake_seconds,
        management_seconds: started.elapsed().as_secs_f64(),
    })
}

/// The management machine's cluster step: kubectl and talosctl, the lab
/// kubeconfig and talosconfig for the guest user, and its lab address at
/// every boot on the NIC with the lab MAC prefix (the desktop's lab NIC), or
/// else on its only physical NIC (a platform host's run NIC, which the lab
/// shares). Virtual devices such as `sit0` are never taken.
fn management_step(
    files: &assets::ReleaseFiles,
    baked: &bake::Baked,
    lab: Ipv4Addr,
) -> PostStageStep {
    let upload =
        |local: &Path, name: &str| (local.to_owned(), format!("/tmp/intar-cluster-{name}"));
    let user = GUEST_USERNAME;
    let prefix = intar_contracts::scenario::CLUSTER_LAB_PREFIX_LEN;
    let mac = intar_contracts::scenario::CLUSTER_LAB_MAC_PREFIX;
    PostStageStep {
        files: vec![
            upload(&files.target_kubectl, "kubectl"),
            upload(&files.target_talosctl, "talosctl"),
            upload(&baked.kubeconfig, "kubeconfig"),
            upload(&baked.talosconfig, "talosconfig"),
        ],
        script: format!(
            r#"set -eu
install -m 0755 /tmp/intar-cluster-kubectl /usr/local/bin/kubectl
install -m 0755 /tmp/intar-cluster-talosctl /usr/local/bin/talosctl
install -d -m 0700 -o {user} -g {user} /home/{user}/.kube /home/{user}/.talos
install -m 0600 -o {user} -g {user} /tmp/intar-cluster-kubeconfig /home/{user}/.kube/config
install -m 0600 -o {user} -g {user} /tmp/intar-cluster-talosconfig /home/{user}/.talos/config
install -d -m 0700 /root/.kube /root/.talos
install -m 0600 /tmp/intar-cluster-kubeconfig /root/.kube/config
install -m 0600 /tmp/intar-cluster-talosconfig /root/.talos/config
# Kino runs the checks as root with no HOME, where kubectl and talosctl
# look for their configs.
install -d /etc/systemd/system/intar.service.d
printf '[Service]\nEnvironment=HOME=/root\n' > /etc/systemd/system/intar.service.d/cluster-home.conf
rm -f /tmp/intar-cluster-*
cat > /usr/local/sbin/intar-cluster-lab-address <<'EOF'
#!/bin/sh
set -u
# udev may rename the NIC under us (eth0 -> ens5): pick it again until the
# address is on.
try=0
while :; do
  nic=""
  first=""
  for dev in /sys/class/net/*; do
    [ -e "$dev/device" ] || continue
    case "$(cat "$dev/address" 2>/dev/null)" in
      {mac}:*) nic="${{dev##*/}}"; break ;;
    esac
    [ -n "$first" ] || first="${{dev##*/}}"
  done
  nic="${{nic:-$first}}"
  if [ -n "$nic" ] && ip link set dev "$nic" up 2>/dev/null \
    && ip address replace {lab}/{prefix} dev "$nic" 2>/dev/null; then
    exit 0
  fi
  try=$((try + 1))
  [ "$try" -lt 100 ] || {{ echo "no NIC took the lab address" >&2; exit 1; }}
  sleep 0.1
done
EOF
chmod 0755 /usr/local/sbin/intar-cluster-lab-address
cat > /etc/systemd/system/intar-cluster-lab.service <<'EOF'
[Unit]
Description=Address on the cluster's lab network
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/intar-cluster-lab-address

[Install]
WantedBy=multi-user.target
EOF
systemctl enable intar-cluster-lab.service
"#
        ),
    }
}

/// A command-line tool the bake drives, with its home and config inside
/// the build's work directory and every call logged.
pub(crate) struct Tool {
    binary: PathBuf,
    env: Vec<(&'static str, PathBuf)>,
    log: PathBuf,
}

impl Tool {
    pub(crate) fn new(
        binary: &Path,
        home: &Path,
        env: Vec<(&'static str, PathBuf)>,
        log: &Path,
    ) -> Self {
        let mut env = env;
        env.push(("HOME", home.to_owned()));
        Self {
            binary: binary.to_owned(),
            env,
            log: log.to_owned(),
        }
    }

    /// Its stdout, or an error with its stderr.
    pub(crate) fn run(&self, args: &[&str]) -> Result<String> {
        let output = Command::new(&self.binary)
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .envs(
                self.env
                    .iter()
                    .map(|(name, value)| (*name, value.as_os_str())),
            )
            .output()
            .with_context(|| format!("failed to run {}", self.binary.display()))?;
        let name = self
            .binary
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        let mut log = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&self.log)?;
        writeln!(
            log,
            "$ {name} {}\n{}{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )?;
        ensure!(
            output.status.success(),
            "{name} {} failed: {}",
            args.first().copied().unwrap_or_default(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// [`Tool::run`] again every two seconds until it succeeds or
    /// `deadline` passes.
    pub(crate) fn retry(&self, args: &[&str], deadline: Instant, what: &str) -> Result<String> {
        loop {
            match self.run(args) {
                Ok(out) => return Ok(out),
                Err(error) if Instant::now() + Duration::from_secs(2) >= deadline => {
                    return Err(error.context(format!("{what} timed out")));
                }
                Err(_) => thread::sleep(Duration::from_secs(2)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cluster_plan_orders_the_control_plane_first_and_checks_its_key() {
        let bundle = crate::machine::plan::tests::clustered();
        let plan = plan_cluster(&bundle, "broken-nginx", "lab", None).expect("plans");
        let nodes: Vec<_> = plan
            .nodes
            .iter()
            .map(|node| (node.name.as_str(), node.ip.to_string()))
            .collect();
        assert_eq!(
            nodes,
            [
                ("cp1", "172.31.0.2".to_owned()),
                ("wk1", "172.31.0.3".to_owned())
            ]
        );
        assert_eq!(plan.management, "webserver");
        assert_eq!(plan.management_ip.to_string(), "172.31.0.14");
        let wrong = intar_contracts::scenario::base_key();
        assert!(plan_cluster(&bundle, "broken-nginx", "lab", Some(&wrong)).is_err());
        assert!(plan_cluster(&bundle, "broken-nginx", "other", None).is_err());
    }

    #[test]
    fn the_management_step_installs_the_tools_and_credentials() {
        let files = assets::ReleaseFiles {
            kernel: PathBuf::new(),
            initramfs: PathBuf::new(),
            disk_zst: PathBuf::new(),
            host_talosctl: PathBuf::new(),
            host_kubectl: PathBuf::new(),
            target_talosctl: PathBuf::from("/c/talosctl"),
            target_kubectl: PathBuf::from("/c/kubectl"),
        };
        let baked = bake::Baked {
            disks: BTreeMap::new(),
            kubeconfig: PathBuf::from("/c/kubeconfig"),
            talosconfig: PathBuf::from("/c/talosconfig"),
        };
        let step = management_step(&files, &baked, Ipv4Addr::new(172, 31, 0, 14));
        assert_eq!(step.files.len(), 4);
        assert!(
            step.files
                .iter()
                .all(|(_, remote)| remote.starts_with("/tmp/intar-cluster-"))
        );
        assert!(step.script.contains("ip address replace 172.31.0.14/28"));
        assert!(step.script.contains("52:54:00:31:00:*) nic="));
        assert!(step.script.contains("[ -e \"$dev/device\" ] || continue"));
        assert!(
            step.script
                .contains(&format!("/home/{GUEST_USERNAME}/.kube/config"))
        );
        // Kino runs ready and task checks as root.
        assert!(step.script.contains("/root/.kube/config"));
        assert!(step.script.contains("Environment=HOME=/root"));
        assert!(step.script.contains("[ \"$try\" -lt 100 ]"));
        assert!(step.script.contains("rm -f /tmp/intar-cluster-*"));
    }

    #[test]
    fn a_node_boots_talos_on_its_console() {
        assert!(node_cmdline(BuildArch::Arm64).contains("console=ttyAMA0"));
        assert!(node_cmdline(BuildArch::Amd64).starts_with("talos.platform=metal console=ttyS0 "));
    }
}
