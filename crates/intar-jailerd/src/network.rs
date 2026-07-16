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

mod topology;
use topology::*;
pub(crate) use topology::{initial_mount_namespace_entry, validate_initial_network_namespace};
#[cfg(test)]
mod tests;
