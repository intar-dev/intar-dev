//! Root-only, typed per-run network construction.
//!
//! No value from the control protocol is evaluated by a shell. Interface and
//! nftables names are derived from a SHA-256 digest and every IP/CIDR has
//! already passed the protocol validator before it reaches this module.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::io::Write as _;
use std::os::fd::AsFd as _;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use anyhow::{Context as _, Result, bail};
use intar_jailer_protocol::{
    EnsureRunNetworkRequest, JailerdConfig, RunNetworkResult, ValidatedId, VmLaunchRequest,
};
use rustix::fs::{Mode, OFlags, fstat, fstatfs, open};
use rustix::thread::{LinkNameSpaceType, move_into_link_name_space};
use sha2::{Digest as _, Sha256};

const IP_CANDIDATES: &[&str] = &["/usr/sbin/ip", "/usr/bin/ip"];
const NFT_CANDIDATES: &[&str] = &["/usr/sbin/nft", "/usr/bin/nft"];
const NSENTER_CANDIDATES: &[&str] = &["/usr/bin/nsenter", "/usr/sbin/nsenter"];
const INITIAL_MOUNT_NAMESPACE: &str = "/proc/1/ns/mnt";
const INITIAL_ROOT: &str = "/proc/1/root";
const NSFS_MAGIC: rustix::fs::FsWord = 0x6e73_6673;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectoryIdentity {
    device: u64,
    inode: u64,
    uid: u32,
    gid: u32,
    mode: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VmNetworkAttachment {
    pub generation: ValidatedId,
    pub vm_id: ValidatedId,
    pub tap_name: String,
    pub guest_mac_address: String,
    pub tap_mac_address: String,
    pub guest_ip_cidr: String,
    pub ssh_public_port: Option<u16>,
    pub ssh_forward_active: bool,
    pub vsock_cid: u32,
    pub uid: u32,
    pub gid: u32,
}

#[derive(Clone, Debug)]
struct RunState {
    request: EnsureRunNetworkRequest,
    result: RunNetworkResult,
    nft_table: String,
    attachments: BTreeMap<ValidatedId, VmNetworkAttachment>,
    installed: bool,
}

pub(crate) struct NetworkManager {
    ip: PathBuf,
    nft: PathBuf,
    nsenter: PathBuf,
    netns_root: PathBuf,
    host_netns_root: PathBuf,
    policy: JailerdConfig,
    runs: BTreeMap<ValidatedId, RunState>,
}

impl NetworkManager {
    pub(crate) fn new(config: &JailerdConfig) -> Result<Self> {
        let netns_root = config.netns_root.clone();
        let ip = trusted_tool(IP_CANDIDATES).context("find trusted iproute2 binary")?;
        let nft = trusted_tool(NFT_CANDIDATES).context("find trusted nft binary")?;
        let nsenter = trusted_nsenter_binary()?;
        validate_iproute2_netns_root(&netns_root)?;
        if !netns_root.is_absolute() || !trusted_directory(&netns_root) {
            bail!(
                "network namespace root is not a trusted root-owned directory: {}",
                netns_root.display()
            )
        }
        let host_netns_root = initial_mount_namespace_root(&netns_root)?;
        validate_host_netns_root(&netns_root, &host_netns_root)?;
        validate_initial_network_namespace()?;
        if !std::fs::read_to_string("/proc/sys/net/ipv4/ip_forward")
            .is_ok_and(|value| value.trim() == "1")
        {
            bail!("host IPv4 forwarding is disabled")
        }
        Ok(Self {
            ip,
            nft,
            nsenter,
            netns_root,
            host_netns_root,
            policy: config.clone(),
            runs: BTreeMap::new(),
        })
    }

    pub(crate) fn ensure_run(
        &mut self,
        request: &EnsureRunNetworkRequest,
    ) -> Result<RunNetworkResult> {
        self.policy
            .validate_run_network_request(request)
            .context("validate root-owned run network policy")?;
        if let Some(existing) = self.runs.get(&request.run_id) {
            if existing.request != *request {
                bail!("run network already exists with different topology")
            }
            // An exact hit in the current daemon lifetime is already backed by
            // the namespace/TAP state and nftables transaction that set
            // `installed`. Re-running the full topology construction here adds
            // dozens of `ip`/`nsenter` processes to every VM launch in a run.
            // Recovered records deliberately start with `installed = false`,
            // so daemon recovery still takes the validating reconciliation
            // path below before the result becomes fast-path eligible.
            if existing.installed {
                return Ok(existing.result.clone());
            }
            // Clone only for the recovery path, after the O(1) exact-hit
            // return. `attachments` can grow with the run and must not be
            // copied on every VM launch.
            let existing = existing.clone();
            self.construct_run(&existing)
                .context("reconcile existing run network")?;
            self.render_run(&request.run_id)
                .context("reconcile existing run network policy")?;
            return Ok(existing.result.clone());
        }

        let (mut result, nft_table) = derived_topology(request)?;
        if ipv4_cidrs_overlap(&request.guest_cidr, "198.18.0.0/15")? {
            bail!("run guest network overlaps jailerd's transit allocation")
        }
        if self.runs.values().any(|state| {
            state.result.host_transit_cidr == result.host_transit_cidr
                || state.result.namespace_transit_cidr == result.namespace_transit_cidr
        }) {
            bail!("derived transit network collides with an active run")
        }
        for state in self.runs.values() {
            if ipv4_cidrs_overlap(&state.request.guest_cidr, &request.guest_cidr)? {
                bail!("run guest network overlaps an active run")
            }
        }
        let bridge_mac = derived_bridge_mac(request);
        if self.runs.values().any(|state| {
            derived_bridge_mac(&state.request) == bridge_mac
                || state.attachments.values().any(|attachment| {
                    attachment.guest_mac_address == bridge_mac
                        || attachment.tap_mac_address == bridge_mac
                })
        }) {
            bail!("derived run bridge MAC collides with an active network identity")
        }
        let installed = self.nft_succeeds(&["list", "table", "inet", &nft_table]);
        let mut state = RunState {
            request: request.clone(),
            result: result.clone(),
            nft_table,
            attachments: BTreeMap::new(),
            installed,
        };
        result.namespace_inode = self.construct_run(&state)?;
        state.result = result.clone();
        self.runs.insert(request.run_id.clone(), state);
        if let Err(error) = self.render_run(&request.run_id) {
            let cleanup = self.destroy_run_physical(&result);
            if cleanup.is_ok() {
                self.runs.remove(&request.run_id);
            }
            return match cleanup {
                Ok(()) => Err(error).context("install run network policy"),
                Err(cleanup_error) => Err(error).context(format!(
                    "install run network policy; physical rollback also failed and remains tracked: {cleanup_error:#}"
                )),
            };
        }
        Ok(result)
    }

    /// Perform the expensive repair path for an already tracked run even when
    /// its in-memory installation marker is current. Launches use `ensure_run`
    /// so exact hits remain O(1); only startup and periodic repair call this.
    pub(crate) fn repair_run(
        &mut self,
        request: &EnsureRunNetworkRequest,
    ) -> Result<RunNetworkResult> {
        self.policy
            .validate_run_network_request(request)
            .context("validate root-owned run network repair policy")?;
        let existing = self
            .runs
            .get(&request.run_id)
            .cloned()
            .context("cannot repair an untracked run network")?;
        if existing.request != *request {
            bail!("run network repair topology differs from tracked state")
        }
        self.construct_run(&existing)
            .context("repair existing run network")?;
        // The in-memory marker is only a launch fast-path hint. Refresh it
        // before repair so an externally removed nftables table is recreated
        // instead of producing a failing `delete table` transaction.
        let installed = self.nft_succeeds(&["list", "table", "inet", &existing.nft_table]);
        self.runs
            .get_mut(&request.run_id)
            .context("run network state disappeared during repair")?
            .installed = installed;
        self.render_run(&request.run_id)
            .context("repair existing run network policy")?;
        Ok(existing.result)
    }

    pub(crate) fn ensure_vm(
        &mut self,
        run: &EnsureRunNetworkRequest,
        request: &VmLaunchRequest,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<()> {
        let state = self
            .runs
            .get(&run.run_id)
            .context("run network has not been ensured")?;
        if state.request != *run {
            bail!("VM run-network topology differs from the ensured network")
        }
        self.policy
            .validate_ssh_public_port(request.ssh_public_port)
            .context("validate root-owned SSH public port policy")?;
        validate_guest_address(run, request)?;
        if !ipv4_cidr_contains(&run.guest_cidr, &request.guest_ip_cidr)? {
            bail!("VM guest address is outside its run network")
        }
        let tap_mac_address =
            derived_tap_mac(&request.mac_address).context("derive host TAP MAC from guest MAC")?;
        if self.runs.values().any(|other| {
            mac_conflicts_with_bridge(
                &derived_bridge_mac(&other.request),
                &request.mac_address,
                &tap_mac_address,
            ) || other.attachments.values().any(|attachment| {
                attachment.tap_name == request.tap_name
                    || attachment_macs_conflict(attachment, &request.mac_address, &tap_mac_address)
                    || attachment.vsock_cid == request.vsock_cid
                    || (request.ssh_public_port.is_some()
                        && attachment.ssh_public_port == request.ssh_public_port)
            })
        }) {
            bail!("TAP, MAC, vsock CID, or SSH public port is already allocated")
        }
        if state
            .attachments
            .values()
            .any(|attachment| attachment.guest_ip_cidr == request.guest_ip_cidr)
        {
            bail!("guest address is already allocated in this run")
        }
        let attachment = VmNetworkAttachment {
            generation: generation.clone(),
            vm_id: request.vm_id.clone(),
            tap_name: request.tap_name.clone(),
            guest_mac_address: request.mac_address.clone(),
            tap_mac_address,
            guest_ip_cidr: request.guest_ip_cidr.clone(),
            ssh_public_port: request.ssh_public_port,
            ssh_forward_active: false,
            vsock_cid: request.vsock_cid,
            uid,
            gid,
        };
        if let Some(existing) = state.attachments.get(generation) {
            if existing == &attachment {
                return Ok(());
            }
            bail!("generation already has different network topology")
        }

        self.create_tap(&state.result, &attachment)?;
        self.runs
            .get_mut(&run.run_id)
            .context("run state disappeared during TAP creation")?
            .attachments
            .insert(generation.clone(), attachment);
        if let Err(error) = self.render_run(&run.run_id) {
            let _ = self.destroy_vm(&run.run_id, generation);
            return Err(error).context("install VM forwarding policy");
        }
        Ok(())
    }

    /// Reattach durable network state after a daemon restart. A fresh launch
    /// rejects pre-existing TAPs, while recovery validates the durable TAP and
    /// reapplies its recorded link topology without replacing file descriptors
    /// already held by Cloud Hypervisor.
    pub(crate) fn recover_vm(
        &mut self,
        run: &EnsureRunNetworkRequest,
        request: &VmLaunchRequest,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<()> {
        let state = self
            .runs
            .get(&run.run_id)
            .context("run network has not been recovered")?;
        if state.request != *run {
            bail!("recovered VM run-network topology differs from durable state")
        }
        self.policy
            .validate_run_network_request(run)
            .context("validate recovered root-owned run network policy")?;
        self.policy
            .validate_ssh_public_port(request.ssh_public_port)
            .context("validate recovered root-owned SSH public port policy")?;
        validate_guest_address(run, request)?;
        if !ipv4_cidr_contains(&run.guest_cidr, &request.guest_ip_cidr)? {
            bail!("recovered VM guest address is outside its run network")
        }
        let tap_mac_address = derived_tap_mac(&request.mac_address)
            .context("derive recovered host TAP MAC from guest MAC")?;
        let attachment = VmNetworkAttachment {
            generation: generation.clone(),
            vm_id: request.vm_id.clone(),
            tap_name: request.tap_name.clone(),
            guest_mac_address: request.mac_address.clone(),
            tap_mac_address,
            guest_ip_cidr: request.guest_ip_cidr.clone(),
            ssh_public_port: request.ssh_public_port,
            ssh_forward_active: false,
            vsock_cid: request.vsock_cid,
            uid,
            gid,
        };
        if let Some(existing) = state.attachments.get(generation) {
            if existing == &attachment {
                return Ok(());
            }
            bail!("recovered generation has different network topology")
        }
        if self.runs.values().any(|other| {
            mac_conflicts_with_bridge(
                &derived_bridge_mac(&other.request),
                &attachment.guest_mac_address,
                &attachment.tap_mac_address,
            ) || other.attachments.values().any(|existing| {
                existing.tap_name == attachment.tap_name
                    || attachment_macs_conflict(
                        existing,
                        &attachment.guest_mac_address,
                        &attachment.tap_mac_address,
                    )
                    || existing.vsock_cid == attachment.vsock_cid
                    || (attachment.ssh_public_port.is_some()
                        && existing.ssh_public_port == attachment.ssh_public_port)
            })
        }) {
            bail!("recovered TAP, MAC, vsock CID, or SSH public port is already allocated")
        }
        if state
            .attachments
            .values()
            .any(|existing| existing.guest_ip_cidr == attachment.guest_ip_cidr)
        {
            bail!("recovered guest address is already allocated in this run")
        }

        self.verify_and_restore_tap(&state.result, &attachment)?;
        self.runs
            .get_mut(&run.run_id)
            .context("run state disappeared during TAP recovery")?
            .attachments
            .insert(generation.clone(), attachment);
        if let Err(error) = self.render_run(&run.run_id) {
            self.runs
                .get_mut(&run.run_id)
                .context("run state disappeared during policy rollback")?
                .attachments
                .remove(generation);
            return Err(error).context("restore recovered VM forwarding policy");
        }
        Ok(())
    }

    pub(crate) fn destroy_vm(
        &mut self,
        run_id: &ValidatedId,
        generation: &ValidatedId,
    ) -> Result<bool> {
        let Some(state) = self.runs.get_mut(run_id) else {
            return Ok(false);
        };
        let Some(attachment) = state.attachments.remove(generation) else {
            return Ok(false);
        };
        let namespace = state.result.namespace_name.clone();
        let delete = vec![
            "-n".to_owned(),
            namespace,
            "link".to_owned(),
            "delete".to_owned(),
            attachment.tap_name.clone(),
        ];
        if self.ip_succeeds(&["-n", &delete[1], "link", "show", "dev", &delete[4]])
            && let Err(error) = self.ip_strings(&delete)
        {
            self.runs
                .get_mut(run_id)
                .context("run state disappeared during TAP rollback")?
                .attachments
                .insert(generation.clone(), attachment);
            return Err(error).context("delete VM TAP");
        }
        if let Err(error) = self.render_run(run_id) {
            self.runs
                .get_mut(run_id)
                .context("run state disappeared during policy rollback")?
                .attachments
                .insert(generation.clone(), attachment);
            return Err(error).context("remove VM forwarding policy");
        }
        Ok(true)
    }

    /// Change only the externally reachable SSH rule for an existing VM.
    /// The requested port remains reserved while inactive, so another launch
    /// cannot claim it during the boot phase.
    pub(crate) fn set_vm_ssh_forwarding(
        &mut self,
        run_id: &ValidatedId,
        generation: &ValidatedId,
        active: bool,
    ) -> Result<bool> {
        let attachment = self
            .runs
            .get_mut(run_id)
            .and_then(|state| state.attachments.get_mut(generation))
            .context("VM network attachment is not active")?;
        let desired = active && attachment.ssh_public_port.is_some();
        if attachment.ssh_forward_active == desired {
            return Ok(false);
        }
        let previous = attachment.ssh_forward_active;
        attachment.ssh_forward_active = desired;
        if let Err(error) = self.render_run(run_id) {
            self.runs
                .get_mut(run_id)
                .and_then(|state| state.attachments.get_mut(generation))
                .context("VM network attachment disappeared during policy rollback")?
                .ssh_forward_active = previous;
            return Err(error).context("update VM SSH forwarding policy");
        }
        Ok(true)
    }

    pub(crate) fn destroy_run(&mut self, run_id: &ValidatedId) -> Result<bool> {
        let Some(state) = self.runs.get(run_id).cloned() else {
            return Ok(false);
        };
        if self
            .runs
            .get(run_id)
            .is_some_and(|state| !state.attachments.is_empty())
        {
            bail!("cannot destroy a run network while VM TAPs remain")
        }
        self.destroy_run_physical(&state.result)?;
        self.render_without_run(run_id)?;
        self.runs.remove(run_id);
        Ok(true)
    }

    fn destroy_run_physical(&self, result: &RunNetworkResult) -> Result<()> {
        let mut failures = Vec::new();
        let namespace_path = self.host_netns_root.join(&result.namespace_name);
        if path_entry_exists(&namespace_path)? {
            self.verify_namespace_identity(&result.namespace_name, result.namespace_inode)?;
        }
        if self.ip_succeeds(&["link", "show", "dev", &result.host_veth_name])
            && let Err(error) = self.ip(&["link", "delete", &result.host_veth_name])
            && self.ip_succeeds(&["link", "show", "dev", &result.host_veth_name])
        {
            failures.push(format!("delete host run veth: {error:#}"));
        }
        if path_entry_exists(&namespace_path)?
            && let Err(error) =
                self.delete_namespace(&result.namespace_name, result.namespace_inode)
            && path_entry_exists(&namespace_path)?
        {
            failures.push(format!("delete run network namespace: {error:#}"));
        }
        if !failures.is_empty() {
            bail!("{}", failures.join("; "))
        }
        Ok(())
    }

    fn construct_run(&self, state: &RunState) -> Result<u64> {
        let namespace = &state.result.namespace_name;
        let bridge = &state.result.bridge_name;
        let host_veth = &state.result.host_veth_name;
        let namespace_veth = &state.result.namespace_veth_name;
        let namespace_path = self.host_netns_root.join(namespace);
        let created_namespace = !path_entry_exists(&namespace_path)?;
        if created_namespace && state.result.namespace_inode != 0 {
            bail!("refusing to replace a missing tracked run network namespace")
        }
        let namespace_inode = if created_namespace {
            self.create_namespace(namespace)?
        } else {
            let inode = self.verify_namespace_visibility(namespace)?;
            if state.result.namespace_inode != 0 && state.result.namespace_inode != inode {
                bail!("run network namespace identity changed before reconciliation")
            }
            self.ip(&["-n", namespace, "link", "show", "lo"])
                .context("verify existing network namespace")?;
            inode
        };

        let mut created_veth = false;
        let operation = (|| -> Result<()> {
            let host_veth_exists = self.ip_succeeds(&["link", "show", "dev", host_veth]);
            let namespace_veth_exists =
                self.ip_succeeds(&["-n", namespace, "link", "show", "dev", namespace_veth]);
            if created_namespace && (host_veth_exists || namespace_veth_exists) {
                bail!("refusing to adopt a pre-existing run veth for a fresh namespace")
            }
            match (host_veth_exists, namespace_veth_exists) {
                (false, false) => {
                    self.ip(&[
                        "link",
                        "add",
                        host_veth,
                        "type",
                        "veth",
                        "peer",
                        "name",
                        namespace_veth,
                    ])?;
                    created_veth = true;
                    self.ip(&["link", "set", namespace_veth, "netns", namespace])?;
                }
                (true, true) => {}
                (true, false) | (false, true) => {
                    bail!("refusing to adopt a one-sided run veth topology")
                }
            }
            if !self.ip_succeeds(&["-n", namespace, "link", "show", "dev", bridge]) {
                self.ip(&["-n", namespace, "link", "add", bridge, "type", "bridge"])?;
            }
            self.pin_and_verify_link_mac(namespace, bridge, &derived_bridge_mac(&state.request))
                .context("pin deterministic run bridge MAC")?;

            self.ip(&[
                "addr",
                "replace",
                &state.result.host_transit_cidr,
                "dev",
                host_veth,
            ])?;
            self.ip(&["link", "set", host_veth, "up"])?;
            self.ip(&[
                "-n",
                namespace,
                "addr",
                "replace",
                &state.result.namespace_transit_cidr,
                "dev",
                namespace_veth,
            ])?;
            self.ip(&["-n", namespace, "link", "set", namespace_veth, "up"])?;
            self.ip(&["-n", namespace, "link", "set", "lo", "up"])?;
            let prefix = cidr_prefix(&state.request.guest_cidr)?;
            let gateway_cidr = format!("{}/{prefix}", state.request.gateway);
            self.ip(&[
                "-n",
                namespace,
                "addr",
                "replace",
                &gateway_cidr,
                "dev",
                bridge,
            ])?;
            self.ip(&["-n", namespace, "link", "set", bridge, "up"])?;
            let namespace_transit_ip = cidr_address(&state.result.namespace_transit_cidr)?;
            let existing_route =
                self.ip_output(&["-4", "route", "show", "exact", &state.request.guest_cidr])?;
            if existing_route.trim().is_empty() {
                self.ip(&[
                    "route",
                    "add",
                    &state.request.guest_cidr,
                    "via",
                    &namespace_transit_ip,
                    "dev",
                    host_veth,
                    "proto",
                    "242",
                ])?;
            } else if !route_is_owned(
                &existing_route,
                &state.request.guest_cidr,
                &namespace_transit_ip,
                host_veth,
            ) {
                bail!("refusing to replace a host route not owned by jailerd")
            }
            let host_transit_ip = cidr_address(&state.result.host_transit_cidr)?;
            self.ip(&[
                "-n",
                namespace,
                "route",
                "replace",
                "default",
                "via",
                &host_transit_ip,
                "dev",
                namespace_veth,
            ])?;
            enable_namespace_forwarding(namespace_path.clone())?;
            Ok(())
        })();
        if let Err(error) = operation {
            let mut cleanup_failures = Vec::new();
            if created_veth
                && self.ip_succeeds(&["link", "show", "dev", host_veth])
                && let Err(cleanup_error) = self.ip(&["link", "delete", host_veth])
                && self.ip_succeeds(&["link", "show", "dev", host_veth])
            {
                cleanup_failures.push(format!("delete new host veth: {cleanup_error:#}"));
            }
            if created_namespace
                && path_entry_exists(&namespace_path)?
                && let Err(cleanup_error) = self.delete_namespace(namespace, namespace_inode)
                && path_entry_exists(&namespace_path)?
            {
                cleanup_failures.push(format!("delete new run namespace: {cleanup_error:#}"));
            }
            return if cleanup_failures.is_empty() {
                Err(error)
            } else {
                Err(error).context(format!(
                    "run network rollback also failed: {}",
                    cleanup_failures.join("; ")
                ))
            };
        }
        Ok(namespace_inode)
    }

    /// `ip netns add` persists a namespace by bind-mounting nsfs beneath
    /// `/run/netns`. The jailerd service intentionally has a private mount
    /// namespace, while VM transient units inherit PID 1's mount namespace.
    /// Create and remove only the named namespace handle through trusted
    /// `nsenter`. All later lookups use PID 1's root because a child mount made
    /// there is intentionally not propagated into the service's private bind
    /// view; link, route and nftables work remains in this process.
    fn create_namespace(&self, namespace: &str) -> Result<u64> {
        create_host_visible_namespace(&self.nsenter, &self.ip, &self.netns_root, namespace)
    }

    fn delete_namespace(&self, namespace: &str, expected_inode: u64) -> Result<()> {
        self.verify_namespace_identity(namespace, expected_inode)?;
        delete_host_visible_namespace(&self.nsenter, &self.ip, &self.netns_root, namespace)
    }

    fn verify_namespace_visibility(&self, namespace: &str) -> Result<u64> {
        verify_host_visible_namespace(&self.netns_root, namespace)
    }

    fn verify_namespace_identity(&self, namespace: &str, expected_inode: u64) -> Result<()> {
        let inode = self.verify_namespace_visibility(namespace)?;
        if inode != expected_inode {
            bail!("run network namespace identity differs from the recorded inode")
        }
        Ok(())
    }

    fn create_tap(
        &self,
        network: &RunNetworkResult,
        attachment: &VmNetworkAttachment,
    ) -> Result<()> {
        let namespace = &network.namespace_name;
        if self.ip_succeeds(&["-n", namespace, "link", "show", "dev", &attachment.tap_name]) {
            bail!("refusing to adopt pre-existing TAP interface")
        }
        self.ip(&[
            "-n",
            namespace,
            "tuntap",
            "add",
            "dev",
            &attachment.tap_name,
            "mode",
            "tap",
            "user",
            &attachment.uid.to_string(),
            "group",
            &attachment.gid.to_string(),
        ])?;
        let operation = self.configure_tap(network, attachment);
        if operation.is_err() {
            self.ip_ignore(&[
                "-n".to_owned(),
                namespace.clone(),
                "link".to_owned(),
                "delete".to_owned(),
                attachment.tap_name.clone(),
            ]);
        }
        operation
    }

    fn verify_and_restore_tap(
        &self,
        network: &RunNetworkResult,
        attachment: &VmNetworkAttachment,
    ) -> Result<()> {
        let namespace = &network.namespace_name;
        if !self.ip_succeeds(&["-n", namespace, "link", "show", "dev", &attachment.tap_name]) {
            bail!("recovered VM TAP is missing")
        }
        let tuntap = self.ip_output(&[
            "-n",
            namespace,
            "tuntap",
            "show",
            "dev",
            &attachment.tap_name,
        ])?;
        let fields = tuntap.split_whitespace().collect::<Vec<_>>();
        if !fields.contains(&"tap") {
            bail!("recovered VM interface is not a TAP")
        }
        let expected_uid = attachment.uid.to_string();
        let expected_gid = attachment.gid.to_string();
        let has_owner = fields
            .windows(2)
            .any(|pair| pair == ["user", expected_uid.as_str()]);
        let has_group = fields
            .windows(2)
            .any(|pair| pair == ["group", expected_gid.as_str()]);
        if !has_owner || !has_group {
            bail!("recovered VM TAP owner differs from its durable identity")
        }
        self.configure_tap(network, attachment)
    }

    fn configure_tap(
        &self,
        network: &RunNetworkResult,
        attachment: &VmNetworkAttachment,
    ) -> Result<()> {
        for command in tap_link_commands(network, attachment) {
            self.ip_strings(&command)?;
        }
        Ok(())
    }

    fn pin_and_verify_link_mac(
        &self,
        namespace: &str,
        interface: &str,
        expected_mac: &str,
    ) -> Result<()> {
        self.ip_strings(&link_address_command(namespace, interface, expected_mac))?;
        let output = self.ip_output(&["-n", namespace, "-o", "link", "show", "dev", interface])?;
        verify_link_mac(&output, expected_mac)
    }

    fn render_run(&mut self, run_id: &ValidatedId) -> Result<()> {
        let state = self
            .runs
            .get(run_id)
            .context("run network state disappeared before nftables render")?;
        let mut transaction = String::new();
        if state.installed {
            transaction.push_str(&format!("delete table inet {}\n", state.nft_table));
        }
        transaction.push_str(&render_nft_rules(state)?);
        self.nft_script(&transaction)
            .context("atomically install affected run nftables policy")?;
        self.runs
            .get_mut(run_id)
            .context("run network state disappeared after nftables render")?
            .installed = true;
        Ok(())
    }

    fn render_without_run(&mut self, removed: &ValidatedId) -> Result<()> {
        let state = self
            .runs
            .get(removed)
            .context("removed run network state disappeared before nftables cleanup")?;
        if state.installed {
            self.nft_script(&format!("delete table inet {}\n", state.nft_table))
                .context("atomically remove affected run nftables policy")?;
        }
        Ok(())
    }

    fn ip(&self, args: &[&str]) -> Result<()> {
        checked_host_mount_ip(&self.nsenter, &self.ip, args.iter().map(OsStr::new)).map(|_| ())
    }

    fn ip_succeeds(&self, args: &[&str]) -> bool {
        host_mount_ip_status(&self.nsenter, &self.ip, args.iter().map(OsStr::new))
    }

    fn ip_output(&self, args: &[&str]) -> Result<String> {
        let output = checked_host_mount_ip(&self.nsenter, &self.ip, args.iter().map(OsStr::new))?;
        String::from_utf8(output.stdout).context("trusted helper emitted non-UTF-8 output")
    }

    fn nft_succeeds(&self, args: &[&str]) -> bool {
        run_status(&self.nft, args.iter().map(OsStr::new))
    }

    fn ip_ignore(&self, args: &[String]) {
        let _ = host_mount_ip_status(
            &self.nsenter,
            &self.ip,
            args.iter().map(String::as_str).map(OsStr::new),
        );
    }

    fn ip_strings(&self, args: &[String]) -> Result<()> {
        checked_host_mount_ip(
            &self.nsenter,
            &self.ip,
            args.iter().map(String::as_str).map(OsStr::new),
        )
        .map(|_| ())
    }

    fn nft_script(&self, script: &str) -> Result<()> {
        run_checked(
            &self.nft,
            [OsStr::new("--check"), OsStr::new("-f"), OsStr::new("-")],
            Some(script.as_bytes()),
        )?;
        run_checked(
            &self.nft,
            [OsStr::new("-f"), OsStr::new("-")],
            Some(script.as_bytes()),
        )
    }
}

pub(crate) fn trusted_nsenter_binary() -> Result<PathBuf> {
    trusted_tool(NSENTER_CANDIDATES).context("find trusted util-linux nsenter binary")
}

pub(crate) fn create_host_visible_namespace(
    nsenter: &Path,
    ip: &Path,
    netns_root: &Path,
    namespace: &str,
) -> Result<u64> {
    add_host_visible_namespace(nsenter, ip, netns_root, namespace)?;
    match verify_host_visible_namespace(netns_root, namespace) {
        Ok(inode) => Ok(inode),
        Err(error) => {
            let cleanup = delete_host_visible_namespace(nsenter, ip, netns_root, namespace);
            match cleanup {
                Ok(()) => Err(error),
                Err(cleanup_error) => Err(error).context(format!(
                    "host-visible namespace verification cleanup also failed: {cleanup_error:#}"
                )),
            }
        }
    }
}

pub(crate) fn add_host_visible_namespace(
    nsenter: &Path,
    ip: &Path,
    netns_root: &Path,
    namespace: &str,
) -> Result<()> {
    host_mount_ip(nsenter, ip, netns_root, &["netns", "add", namespace])
        .context("create host-visible run network namespace")
}

pub(crate) fn delete_host_visible_namespace(
    nsenter: &Path,
    ip: &Path,
    netns_root: &Path,
    namespace: &str,
) -> Result<()> {
    host_mount_ip(nsenter, ip, netns_root, &["netns", "delete", namespace])
        .context("delete host-visible run network namespace")
}

pub(crate) fn verify_host_visible_namespace(root: &Path, namespace: &str) -> Result<u64> {
    let initial_path = initial_mount_namespace_entry(root, namespace)?;
    namespace_inode_path(&initial_path).context("verify PID-1-view run network namespace")
}

fn host_mount_ip(nsenter: &Path, ip: &Path, netns_root: &Path, args: &[&str]) -> Result<()> {
    validate_iproute2_netns_root(netns_root)?;
    checked_host_mount_ip(nsenter, ip, args.iter().map(OsStr::new)).map(|_| ())
}

/// Execute a fixed trusted helper in PID 1's mount namespace without changing
/// the caller's network namespace.
///
/// iproute2 6.1 resolves named network namespaces through its compile-time
/// `/run/netns` path and ignores `IP_NETNS_DIR`.  Jailerd intentionally has a
/// private mount view, so named `ip` operations must use PID 1's mount view to
/// reach the root-owned nsfs entries that jailerd already verified by inode.
pub(crate) fn checked_host_mount_ip<'a>(
    nsenter: &Path,
    ip: &Path,
    args: impl IntoIterator<Item = &'a OsStr>,
) -> Result<Output> {
    let args = args.into_iter().collect::<Vec<_>>();
    let output = host_mount_ip_command(nsenter, ip, &args)
        .output()
        .with_context(|| {
            format!(
                "execute trusted helper {} in PID 1 mount namespace with arguments {:?}",
                ip.display(),
                args
            )
        })?;
    if !output.status.success() {
        bail!(
            "trusted helper {} failed in PID 1 mount namespace with {} and arguments {:?}: {}",
            ip.display(),
            output.status,
            args,
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }
    Ok(output)
}

fn host_mount_ip_status<'a>(
    nsenter: &Path,
    ip: &Path,
    args: impl IntoIterator<Item = &'a OsStr>,
) -> bool {
    let args = args.into_iter().collect::<Vec<_>>();
    host_mount_ip_command(nsenter, ip, &args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn host_mount_ip_command(nsenter: &Path, ip: &Path, args: &[&OsStr]) -> Command {
    let mut command = Command::new(nsenter);
    command
        .arg(format!("--mount={INITIAL_MOUNT_NAMESPACE}"))
        .arg("--")
        .arg(ip)
        .args(args)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn validate_iproute2_netns_root(root: &Path) -> Result<()> {
    if root != Path::new("/run/netns") {
        bail!("network namespace root must be /run/netns for iproute2 interoperability")
    }
    Ok(())
}

fn derived_topology(request: &EnsureRunNetworkRequest) -> Result<(RunNetworkResult, String)> {
    let digest = Sha256::digest(request.run_id.as_str().as_bytes());
    let mut suffix = String::with_capacity(12);
    for byte in &digest[..6] {
        use std::fmt::Write as _;
        let _ = write!(suffix, "{byte:02x}");
    }
    let slot = u16::from_be_bytes([digest[6], digest[7]]) & 0x7fff;
    let base = u32::from_be_bytes([198, 18, 0, 0]) + u32::from(slot) * 4;
    let host = std::net::Ipv4Addr::from(base + 1);
    let namespace = std::net::Ipv4Addr::from(base + 2);
    Ok((
        RunNetworkResult {
            run_id: request.run_id.clone(),
            namespace_name: format!("intar-ns-{suffix}"),
            namespace_inode: 0,
            bridge_name: format!("ibr{suffix}"),
            host_veth_name: format!("ivh{suffix}"),
            namespace_veth_name: format!("ivn{suffix}"),
            host_transit_cidr: format!("{host}/30"),
            namespace_transit_cidr: format!("{namespace}/30"),
        },
        format!("intar_{suffix}"),
    ))
}

fn derived_tap_mac(guest_mac: &str) -> Result<String> {
    let octets = parse_mac(guest_mac).context("parse guest MAC")?;
    if octets[0] & 0x01 != 0 {
        bail!("guest MAC must be unicast")
    }
    // Toggle a non-domain bit first, then force the host identity back into
    // the locally administered unicast domain. This maps every protocol-valid
    // guest MAC to a distinct host MAC and preserves recovery for legacy
    // global and non-02 local guest addresses. New 02 guests map to 06.
    let tap_prefix = ((octets[0] ^ 0x04) & 0xfe) | 0x02;
    Ok(format_mac(tap_prefix, &octets[1..]))
}

fn derived_bridge_mac(request: &EnsureRunNetworkRequest) -> String {
    let digest = Sha256::digest(request.run_id.as_str().as_bytes());
    format_mac(0x0a, &digest[..5])
}

fn parse_mac(value: &str) -> Result<[u8; 6]> {
    if value.len() != 17 || value != value.to_ascii_lowercase() {
        bail!("MAC must be 6 lowercase hexadecimal octets")
    }
    let mut octets = [0_u8; 6];
    let mut parts = value.split(':');
    for octet in &mut octets {
        let part = parts.next().context("MAC has fewer than 6 octets")?;
        if part.len() != 2 {
            bail!("MAC octets must contain exactly 2 hexadecimal digits")
        }
        *octet = u8::from_str_radix(part, 16).context("MAC contains a non-hexadecimal octet")?;
    }
    if parts.next().is_some() {
        bail!("MAC has more than 6 octets")
    }
    Ok(octets)
}

fn format_mac(prefix: u8, tail: &[u8]) -> String {
    debug_assert_eq!(tail.len(), 5);
    format!(
        "{prefix:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
        tail[0], tail[1], tail[2], tail[3], tail[4]
    )
}

fn link_address_command(namespace: &str, interface: &str, mac: &str) -> Vec<String> {
    [
        "-n", namespace, "link", "set", "dev", interface, "address", mac,
    ]
    .map(str::to_owned)
    .into()
}

fn tap_link_commands(
    network: &RunNetworkResult,
    attachment: &VmNetworkAttachment,
) -> [Vec<String>; 3] {
    [
        link_address_command(
            &network.namespace_name,
            &attachment.tap_name,
            &attachment.tap_mac_address,
        ),
        [
            "-n",
            &network.namespace_name,
            "link",
            "set",
            "dev",
            &attachment.tap_name,
            "master",
            &network.bridge_name,
        ]
        .map(str::to_owned)
        .into(),
        [
            "-n",
            &network.namespace_name,
            "link",
            "set",
            "dev",
            &attachment.tap_name,
            "up",
        ]
        .map(str::to_owned)
        .into(),
    ]
}

fn verify_link_mac(output: &str, expected_mac: &str) -> Result<()> {
    let fields = output.split_whitespace().collect::<Vec<_>>();
    let actual = fields
        .windows(2)
        .find_map(|pair| (pair[0] == "link/ether").then_some(pair[1]))
        .context("link inspection did not report an Ethernet MAC")?;
    if actual != expected_mac {
        bail!("link MAC differs after reconciliation: expected {expected_mac}, found {actual}")
    }
    Ok(())
}

fn attachment_macs_conflict(
    existing: &VmNetworkAttachment,
    guest_mac: &str,
    tap_mac: &str,
) -> bool {
    existing.guest_mac_address == guest_mac
        || existing.guest_mac_address == tap_mac
        || existing.tap_mac_address == guest_mac
        || existing.tap_mac_address == tap_mac
}

fn mac_conflicts_with_bridge(bridge_mac: &str, guest_mac: &str, tap_mac: &str) -> bool {
    bridge_mac == guest_mac || bridge_mac == tap_mac
}

fn render_nft_rules(state: &RunState) -> Result<String> {
    let host_transit = cidr_address(&state.result.host_transit_cidr)?;
    // A destination owned by the host is routed through the input hook, not
    // the forward hook, so the forward-chain `fib daddr type local` guard
    // cannot protect host services by itself. Drop every packet entering from
    // this run's veth at input while leaving all other host interfaces and the
    // run's forwarded traffic untouched.
    let mut rules = format!(
        "table inet {} {{\n  chain input {{\n    type filter hook input priority filter; policy accept;\n    iifname \"{}\" counter drop\n  }}\n  chain forward {{\n    type filter hook forward priority filter; policy accept;\n    iifname \"{}\" meta nfproto ipv6 drop\n    iifname \"{}\" ip saddr != {} drop\n    iifname \"{}\" ct state established,related accept\n    iifname \"{}\" fib daddr type local drop\n",
        state.nft_table,
        state.result.host_veth_name,
        state.result.host_veth_name,
        state.result.host_veth_name,
        state.request.guest_cidr,
        state.result.host_veth_name,
        state.result.host_veth_name
    );
    // The root-owned guest pool is constrained to 10.77.0.0/16, so the 10/8
    // guard isolates every other run without embedding the mutable active-run
    // set in each table. Adding or removing a run can therefore update exactly
    // one nftables table.
    for blocked in [
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "168.63.129.16/32",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "224.0.0.0/4",
    ] {
        rules.push_str(&format!(
            "    iifname \"{}\" ip daddr {blocked} drop\n",
            state.result.host_veth_name
        ));
    }
    rules.push_str(&format!(
        "    iifname \"{}\" ip daddr {host_transit} drop\n",
        state.result.host_veth_name
    ));
    rules.push_str(&format!(
        "    iifname \"{}\" accept\n  }}\n  chain prerouting {{\n    type nat hook prerouting priority dstnat; policy accept;\n",
        state.result.host_veth_name
    ));
    for attachment in state.attachments.values() {
        if attachment.ssh_forward_active
            && let Some(port) = attachment.ssh_public_port
        {
            let guest = cidr_address(&attachment.guest_ip_cidr)?;
            rules.push_str(&format!(
                "    iifname != \"{}\" fib daddr type local tcp dport {port} dnat ip to {guest}:22\n",
                state.result.host_veth_name
            ));
        }
    }
    rules.push_str(&format!(
        "  }}\n  chain postrouting {{\n    type nat hook postrouting priority srcnat; policy accept;\n    ip saddr {} oifname != \"{}\" masquerade\n  }}\n}}\n",
        state.request.guest_cidr, state.result.host_veth_name
    ));
    Ok(rules)
}

fn run_checked<'a>(
    program: &Path,
    args: impl IntoIterator<Item = &'a OsStr>,
    stdin: Option<&[u8]>,
) -> Result<()> {
    let mut child = Command::new(program);
    child
        .args(args)
        .env_clear()
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = child
        .spawn()
        .with_context(|| format!("execute trusted helper {}", program.display()))?;
    if let Some(bytes) = stdin {
        child
            .stdin
            .take()
            .context("helper stdin missing")?
            .write_all(bytes)
            .context("write helper input")?;
    }
    let output = child
        .wait_with_output()
        .context("wait for trusted helper")?;
    if !output.status.success() {
        bail!(
            "trusted helper {} failed with {}: {}",
            program.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }
    Ok(())
}

fn run_status<'a>(program: &Path, args: impl IntoIterator<Item = &'a OsStr>) -> bool {
    Command::new(program)
        .args(args)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn enable_namespace_forwarding(namespace: PathBuf) -> Result<()> {
    std::thread::Builder::new()
        .name("jailerd-netns-sysctl".to_owned())
        .spawn(move || -> Result<()> {
            let fd = open(
                &namespace,
                OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            )
            .with_context(|| format!("open network namespace {}", namespace.display()))?;
            move_into_link_name_space(fd.as_fd(), Some(LinkNameSpaceType::Network))
                .context("enter run network namespace")?;
            std::fs::write("/proc/sys/net/ipv4/ip_forward", b"1\n")
                .context("enable forwarding in run network namespace")
        })
        .context("spawn network namespace configuration thread")?
        .join()
        .map_err(|_| anyhow::anyhow!("network namespace configuration thread panicked"))?
}

fn trusted_tool(candidates: &[&str]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| trusted_regular_file(path))
}

fn namespace_inode_path(path: &Path) -> Result<u64> {
    let fd = open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .with_context(|| format!("open run network namespace {}", path.display()))?;
    let metadata =
        fstat(&fd).with_context(|| format!("stat run network namespace {}", path.display()))?;
    let filesystem =
        fstatfs(&fd).with_context(|| format!("statfs run network namespace {}", path.display()))?;
    if metadata.st_uid != 0 || metadata.st_nlink != 1 || filesystem.f_type != NSFS_MAGIC {
        bail!("run network namespace handle is not a root-owned nsfs entry")
    }
    Ok(metadata.st_ino)
}

fn path_entry_exists(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("inspect path entry {}", path.display())),
    }
}

fn validate_host_netns_root(local_root: &Path, host_root: &Path) -> Result<()> {
    let local = trusted_directory_identity(local_root, "configured network namespace root")?;
    let host = trusted_directory_identity(host_root, "PID-1-view network namespace root")?;
    validate_netns_root_identities(local, host)
}

pub(crate) fn validate_initial_network_namespace() -> Result<()> {
    let current = std::fs::metadata("/proc/self/ns/net")
        .context("stat jailerd network namespace identity")?;
    let initial =
        std::fs::metadata("/proc/1/ns/net").context("stat PID 1 network namespace identity")?;
    if (current.dev(), current.ino()) != (initial.dev(), initial.ino()) {
        bail!("jailerd must remain in PID 1's network namespace")
    }
    Ok(())
}

fn trusted_directory_identity(path: &Path, label: &str) -> Result<DirectoryIdentity> {
    let fd = open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .with_context(|| format!("open {label} {}", path.display()))?;
    let stat = fstat(&fd).with_context(|| format!("stat {label} {}", path.display()))?;
    let identity = DirectoryIdentity {
        device: stat.st_dev as u64,
        inode: stat.st_ino,
        uid: stat.st_uid,
        gid: stat.st_gid,
        mode: stat.st_mode,
    };
    validate_netns_root_identity(identity, label)?;
    Ok(identity)
}

fn validate_netns_root_identity(identity: DirectoryIdentity, label: &str) -> Result<()> {
    if rustix::fs::FileType::from_raw_mode(identity.mode) != rustix::fs::FileType::Directory
        || identity.uid != 0
        || identity.gid != 0
        || identity.mode & 0o022 != 0
    {
        bail!("{label} must be a root-owned, non-writable directory")
    }
    Ok(())
}

fn validate_netns_root_identities(local: DirectoryIdentity, host: DirectoryIdentity) -> Result<()> {
    validate_netns_root_identity(local, "configured network namespace root")?;
    validate_netns_root_identity(host, "PID-1-view network namespace root")?;
    if (local.device, local.inode) != (host.device, host.inode) {
        bail!("network namespace root differs across jailerd and PID 1 mount namespaces")
    }
    Ok(())
}

pub(crate) fn initial_mount_namespace_entry(root: &Path, name: &str) -> Result<PathBuf> {
    Ok(initial_mount_namespace_root(root)?.join(name))
}

pub(crate) fn initial_mount_namespace_root(root: &Path) -> Result<PathBuf> {
    let relative = root
        .strip_prefix("/")
        .context("network namespace root is not absolute")?;
    Ok(Path::new(INITIAL_ROOT).join(relative))
}

fn trusted_regular_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    metadata.file_type().is_file()
        && metadata.uid() == 0
        && metadata.mode() & 0o022 == 0
        && metadata.nlink() == 1
        && trusted_ancestors(path)
}

fn trusted_directory(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    metadata.file_type().is_dir()
        && metadata.uid() == 0
        && metadata.mode() & 0o022 == 0
        && trusted_ancestors(path)
}

fn trusted_ancestors(path: &Path) -> bool {
    let mut current = path.parent();
    while let Some(ancestor) = current {
        let Ok(metadata) = std::fs::symlink_metadata(ancestor) else {
            return false;
        };
        if !metadata.file_type().is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return false;
        }
        current = ancestor.parent();
    }
    true
}

