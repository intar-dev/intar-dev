//! A cluster's machine configs: `talosctl gen config` with our fixed patches
//! first, the author's patches after them, and per node the invariant patch
//! (lab addressing, subnets, endpoint, install disk) applied last, so no
//! author patch can move a node off the lab layout every runtime expects.
//! Changing a patch here changes what is baked: bump `CLUSTER_BAKE_REVISION`.

use std::fs;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};

use anyhow::{Result, ensure};
use intar_contracts::scenario::{CLUSTER_LAB_PREFIX, CLUSTER_LAB_PREFIX_LEN, ClusterV1};

use super::Tool;

/// Ten years: images are reused for as long as their key holds.
const CERT_LIFETIME: &str = "87600h";

fn lab_subnet() -> String {
    let [a, b, c] = CLUSTER_LAB_PREFIX;
    format!("{a}.{b}.{c}.0/{CLUSTER_LAB_PREFIX_LEN}")
}

/// The control plane's lab address and the cluster endpoint on it.
pub(crate) fn controlplane_ip() -> Ipv4Addr {
    let [a, b, c] = CLUSTER_LAB_PREFIX;
    Ipv4Addr::new(a, b, c, 2)
}

pub(crate) fn endpoint() -> String {
    format!("https://{}:6443", controlplane_ip())
}

/// Every node: the API also answers on 127.0.0.1 (the bake's forwards),
/// fast kubelet start and in-place restart at wake, DHCP on the uplink.
/// The kubelet reports status every second, so a node the woken
/// controller-manager marks NotReady from its baked heartbeat is back at
/// once. It resyncs pods every second, which also caps its retry of a
/// failed pod sync (10 s otherwise): at wake its pods often arrive before its
/// Services list (no pod starts until that is in) or before flannel's subnet
/// lease, and each such miss cost 10-15 s. No KubePrism: with one control plane it has nothing to balance, and
/// Talos health-checks its upstreams only every 20 s (a constant), so the
/// failed dials before the API server is up stall every client on the node
/// (kubelet, controller-manager, scheduler, flannel) for up to 20 s at wake.
fn common() -> String {
    "machine:
  certSANs: [127.0.0.1]
---
apiVersion: v1alpha1
kind: KubeletConfig
config:
  httpCheckFrequency: 1s
  nodeStatusUpdateFrequency: 1s
  syncFrequency: 1s
  shutdownGracePeriod: 0s
  shutdownGracePeriodCriticalPods: 0s
---
apiVersion: v1alpha1
kind: KubePrismConfig
$patch: delete
---
apiVersion: v1alpha1
kind: DHCPv4Config
name: eth1
"
    .to_owned()
}

