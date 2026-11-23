//! The bake: every node of a cluster boots once on a private lab network,
//! gets its config, the control plane bootstraps, the cluster comes up
//! healthy, and every node shuts down cleanly. Its disks are what runs boot.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail, ensure};
use dhd::lab_hub::LabHub;
use intar_contracts::scenario::{CLUSTER_LAB_MAC_PREFIX, ClusterRole};

use super::assets::ReleaseFiles;
use super::configs::{self, controlplane_ip};
use super::{ClusterPlan, PlannedClusterNode, Tool, node_cmdline};
use crate::config::{BuildArch, QemuBuildConfig};
use crate::qemu::machine_and_cpu;

const GIB: u64 = 1024 * 1024 * 1024;
/// What a node's disk takes on the host while it bakes: Talos and the
/// cluster's images, sparse.
const NODE_DISK_BUDGET: u64 = 3 * GIB;
/// How long a healthy cluster settles before it is shut down.
const SETTLE: Duration = Duration::from_secs(30);

/// A baked cluster: each node's raw disk, and the client configs the
/// management machine gets (lab addresses, long-lived certificates).
pub(crate) struct Baked {
    pub disks: BTreeMap<String, PathBuf>,
    pub kubeconfig: PathBuf,
    pub talosconfig: PathBuf,
}

/// A node's QEMU, killed when dropped unless it exited on its own.
struct NodeVm {
    name: String,
    child: Child,
    exited: bool,
}