fn cidr_address(cidr: &str) -> Result<String> {
    cidr.split_once('/')
        .map(|(address, _)| address.to_owned())
        .context("validated CIDR lost its prefix")
}

fn cidr_prefix(cidr: &str) -> Result<u8> {
    cidr.split_once('/')
        .context("validated CIDR lost its prefix")?
        .1
        .parse()
        .context("validated CIDR has invalid prefix")
}

fn ipv4_cidr_contains(network: &str, address: &str) -> Result<bool> {
    let (network_address, prefix) = parse_ipv4_cidr(network)?;
    let (address, _) = parse_ipv4_cidr(address)?;
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix))
    };
    Ok(u32::from(network_address) & mask == u32::from(address) & mask)
}

fn ipv4_cidrs_overlap(left: &str, right: &str) -> Result<bool> {
    let (left_address, left_prefix) = parse_ipv4_cidr(left)?;
    let (right_address, right_prefix) = parse_ipv4_cidr(right)?;
    let prefix = left_prefix.min(right_prefix);
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix))
    };
    Ok(u32::from(left_address) & mask == u32::from(right_address) & mask)
}

fn validate_guest_address(run: &EnsureRunNetworkRequest, request: &VmLaunchRequest) -> Result<()> {
    let (network, prefix) = parse_ipv4_cidr(&run.guest_cidr)?;
    let (address, address_prefix) = parse_ipv4_cidr(&request.guest_ip_cidr)?;
    if prefix != address_prefix {
        bail!("VM guest address prefix differs from its run network")
    }
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix))
    };
    let network = u32::from(network) & mask;
    let address = u32::from(address);
    let broadcast = network | !mask;
    let gateway: std::net::Ipv4Addr = run.gateway.parse().context("parse run gateway")?;
    if address == network || address == broadcast || address == u32::from(gateway) {
        bail!("VM guest address is reserved by the run topology")
    }
    Ok(())
}