/// The control plane: etcd on the lab subnet, the API server's certificate
/// for 127.0.0.1, a long-lived admin kubeconfig, flannel on the lab NIC.
/// The controller-manager gives up its lease when it stops, as the scheduler
/// always does, and the API server keeps serving for a few seconds after it
/// is told to stop, so both releases land during the bake's shutdown (Talos
/// stops all three at once) and the woken cluster takes the leases at once.
fn controlplane() -> String {
    let subnet = lab_subnet();
    format!(
        "cluster:
  etcd:
    advertisedSubnets: [{subnet}]
  adminKubeconfig:
    certLifetime: {CERT_LIFETIME}
---
apiVersion: v1alpha1
kind: KubeAPIServerConfig
certExtraSANs: [127.0.0.1]
extraArgs:
  shutdown-delay-duration: 5s
---
apiVersion: v1alpha1
kind: KubeControllerManagerConfig
extraArgs:
  feature-gates: ControllerManagerReleaseLeaderElectionLockOnExit=true
---
apiVersion: v1alpha1
kind: KubeFlannelCNIConfig
extraArgs: [\"--iface=eth0\"]
"
    )
}

/// Last on every node: its lab address on eth0 without a gateway, its name,
/// the node IP and endpoint on the lab subnet, the preinstalled disk kept,
/// and time sync that does not hold the boot: the VM starts on the host's
/// clock, and without a boot timeout Talos holds etcd and the kubelet until a
/// sync that a node without egress never gets. NTP keeps trying behind it.
fn invariant(name: &str, ip: Ipv4Addr) -> String {
    let subnet = lab_subnet();
    let endpoint = endpoint();
    format!(
        "apiVersion: v1alpha1
kind: KubeNodeConfig
nodeIP:
  validSubnets: [{subnet}]
---
apiVersion: v1alpha1
kind: KubeClusterConfig
endpoint: {endpoint}
---
apiVersion: v1alpha1
kind: UnattendedInstallConfig
provisioning:
  diskSelector:
    match: disk.dev_path == \"/dev/vda\"
  wipe: false
---
apiVersion: v1alpha1
kind: LinkConfig
name: eth0
addresses:
  - address: {ip}/{CLUSTER_LAB_PREFIX_LEN}
---
apiVersion: v1alpha1
kind: HostnameConfig
auto: off
hostname: {name}
---
apiVersion: v1alpha1
kind: TimeSyncConfig
bootTimeout: 1s
"
    )
}

/// The generated base configs and the client config.
#[derive(Clone, Debug)]
pub(crate) struct BaseConfigs {
    pub controlplane: PathBuf,
    pub worker: PathBuf,
    pub talosconfig: PathBuf,
}

/// Fresh secrets and the base configs of `cluster` in `dir`.
pub(crate) fn generate(talosctl: &Tool, cluster: &ClusterV1, dir: &Path) -> Result<BaseConfigs> {
    let secrets = dir.join("secrets.yaml");
    talosctl.run(&["gen", "secrets", "-o", &path(&secrets)])?;
    let common_patch = write(dir, "patch-common.yaml", &common())?;
    let controlplane_patch = write(dir, "patch-controlplane.yaml", &controlplane())?;
    let mut args = vec![
        "gen".to_owned(),
        "config".to_owned(),
        cluster.name.clone(),
        endpoint(),
        "--with-secrets".to_owned(),
        path(&secrets),
        "--kubernetes-version".to_owned(),
        cluster.kubernetes.trim_start_matches('v').to_owned(),
        "--install-disk".to_owned(),
        "/dev/vda".to_owned(),
        "--with-docs=false".to_owned(),
        "--with-examples=false".to_owned(),
        "--output-types".to_owned(),
        "controlplane,worker,talosconfig".to_owned(),
        "--output".to_owned(),
        path(dir),
        "--force".to_owned(),
        "--config-patch".to_owned(),
        format!("@{}", path(&common_patch)),
        "--config-patch-control-plane".to_owned(),
        format!("@{}", path(&controlplane_patch)),
    ];
    for (index, patch) in cluster.patches.iter().enumerate() {
        let file = write(dir, &format!("patch-author-{index:02}.yaml"), &patch.script)?;
        args.extend(["--config-patch".to_owned(), format!("@{}", path(&file))]);
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    talosctl.run(&args)?;
    let configs = BaseConfigs {
        controlplane: dir.join("controlplane.yaml"),
        worker: dir.join("worker.yaml"),
        talosconfig: dir.join("talosconfig"),
    };
    for file in [&configs.controlplane, &configs.worker, &configs.talosconfig] {
        ensure!(
            file.exists(),
            "talosctl gen config wrote no {}",
            file.display()
        );
    }
    Ok(configs)
}

/// The config of one node: its role's base with the invariant patch last,
/// checked by `talosctl validate`.
pub(crate) fn node_config(
    talosctl: &Tool,
    base: &Path,
    name: &str,
    ip: Ipv4Addr,
    dir: &Path,
) -> Result<PathBuf> {
    let patch = write(
        dir,
        &format!("patch-node-{name}.yaml"),
        &invariant(name, ip),
    )?;
    let out = dir.join(format!("node-{name}.yaml"));
    talosctl.run(&[
        "machineconfig",
        "patch",
        &path(base),
        "--patch",
        &format!("@{}", path(&patch)),
        "-o",
        &path(&out),
    ])?;
    talosctl.run(&["validate", "--mode", "metal", "--config", &path(&out)])?;
    Ok(out)
}

fn write(dir: &Path, name: &str, text: &str) -> Result<PathBuf> {
    let file = dir.join(name);
    fs::write(&file, text)?;
    Ok(file)
}

fn path(path: &Path) -> String {
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_invariant_patch_pins_the_lab_layout() {
        let patch = invariant("wk1", Ipv4Addr::new(172, 31, 0, 3));
        for expected in [
            "validSubnets: [172.31.0.0/28]",
            "endpoint: https://172.31.0.2:6443",
            "match: disk.dev_path == \"/dev/vda\"",
            "- address: 172.31.0.3/28",
            "hostname: wk1",
            "kind: TimeSyncConfig\nbootTimeout: 1s",
        ] {
            assert!(patch.contains(expected), "{expected} in {patch}");
        }
        // No gateway on the lab link: the uplink carries the default route.
        assert!(!patch.contains("gateway"));
    }

    #[test]
    fn the_fixed_patches_carry_the_wake_fixes() {
        let all = format!("{}{}", common(), controlplane());
        for expected in [
            "httpCheckFrequency: 1s",
            "shutdownGracePeriod: 0s",
            "nodeStatusUpdateFrequency: 1s",
            "syncFrequency: 1s",
            "kind: KubePrismConfig\n$patch: delete",
            "feature-gates: ControllerManagerReleaseLeaderElectionLockOnExit=true",
            "shutdown-delay-duration: 5s",
            "--iface=eth0",
            "advertisedSubnets: [172.31.0.0/28]",
            "certLifetime: 87600h",
        ] {
            assert!(all.contains(expected), "{expected}");
        }
        // Leader election stays on: the lab keeps Talos's default.
        assert!(!all.contains("leader-elect"));
    }
}