impl Drop for NodeVm {
    fn drop(&mut self) {
        if !self.exited {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

pub(crate) fn bake(
    plan: &ClusterPlan,
    files: &ReleaseFiles,
    config: &QemuBuildConfig,
    arch: BuildArch,
    work: &Path,
    log: &Path,
) -> Result<Baked> {
    let deadline = Instant::now() + Duration::from_secs(config.provision_timeout_seconds.max(1));
    let free = fs2::available_space(work)?;
    let needed = NODE_DISK_BUDGET * plan.nodes.len() as u64;
    ensure!(
        free >= needed,
        "a bake of {} nodes needs {} GiB free in {}, not {} GiB",
        plan.nodes.len(),
        needed / GIB,
        work.display(),
        free / GIB
    );
    let home = work.join("home");
    let config_dir = work.join("configs");
    fs::create_dir_all(&home)?;
    fs::create_dir_all(&config_dir)?;
    let talosconfig = config_dir.join("talosconfig");
    let talosctl = Tool::new(
        &files.host_talosctl,
        &home,
        vec![("TALOSCONFIG", talosconfig.clone())],
        log,
    );
    let base = configs::generate(&talosctl, &plan.cluster, &config_dir)?;
    let mut node_configs = BTreeMap::new();
    for node in &plan.nodes {
        let role_base = match node.role {
            ClusterRole::Controlplane => &base.controlplane,
            _ => &base.worker,
        };
        let file = configs::node_config(&talosctl, role_base, &node.name, node.ip, &config_dir)?;
        node_configs.insert(node.name.clone(), file);
    }

    let hub = LabHub::start(&work.join("lab.sock"))?;
    let mut disks = BTreeMap::new();
    let mut vms = Vec::new();
    let mut api_ports = BTreeMap::new();
    let mut k8s_port = None;
    for (index, node) in plan.nodes.iter().enumerate() {
        let disk = work.join(format!("{}.raw", node.name));
        sparse_unpack(
            &files.disk_zst,
            &disk,
            u64::from(node.disk_mib) * 1024 * 1024,
        )?;
        let serial = log.with_extension(format!("{}.serial.log", node.name));
        let controlplane = node.role == ClusterRole::Controlplane;
        let launch = NodeLaunch {
            node,
            index,
            disk: &disk,
            serial: &serial,
            snapshot: false,
        };
        let (vm, api, k8s) = spawn_node(&launch, files, config, arch, hub.path(), work)?;
        api_ports.insert(node.name.clone(), api);
        // The first control plane is the endpoint.
        if controlplane && k8s_port.is_none() {
            k8s_port = k8s;
        }
        vms.push(vm);
        disks.insert(node.name.clone(), disk);
    }
    let k8s_port = k8s_port.context("the cluster has no control plane")?;
    let cp_api = plan
        .nodes
        .iter()
        .find(|node| node.role == ClusterRole::Controlplane)
        .and_then(|node| api_ports.get(&node.name))
        .copied()
        .context("the control plane has no API port")?;

    // Maintenance mode answers on each node's own forward, unauthenticated.
    for node in &plan.nodes {
        let local = format!("127.0.0.1:{}", api_ports[&node.name]);
        let file = node_configs[&node.name].display().to_string();
        talosctl.retry(
            &[
                "apply-config",
                "--insecure",
                "-n",
                &local,
                "-e",
                &local,
                "--file",
                &file,
            ],
            deadline,
            &format!("applying the config of `{}`", node.name),
        )?;
    }
    let cp = controlplane_ip().to_string();
    let cp_local = format!("127.0.0.1:{cp_api}");
    talosctl.run(&["config", "endpoint", &cp_local])?;
    talosctl.run(&["config", "node", &cp])?;
    talosctl.retry(&["bootstrap"], deadline, "bootstrapping the control plane")?;

    let lab_kubeconfig = config_dir.join("kubeconfig.lab");
    let lab_kubeconfig_arg = lab_kubeconfig.display().to_string();
    talosctl.retry(
        &["kubeconfig", &lab_kubeconfig_arg, "--force"],
        deadline,
        "fetching the kubeconfig",
    )?;
    let host_kubeconfig = config_dir.join("kubeconfig.host");
    fs::copy(&lab_kubeconfig, &host_kubeconfig)?;
    let kubectl = Tool::new(
        &files.host_kubectl,
        &home,
        vec![("KUBECONFIG", host_kubeconfig)],
        log,
    );
    kubectl.run(&[
        "config",
        "set-cluster",
        &plan.cluster.name,
        &format!("--server=https://127.0.0.1:{k8s_port}"),
        &format!("--tls-server-name={cp}"),
    ])?;
    // Without KubePrism, flannel would reach the API through the service
    // address, which needs kube-proxy first: at wake it crash-loops ~30 s.
    kubectl.retry(
        &[
            "-n",
            "kube-system",
            "set",
            "env",
            "daemonset/kube-flannel",
            &format!("KUBERNETES_SERVICE_HOST={cp}"),
            "KUBERNETES_SERVICE_PORT=6443",
        ],
        deadline,
        "pointing flannel at the control plane",
    )?;
    healthy(&talosctl, plan, deadline)?;
    kubectl.run(&[
        "-n",
        "kube-system",
        "rollout",
        "status",
        "daemonset/kube-flannel",
        &format!("--timeout={}s", remaining(deadline)?.as_secs()),
    ])?;

    // The management machine's talosconfig: its own long-lived client
    // certificate, reaching the control plane on the lab network.
    let lab_talosconfig = config_dir.join("talosconfig.lab");
    let lab_talosconfig_arg = lab_talosconfig.display().to_string();
    talosctl.run(&[
        "config",
        "new",
        &lab_talosconfig_arg,
        "--roles=os:admin",
        "--crt-ttl=87600h",
    ])?;
    let lab_talosctl = Tool::new(
        &files.host_talosctl,
        &home,
        vec![("TALOSCONFIG", lab_talosconfig.clone())],
        log,
    );
    let controlplanes = lab_ips(plan, ClusterRole::Controlplane);
    let mut endpoints = vec!["config", "endpoint"];
    endpoints.extend(controlplanes.iter().map(String::as_str));
    lab_talosctl.run(&endpoints)?;
    lab_talosctl.run(&["config", "node", &cp])?;

    thread::sleep(SETTLE.min(remaining(deadline)?));
    // Workers first, the control plane last; no drain, so pods restart in
    // place at wake.
    for node in plan.nodes.iter().rev() {
        talosctl.run(&[
            "shutdown",
            "--force",
            "--wait=false",
            "-n",
            &node.ip.to_string(),
        ])?;
    }
    let exit_deadline =
        Instant::now() + Duration::from_secs(config.qemu_exit_timeout_seconds.max(1));
    for vm in &mut vms {
        loop {
            if let Some(status) = vm.child.try_wait()? {
                vm.exited = true;
                ensure!(status.success(), "node `{}` exited with {status}", vm.name);
                break;
            }
            if Instant::now() >= exit_deadline {
                bail!("node `{}` did not power off", vm.name);
            }
            thread::sleep(Duration::from_millis(500));
        }
    }
    drop(hub);
    Ok(Baked {
        disks,
        kubeconfig: lab_kubeconfig,
        talosconfig: lab_talosconfig,
    })
}

/// The lab addresses of `plan`'s nodes of `role`, in boot order.
fn lab_ips(plan: &ClusterPlan, role: ClusterRole) -> Vec<String> {
    plan.nodes
        .iter()
        .filter(|node| node.role == role)
        .map(|node| node.ip.to_string())
        .collect()
}

/// `talosctl health` of every node of `plan`, until `deadline`.
fn healthy(talosctl: &Tool, plan: &ClusterPlan, deadline: Instant) -> Result<()> {
    let workers = lab_ips(plan, ClusterRole::Worker);
    let mut health = vec![
        "health".to_owned(),
        format!("--wait-timeout={}s", remaining(deadline)?.as_secs()),
        format!(
            "--control-plane-nodes={}",
            lab_ips(plan, ClusterRole::Controlplane).join(",")
        ),
    ];
    if !workers.is_empty() {
        health.push(format!("--worker-nodes={}", workers.join(",")));
    }
    talosctl.run(&health.iter().map(String::as_str).collect::<Vec<_>>())?;
    Ok(())
}

/// The wake check: the baked disks boot again cold, as a run starts them,
/// on a fresh lab network, and the cluster must come up healthy with every
/// node Ready. Their disks are left as they are. The seconds it took.
pub(crate) fn wake(
    plan: &ClusterPlan,
    files: &ReleaseFiles,
    config: &QemuBuildConfig,
    arch: BuildArch,
    work: &Path,
    log: &Path,
    baked: &Baked,
) -> Result<f64> {
    let started = Instant::now();
    let deadline = started + Duration::from_secs(config.provision_timeout_seconds.max(1));
    let home = work.join("home");
    let config_dir = work.join("configs");
    let talosctl = Tool::new(
        &files.host_talosctl,
        &home,
        vec![("TALOSCONFIG", config_dir.join("talosconfig"))],
        log,
    );
    let hub = LabHub::start(&work.join("wake.sock"))?;
    let mut vms = Vec::new();
    let mut cp_ports = None;
    for (index, node) in plan.nodes.iter().enumerate() {
        let disk = baked.disks.get(&node.name).context("baked disk")?;
        let serial = log.with_extension(format!("{}.wake.serial.log", node.name));
        let launch = NodeLaunch {
            node,
            index,
            disk,
            serial: &serial,
            snapshot: true,
        };
        let (vm, api, k8s) = spawn_node(&launch, files, config, arch, hub.path(), work)?;
        if let Some(k8s) = k8s.filter(|_| cp_ports.is_none()) {
            cp_ports = Some((api, k8s));
        }
        vms.push(vm);
    }
    let (api, k8s) = cp_ports.context("the cluster has no control plane")?;
    talosctl.run(&["config", "endpoint", &format!("127.0.0.1:{api}")])?;
    // `health` gives up at once while the woken node's API is not up yet.
    talosctl.retry(&["version"], deadline, "waking the control plane's API")?;
    healthy(&talosctl, plan, deadline)?;
    let kubectl = Tool::new(
        &files.host_kubectl,
        &home,
        vec![("KUBECONFIG", config_dir.join("kubeconfig.host"))],
        log,
    );
    kubectl.run(&[
        "config",
        "set-cluster",
        &plan.cluster.name,
        &format!("--server=https://127.0.0.1:{k8s}"),
    ])?;
    kubectl.run(&[
        "wait",
        "--for=condition=Ready",
        "nodes",
        "--all",
        &format!("--timeout={}s", remaining(deadline)?.as_secs()),
    ])?;
    let seconds = started.elapsed().as_secs_f64();
    drop(vms);
    drop(hub);
    Ok(seconds)
}

fn remaining(deadline: Instant) -> Result<Duration> {
    let left = deadline.saturating_duration_since(Instant::now());
    ensure!(!left.is_zero(), "the cluster bake timed out");
    Ok(left)
}

/// One node to start: its plan, its place in the boot order, its disk and
/// serial log.
#[derive(Clone, Copy)]
struct NodeLaunch<'a> {
    node: &'a PlannedClusterNode,
    index: usize,
    disk: &'a Path,
    serial: &'a Path,
    /// Writes go to a scratch file and the disk stays as it is.
    snapshot: bool,
}

/// A free port on 127.0.0.1, for a forward QEMU binds right after.
fn free_port() -> Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

/// Start `node`'s QEMU: the lab NIC on the hub, the uplink through user
/// networking with its Talos API (and on the control plane its Kubernetes
/// API) forwarded to free ports on 127.0.0.1. Another build may take a port
/// between the probe and QEMU's bind; QEMU then exits at once and the node
/// is started again on new ports.
fn spawn_node(
    launch: &NodeLaunch,
    files: &ReleaseFiles,
    config: &QemuBuildConfig,
    arch: BuildArch,
    hub: &Path,
    work: &Path,
) -> Result<(NodeVm, u16, Option<u16>)> {
    let NodeLaunch {
        node,
        index,
        disk,
        serial,
        snapshot,
    } = *launch;
    let snapshot = if snapshot { ",snapshot=on" } else { "" };
    let controlplane = node.role == ClusterRole::Controlplane;
    let (machine, cpu) = machine_and_cpu(arch, config.accelerator.trim());
    for _ in 0..3 {
        let api = free_port()?;
        let k8s = if controlplane {
            Some(free_port()?)
        } else {
            None
        };
        let mut uplink = format!("user,id=up,hostfwd=tcp:127.0.0.1:{api}-:50000");
        if let Some(k8s) = k8s {
            uplink.push_str(&format!(",hostfwd=tcp:127.0.0.1:{k8s}-:6443"));
        }
        let octet = index + 2;
        let args = [
            "-display".to_owned(),
            "none".to_owned(),
            "-nodefaults".to_owned(),
            "-machine".to_owned(),
            format!("{machine},accel={}", config.accelerator.trim()),
            "-cpu".to_owned(),
            cpu.to_owned(),
            "-smp".to_owned(),
            node.cpus.to_string(),
            "-m".to_owned(),
            node.memory_mib.to_string(),
            "-kernel".to_owned(),
            files.kernel.display().to_string(),
            "-initrd".to_owned(),
            files.initramfs.display().to_string(),
            "-append".to_owned(),
            node_cmdline(arch),
            "-drive".to_owned(),
            format!(
                "if=none,id=disk,format=raw,discard=unmap{snapshot},file={}",
                disk.display()
            ),
            "-device".to_owned(),
            "virtio-blk-pci,drive=disk".to_owned(),
            "-netdev".to_owned(),
            format!(
                "stream,id=lab,server=off,addr.type=unix,addr.path={}",
                hub.display()
            ),
            "-device".to_owned(),
            format!("virtio-net-pci,netdev=lab,mac={CLUSTER_LAB_MAC_PREFIX}:{octet:02x}"),
            "-netdev".to_owned(),
            uplink,
            "-device".to_owned(),
            format!("virtio-net-pci,netdev=up,mac=52:54:00:31:01:{octet:02x}"),
            "-device".to_owned(),
            "virtio-rng-pci".to_owned(),
            "-serial".to_owned(),
            format!("file:{}", serial.display()),
        ];
        fs::write(
            work.join(format!("{}.qemu.args", node.name)),
            args.join("\n"),
        )?;
        let child = Command::new(&config.qemu_binary)
            .args(&args)
            .current_dir(work)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("failed to start node `{}`", node.name))?;
        let mut vm = NodeVm {
            name: node.name.clone(),
            child,
            exited: false,
        };
        thread::sleep(Duration::from_secs(1));
        if vm.child.try_wait()?.is_none() {
            return Ok((vm, api, k8s));
        }
        vm.exited = true;
    }
    bail!("node `{}` did not start", node.name)
}

/// The zstd-compressed `zst` written to `out` with zero blocks left as
/// holes, then grown to `size`.
fn sparse_unpack(zst: &Path, out: &Path, size: u64) -> Result<()> {
    let mut decoder = zstd::stream::read::Decoder::new(fs::File::open(zst)?)?;
    let mut file = fs::File::create(out)?;
    let mut block = vec![0u8; 1024 * 1024];
    let mut written = 0u64;
    loop {
        let mut filled = 0;
        while filled < block.len() {
            let read = decoder.read(&mut block[filled..])?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        if filled == 0 {
            break;
        }
        if block[..filled].iter().all(|byte| *byte == 0) {
            file.seek(SeekFrom::Current(filled as i64))?;
        } else {
            file.write_all(&block[..filled])?;
        }
        written += filled as u64;
    }
    ensure!(
        size >= written,
        "a node's disk of {} MiB is smaller than Talos' {} MiB",
        size / (1024 * 1024),
        written.div_ceil(1024 * 1024)
    );
    file.set_len(size)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpacking_keeps_zero_blocks_as_holes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut raw = vec![0u8; 4 * 1024 * 1024];
        raw[3] = 7;
        raw[3 * 1024 * 1024 + 1] = 9;
        let zst = dir.path().join("disk.raw.zst");
        fs::write(&zst, zstd::encode_all(&raw[..], 3).expect("zstd")).expect("write");
        let out = dir.path().join("disk.raw");
        sparse_unpack(&zst, &out, 8 * 1024 * 1024).expect("unpacks");
        let back = fs::read(&out).expect("read");
        assert_eq!(back.len(), 8 * 1024 * 1024);
        assert_eq!(&back[..raw.len()], &raw[..]);
        assert!(sparse_unpack(&zst, &out, 1024 * 1024).is_err());
    }
}