fn parse_ipv4_cidr(value: &str) -> Result<(std::net::Ipv4Addr, u8)> {
    let (address, prefix) = value
        .split_once('/')
        .context("validated IPv4 CIDR lost its prefix")?;
    let address = address
        .parse()
        .context("validated IPv4 address is invalid")?;
    let prefix: u8 = prefix.parse().context("validated IPv4 prefix is invalid")?;
    if prefix > 32 {
        bail!("IPv4 prefix exceeds 32")
    }
    Ok((address, prefix))
}

fn route_is_owned(output: &str, cidr: &str, via: &str, device: &str) -> bool {
    output.lines().map(str::split_whitespace).any(|fields| {
        let fields = fields.collect::<Vec<_>>();
        fields.first() == Some(&cidr)
            && fields.windows(2).any(|pair| pair == ["via", via])
            && fields.windows(2).any(|pair| pair == ["dev", device])
            && fields.windows(2).any(|pair| pair == ["proto", "242"])
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_mount_namespace_entry_stays_beneath_pid_one_root() {
        assert_eq!(
            initial_mount_namespace_root(Path::new("/run/netns")).unwrap(),
            Path::new("/proc/1/root/run/netns")
        );
        assert_eq!(
            initial_mount_namespace_entry(Path::new("/run/netns"), "intar-ns-test").unwrap(),
            Path::new("/proc/1/root/run/netns/intar-ns-test")
        );
    }

    #[test]
    fn initial_mount_namespace_root_rejects_relative_paths() {
        let error = initial_mount_namespace_root(Path::new("run/netns")).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("network namespace root is not absolute"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn iproute2_operations_enter_only_pid_one_mount_namespace() {
        let arguments = [
            OsStr::new("-n"),
            OsStr::new("intar-test"),
            OsStr::new("link"),
        ];
        let command = host_mount_ip_command(
            Path::new("/usr/bin/nsenter"),
            Path::new("/usr/sbin/ip"),
            &arguments,
        );
        assert_eq!(command.get_program(), OsStr::new("/usr/bin/nsenter"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![
                OsStr::new("--mount=/proc/1/ns/mnt"),
                OsStr::new("--"),
                OsStr::new("/usr/sbin/ip"),
                OsStr::new("-n"),
                OsStr::new("intar-test"),
                OsStr::new("link"),
            ]
        );
    }

    #[test]
    fn iproute2_requires_the_compile_time_namespace_root() {
        validate_iproute2_netns_root(Path::new("/run/netns")).unwrap();
        let error = validate_iproute2_netns_root(Path::new("/var/lib/intar/netns")).unwrap_err();
        assert!(
            error.to_string().contains("must be /run/netns"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn netns_root_identity_requires_matching_safe_root_directories() {
        let trusted = DirectoryIdentity {
            device: 7,
            inode: 11,
            uid: 0,
            gid: 0,
            mode: 0o040755,
        };
        validate_netns_root_identities(trusted, trusted).unwrap();

        let replaced = DirectoryIdentity {
            inode: 12,
            ..trusted
        };
        let error = validate_netns_root_identities(trusted, replaced).unwrap_err();
        assert!(
            error.to_string().contains("root differs across"),
            "unexpected error: {error:#}"
        );

        let writable = DirectoryIdentity {
            mode: 0o040777,
            ..trusted
        };
        let error = validate_netns_root_identities(trusted, writable).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("root-owned, non-writable directory"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn namespace_inode_rejects_an_ordinary_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("not-a-namespace");
        std::fs::write(&path, b"").unwrap();
        let error = namespace_inode_path(&path).unwrap_err();
        assert!(
            error.to_string().contains("not a root-owned nsfs entry"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn path_entry_probe_distinguishes_missing_dangling_and_inspection_errors() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing");
        assert!(!path_entry_exists(&missing).unwrap());
        std::os::unix::fs::symlink("missing-target", directory.path().join("link")).unwrap();
        assert!(path_entry_exists(&directory.path().join("link")).unwrap());
        std::fs::write(directory.path().join("file"), b"").unwrap();
        let error = path_entry_exists(&directory.path().join("file/child")).unwrap_err();
        assert!(
            error.to_string().contains("inspect path entry"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn repair_never_replaces_a_missing_tracked_namespace_identity() {
        let directory = tempfile::tempdir().unwrap();
        let request = EnsureRunNetworkRequest {
            run_id: ValidatedId::parse("run").unwrap(),
            guest_cidr: "10.77.0.0/28".to_owned(),
            gateway: "10.77.0.1".to_owned(),
        };
        let (mut result, nft_table) = derived_topology(&request).unwrap();
        result.namespace_inode = 17;
        let manager = NetworkManager {
            ip: PathBuf::from("/unreachable/ip"),
            nft: PathBuf::from("/unreachable/nft"),
            nsenter: PathBuf::from("/unreachable/nsenter"),
            netns_root: directory.path().to_path_buf(),
            host_netns_root: directory.path().to_path_buf(),
            policy: JailerdConfig::default(),
            runs: BTreeMap::new(),
        };
        let error = manager
            .construct_run(&RunState {
                request,
                result,
                nft_table,
                attachments: BTreeMap::new(),
                installed: true,
            })
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("refusing to replace a missing tracked run network namespace"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn derived_interface_names_are_stable_distinct_and_fit_linux_limit() {
        let request = EnsureRunNetworkRequest {
            run_id: ValidatedId::parse("run-with-a-very-long-identifier").unwrap(),
            guest_cidr: "10.77.0.0/24".to_owned(),
            gateway: "10.77.0.1".to_owned(),
        };
        let (first, _) = derived_topology(&request).unwrap();
        let (second, _) = derived_topology(&request).unwrap();
        assert_eq!(first, second);
        assert!(first.bridge_name.len() <= 15);
        assert!(first.host_veth_name.len() <= 15);
        assert!(first.namespace_veth_name.len() <= 15);
        assert_ne!(first.bridge_name, first.host_veth_name);
    }

    #[test]
    fn guest_tap_and_bridge_macs_are_stable_local_unicast_and_disjoint() {
        let request = EnsureRunNetworkRequest {
            run_id: ValidatedId::parse("run-a").unwrap(),
            guest_cidr: "10.77.0.0/24".to_owned(),
            gateway: "10.77.0.1".to_owned(),
        };
        let guest = "02:11:22:33:44:55";
        let tap = derived_tap_mac(guest).unwrap();
        let bridge = derived_bridge_mac(&request);

        assert_eq!(tap, "06:11:22:33:44:55");
        assert_eq!(bridge, derived_bridge_mac(&request));
        assert_ne!(guest, tap);
        assert_ne!(guest, bridge);
        assert_ne!(tap, bridge);
        for mac in [guest, tap.as_str(), bridge.as_str()] {
            let octets = parse_mac(mac).unwrap();
            assert_eq!(octets[0] & 0x01, 0, "{mac} must be unicast");
            assert_eq!(octets[0] & 0x02, 0x02, "{mac} must be local");
        }
    }

    #[test]
    fn tap_mac_derivation_preserves_legacy_unicast_recovery() {
        assert_eq!(
            derived_tap_mac("06:11:22:33:44:55").unwrap(),
            "02:11:22:33:44:55"
        );
        assert_eq!(
            derived_tap_mac("00:11:22:33:44:55").unwrap(),
            "06:11:22:33:44:55"
        );
        assert_eq!(
            derived_tap_mac("0a:11:22:33:44:55").unwrap(),
            "0e:11:22:33:44:55"
        );
    }

    #[test]
    fn tap_mac_derivation_rejects_malformed_and_multicast_guest_macs() {
        for invalid in [
            "03:11:22:33:44:55",
            "02:11:22:33:44",
            "02:11:22:33:44:555",
            "02:11:22:33:44:GG",
            "02:11:22:33:44:AA",
        ] {
            assert!(
                derived_tap_mac(invalid).is_err(),
                "accepted invalid guest MAC {invalid:?}"
            );
        }
    }

    #[test]
    fn attachment_collision_checks_cover_guest_tap_cross_class_and_bridge_domains() {
        let existing = VmNetworkAttachment {
            generation: ValidatedId::parse("generation").unwrap(),
            vm_id: ValidatedId::parse("vm").unwrap(),
            tap_name: "tap0".to_owned(),
            guest_mac_address: "02:11:22:33:44:55".to_owned(),
            tap_mac_address: "06:11:22:33:44:55".to_owned(),
            guest_ip_cidr: "10.77.0.2/24".to_owned(),
            ssh_public_port: None,
            ssh_forward_active: false,
            vsock_cid: 3,
            uid: 200_000,
            gid: 200_000,
        };
        for (guest, tap) in [
            ("02:11:22:33:44:55", "06:00:00:00:00:01"),
            ("02:00:00:00:00:01", "02:11:22:33:44:55"),
            ("06:11:22:33:44:55", "06:00:00:00:00:01"),
            ("02:00:00:00:00:01", "06:11:22:33:44:55"),
        ] {
            assert!(attachment_macs_conflict(&existing, guest, tap));
        }
        assert!(!attachment_macs_conflict(
            &existing,
            "02:00:00:00:00:01",
            "06:00:00:00:00:01"
        ));
        assert!(mac_conflicts_with_bridge(
            "0a:11:22:33:44:55",
            "0a:11:22:33:44:55",
            "06:00:00:00:00:01"
        ));
        assert!(mac_conflicts_with_bridge(
            "0a:11:22:33:44:55",
            "02:00:00:00:00:01",
            "0a:11:22:33:44:55"
        ));
    }

    #[test]
    fn create_and_recovery_tap_commands_use_only_the_derived_host_mac() {
        let request = EnsureRunNetworkRequest {
            run_id: ValidatedId::parse("run-a").unwrap(),
            guest_cidr: "10.77.0.0/24".to_owned(),
            gateway: "10.77.0.1".to_owned(),
        };
        let (network, _) = derived_topology(&request).unwrap();
        let attachment = VmNetworkAttachment {
            generation: ValidatedId::parse("generation").unwrap(),
            vm_id: ValidatedId::parse("vm").unwrap(),
            tap_name: "tap0".to_owned(),
            guest_mac_address: "02:11:22:33:44:55".to_owned(),
            tap_mac_address: derived_tap_mac("02:11:22:33:44:55").unwrap(),
            guest_ip_cidr: "10.77.0.2/24".to_owned(),
            ssh_public_port: None,
            ssh_forward_active: false,
            vsock_cid: 3,
            uid: 200_000,
            gid: 200_000,
        };

        // Fresh creation and durable recovery both execute this exact command
        // sequence through `configure_tap`.
        let commands = tap_link_commands(&network, &attachment);
        assert_eq!(
            commands[0],
            vec![
                "-n",
                network.namespace_name.as_str(),
                "link",
                "set",
                "dev",
                "tap0",
                "address",
                "06:11:22:33:44:55",
            ]
        );
        assert!(
            commands
                .iter()
                .flatten()
                .all(|argument| argument != &attachment.guest_mac_address),
            "host link commands must never assign the guest MAC"
        );
    }

    #[test]
    fn bridge_mac_reconciliation_command_and_verification_are_exact() {
        assert_eq!(
            link_address_command("intar-ns-test", "ibrtest", "0a:11:22:33:44:55"),
            vec![
                "-n",
                "intar-ns-test",
                "link",
                "set",
                "dev",
                "ibrtest",
                "address",
                "0a:11:22:33:44:55",
            ]
        );
        verify_link_mac(
            "7: ibrtest: <BROADCAST> mtu 1500 link/ether 0a:11:22:33:44:55 brd ff:ff:ff:ff:ff:ff",
            "0a:11:22:33:44:55",
        )
        .unwrap();
        assert!(
            verify_link_mac(
                "7: ibrtest: <BROADCAST> mtu 1500 link/ether 0a:00:00:00:00:01 brd ff:ff:ff:ff:ff:ff",
                "0a:11:22:33:44:55",
            )
            .is_err()
        );
        assert!(verify_link_mac("7: ibrtest: <BROADCAST>", "0a:11:22:33:44:55").is_err());
    }

    #[test]
    fn containment_uses_prefix_not_string_matching() {
        assert!(ipv4_cidr_contains("10.7.0.0/24", "10.7.0.25/24").unwrap());
        assert!(!ipv4_cidr_contains("10.7.0.0/24", "10.7.1.25/24").unwrap());
    }

    #[test]
    fn overlap_detection_handles_different_prefix_lengths() {
        assert!(ipv4_cidrs_overlap("10.7.0.0/24", "10.7.0.128/25").unwrap());
        assert!(!ipv4_cidrs_overlap("10.7.0.0/24", "10.7.1.0/24").unwrap());
    }

    #[test]
    fn guest_address_rejects_gateway_network_broadcast_and_prefix_drift() {
        let run = EnsureRunNetworkRequest {
            run_id: ValidatedId::parse("run").unwrap(),
            guest_cidr: "10.7.0.0/29".to_owned(),
            gateway: "10.7.0.1".to_owned(),
        };
        let request = |address: &str| VmLaunchRequest {
            run_id: run.run_id.clone(),
            vm_id: ValidatedId::parse("vm").unwrap(),
            cpu_millis: 125,
            vcpu_count: 1,
            memory_mib: 512,
            root_disk_size_bytes: 4 * 1024 * 1024 * 1024,
            tap_name: "tap0".to_owned(),
            mac_address: "02:00:00:00:00:01".to_owned(),
            guest_ip_cidr: address.to_owned(),
            ssh_public_port: None,
            vsock_cid: 3,
            artifacts: intar_jailer_protocol::SourceArtifacts {
                kernel: artifact("kernel", intar_jailer_protocol::ArtifactAccess::ReadOnly),
                initrd: None,
                root_disk: artifact("root.raw", intar_jailer_protocol::ArtifactAccess::ReadWrite),
                runtime_disk: artifact(
                    "runtime.raw",
                    intar_jailer_protocol::ArtifactAccess::ReadOnly,
                ),
                recording_disk: artifact(
                    "recording.raw",
                    intar_jailer_protocol::ArtifactAccess::ReadWrite,
                ),
            },
        };
        assert!(validate_guest_address(&run, &request("10.7.0.2/29")).is_ok());
        for invalid in ["10.7.0.0/29", "10.7.0.1/29", "10.7.0.7/29", "10.7.0.2/32"] {
            assert!(validate_guest_address(&run, &request(invalid)).is_err());
        }
    }

    #[test]
    fn nft_policy_blocks_host_cross_run_private_and_metadata_destinations() {
        let request = EnsureRunNetworkRequest {
            run_id: ValidatedId::parse("run-a").unwrap(),
            guest_cidr: "10.77.0.0/29".to_owned(),
            gateway: "10.77.0.1".to_owned(),
        };
        let (result, nft_table) = derived_topology(&request).unwrap();
        let mut attachments = BTreeMap::new();
        attachments.insert(
            ValidatedId::parse("generation").unwrap(),
            VmNetworkAttachment {
                generation: ValidatedId::parse("generation").unwrap(),
                vm_id: ValidatedId::parse("vm").unwrap(),
                tap_name: "tap0".to_owned(),
                guest_mac_address: "02:00:00:00:00:01".to_owned(),
                tap_mac_address: "06:00:00:00:00:01".to_owned(),
                guest_ip_cidr: "10.77.0.2/29".to_owned(),
                ssh_public_port: Some(22_001),
                ssh_forward_active: true,
                vsock_cid: 3,
                uid: 200_000,
                gid: 200_000,
            },
        );
        let state = RunState {
            request,
            result,
            nft_table,
            attachments,
            installed: false,
        };

        let rules = render_nft_rules(&state).unwrap();

        let mut inactive = state.clone();
        inactive
            .attachments
            .values_mut()
            .next()
            .expect("attachment")
            .ssh_forward_active = false;
        let inactive_rules = render_nft_rules(&inactive).unwrap();
        assert!(
            !inactive_rules.contains("tcp dport 22001"),
            "reserved boot-phase SSH port became externally reachable"
        );

        let input_chain = format!(
            "chain input {{\n    type filter hook input priority filter; policy accept;\n    iifname \"{}\" counter drop\n  }}",
            state.result.host_veth_name
        );
        assert!(
            rules.contains(&input_chain),
            "host-local traffic must be dropped in the input hook, scoped to the run veth"
        );
        let input_position = rules.find("chain input {").unwrap();
        let forward_position = rules.find("chain forward {").unwrap();
        assert!(
            input_position < forward_position,
            "the independent input guard must be installed before the forward policy"
        );
        let source_guard = format!(
            "iifname \"{}\" ip saddr != 10.77.0.0/29 drop",
            state.result.host_veth_name
        );
        let established_accept = format!(
            "iifname \"{}\" ct state established,related accept",
            state.result.host_veth_name
        );
        assert!(
            rules.find(&source_guard).unwrap() < rules.find(&established_accept).unwrap(),
            "source anti-spoofing must run before the established-flow fast path"
        );
        let forward_accept = format!("iifname \"{}\" accept", state.result.host_veth_name);
        let ssh_dnat = format!(
            "iifname != \"{}\" fib daddr type local tcp dport 22001 dnat ip to 10.77.0.2:22",
            state.result.host_veth_name
        );
        let egress_masquerade = format!(
            "ip saddr 10.77.0.0/29 oifname != \"{}\" masquerade",
            state.result.host_veth_name
        );

        for required in [
            "type filter hook forward priority filter; policy accept",
            "meta nfproto ipv6 drop",
            "fib daddr type local drop",
            "ip daddr 10.0.0.0/8 drop",
            "ip daddr 100.64.0.0/10 drop",
            "ip daddr 169.254.0.0/16 drop",
            "ip daddr 168.63.129.16/32 drop",
            "ip daddr 172.16.0.0/12 drop",
            "ip daddr 192.168.0.0/16 drop",
        ] {
            assert!(rules.contains(required), "missing nft rule: {required}");
        }
        for (rule, purpose) in [
            (&forward_accept, "run forwarding"),
            (&ssh_dnat, "external SSH DNAT"),
            (&egress_masquerade, "internet egress"),
        ] {
            assert!(rules.contains(rule), "missing {purpose} rule: {rule}");
        }
        assert!(
            !rules.contains("ip daddr 10.77.0.0/29 drop"),
            "same-run L2 range must not be blocked by the host policy"
        );
    }

    fn artifact(
        path: &str,
        access: intar_jailer_protocol::ArtifactAccess,
    ) -> intar_jailer_protocol::ArtifactSource {
        intar_jailer_protocol::ArtifactSource {
            source_root: 0,
            relative_path: path.into(),
            sha256: None,
            access,
        }
    }
}
