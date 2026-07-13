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
use std::process::{Command, Stdio};

use anyhow::{Context as _, Result, bail};
use intar_jailer_protocol::{
    EnsureRunNetworkRequest, JailerdConfig, RunNetworkResult, ValidatedId, VmLaunchRequest,
};
use rustix::fs::{Mode, OFlags, open};
use rustix::thread::{LinkNameSpaceType, move_into_link_name_space};
use sha2::{Digest as _, Sha256};

const IP_CANDIDATES: &[&str] = &["/usr/sbin/ip", "/usr/bin/ip"];
const NFT_CANDIDATES: &[&str] = &["/usr/sbin/nft", "/usr/bin/nft"];

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VmNetworkAttachment {
    pub generation: ValidatedId,
    pub vm_id: ValidatedId,
    pub tap_name: String,
    pub mac_address: String,
    pub guest_ip_cidr: String,
    pub ssh_public_port: Option<u16>,
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
    netns_root: PathBuf,
    policy: JailerdConfig,
    runs: BTreeMap<ValidatedId, RunState>,
}

impl NetworkManager {
    pub(crate) fn new(config: &JailerdConfig) -> Result<Self> {
        let netns_root = config.netns_root.clone();
        let ip = trusted_tool(IP_CANDIDATES).context("find trusted iproute2 binary")?;
        let nft = trusted_tool(NFT_CANDIDATES).context("find trusted nft binary")?;
        if !netns_root.is_absolute() || !trusted_directory(&netns_root) {
            bail!(
                "network namespace root is not a trusted root-owned directory: {}",
                netns_root.display()
            )
        }
        if !std::fs::read_to_string("/proc/sys/net/ipv4/ip_forward")
            .is_ok_and(|value| value.trim() == "1")
        {
            bail!("host IPv4 forwarding is disabled")
        }
        Ok(Self {
            ip,
            nft,
            netns_root,
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
        let installed = self.nft_succeeds(&["list", "table", "inet", &nft_table]);
        let mut state = RunState {
            request: request.clone(),
            result: result.clone(),
            nft_table,
            attachments: BTreeMap::new(),
            installed,
        };
        self.construct_run(&state)?;
        result.namespace_inode = namespace_inode(&self.netns_root, &result.namespace_name)?;
        state.result = result.clone();
        self.runs.insert(request.run_id.clone(), state);
        if let Err(error) = self.render_all() {
            let _ = self.destroy_run_physical(&result);
            self.runs.remove(&request.run_id);
            return Err(error).context("install run network policy");
        }
        Ok(result)
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
        if self.runs.values().any(|other| {
            other.attachments.values().any(|attachment| {
                attachment.tap_name == request.tap_name
                    || attachment.mac_address == request.mac_address
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
            mac_address: request.mac_address.clone(),
            guest_ip_cidr: request.guest_ip_cidr.clone(),
            ssh_public_port: request.ssh_public_port,
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
        if let Err(error) = self.render_all() {
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
        let attachment = VmNetworkAttachment {
            generation: generation.clone(),
            vm_id: request.vm_id.clone(),
            tap_name: request.tap_name.clone(),
            mac_address: request.mac_address.clone(),
            guest_ip_cidr: request.guest_ip_cidr.clone(),
            ssh_public_port: request.ssh_public_port,
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
            other.attachments.values().any(|existing| {
                existing.tap_name == attachment.tap_name
                    || existing.mac_address == attachment.mac_address
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
        if let Err(error) = self.render_all() {
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
        if let Err(error) = self.render_all() {
            self.runs
                .get_mut(run_id)
                .context("run state disappeared during policy rollback")?
                .attachments
                .insert(generation.clone(), attachment);
            return Err(error).context("remove VM forwarding policy");
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
        if self.ip_succeeds(&["link", "show", "dev", &result.host_veth_name]) {
            self.ip(&["link", "delete", &result.host_veth_name])
                .context("delete host run veth")?;
        }
        let namespace_path = self.netns_root.join(&result.namespace_name);
        if namespace_path.exists() {
            self.ip(&["netns", "delete", &result.namespace_name])
                .context("delete run network namespace")?;
        }
        Ok(())
    }

    fn construct_run(&self, state: &RunState) -> Result<()> {
        let namespace = &state.result.namespace_name;
        let bridge = &state.result.bridge_name;
        let host_veth = &state.result.host_veth_name;
        let namespace_veth = &state.result.namespace_veth_name;
        let namespace_path = self.netns_root.join(namespace);
        let created_namespace = !namespace_path.exists();
        if created_namespace {
            self.ip(&["netns", "add", namespace])?;
        } else {
            self.ip(&["-n", namespace, "link", "show", "lo"])
                .context("verify existing network namespace")?;
        }

        let operation = (|| -> Result<()> {
            if !self.ip_succeeds(&["link", "show", "dev", host_veth])
                && !self.ip_succeeds(&["-n", namespace, "link", "show", "dev", namespace_veth])
            {
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
                self.ip(&["link", "set", namespace_veth, "netns", namespace])?;
            }
            if !self.ip_succeeds(&["-n", namespace, "link", "show", "dev", bridge]) {
                self.ip(&["-n", namespace, "link", "add", bridge, "type", "bridge"])?;
            }

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
        if operation.is_err() && created_namespace {
            self.ip_ignore(&["netns".to_owned(), "delete".to_owned(), namespace.clone()]);
        }
        operation
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
        let operation = (|| -> Result<()> {
            self.ip(&[
                "-n",
                namespace,
                "link",
                "set",
                "dev",
                &attachment.tap_name,
                "address",
                &attachment.mac_address,
            ])?;
            self.ip(&[
                "-n",
                namespace,
                "link",
                "set",
                "dev",
                &attachment.tap_name,
                "master",
                &network.bridge_name,
            ])?;
            self.ip(&[
                "-n",
                namespace,
                "link",
                "set",
                "dev",
                &attachment.tap_name,
                "up",
            ])
        })();
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
        self.ip(&[
            "-n",
            namespace,
            "link",
            "set",
            "dev",
            &attachment.tap_name,
            "address",
            &attachment.mac_address,
        ])?;
        self.ip(&[
            "-n",
            namespace,
            "link",
            "set",
            "dev",
            &attachment.tap_name,
            "master",
            &network.bridge_name,
        ])?;
        self.ip(&[
            "-n",
            namespace,
            "link",
            "set",
            "dev",
            &attachment.tap_name,
            "up",
        ])
    }

    fn render_all(&mut self) -> Result<()> {
        let run_cidrs = self
            .runs
            .values()
            .map(|state| state.request.guest_cidr.as_str())
            .collect::<Vec<_>>();
        let mut transaction = String::new();
        for state in self.runs.values() {
            if state.installed {
                transaction.push_str(&format!("delete table inet {}\n", state.nft_table));
            }
            transaction.push_str(&render_nft_rules(state, &run_cidrs)?);
        }
        if !transaction.is_empty() {
            self.nft_script(&transaction)
                .context("atomically install run nftables policy")?;
        }
        for state in self.runs.values_mut() {
            state.installed = true;
        }
        Ok(())
    }

    fn render_without_run(&mut self, removed: &ValidatedId) -> Result<()> {
        let run_cidrs = self
            .runs
            .iter()
            .filter(|(run_id, _)| *run_id != removed)
            .map(|(_, state)| state.request.guest_cidr.as_str())
            .collect::<Vec<_>>();
        let mut transaction = String::new();
        for (run_id, state) in &self.runs {
            if state.installed {
                transaction.push_str(&format!("delete table inet {}\n", state.nft_table));
            }
            if run_id != removed {
                transaction.push_str(&render_nft_rules(state, &run_cidrs)?);
            }
        }
        if !transaction.is_empty() {
            self.nft_script(&transaction)
                .context("atomically remove run nftables policy")?;
        }
        for (run_id, state) in &mut self.runs {
            if run_id != removed {
                state.installed = true;
            }
        }
        Ok(())
    }

    fn ip(&self, args: &[&str]) -> Result<()> {
        run_checked(
            &self.ip,
            args.iter().map(OsStr::new),
            None,
            &self.netns_root,
        )
    }

    fn ip_succeeds(&self, args: &[&str]) -> bool {
        run_status(&self.ip, args.iter().map(OsStr::new), &self.netns_root)
    }

    fn ip_output(&self, args: &[&str]) -> Result<String> {
        run_output(&self.ip, args.iter().map(OsStr::new), &self.netns_root)
    }

    fn nft_succeeds(&self, args: &[&str]) -> bool {
        run_status(&self.nft, args.iter().map(OsStr::new), &self.netns_root)
    }

    fn ip_ignore(&self, args: &[String]) {
        let _ = run_status(
            &self.ip,
            args.iter().map(String::as_str).map(OsStr::new),
            &self.netns_root,
        );
    }

    fn ip_strings(&self, args: &[String]) -> Result<()> {
        run_checked(
            &self.ip,
            args.iter().map(String::as_str).map(OsStr::new),
            None,
            &self.netns_root,
        )
    }

    fn nft_script(&self, script: &str) -> Result<()> {
        run_checked(
            &self.nft,
            [OsStr::new("--check"), OsStr::new("-f"), OsStr::new("-")],
            Some(script.as_bytes()),
            &self.netns_root,
        )?;
        run_checked(
            &self.nft,
            [OsStr::new("-f"), OsStr::new("-")],
            Some(script.as_bytes()),
            &self.netns_root,
        )
    }
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

fn render_nft_rules(state: &RunState, run_cidrs: &[&str]) -> Result<String> {
    let host_transit = cidr_address(&state.result.host_transit_cidr)?;
    let mut rules = format!(
        "table inet {} {{\n  chain forward {{\n    type filter hook forward priority filter; policy accept;\n    iifname \"{}\" ct state established,related accept\n    iifname \"{}\" meta nfproto ipv6 drop\n    iifname \"{}\" fib daddr type local drop\n",
        state.nft_table,
        state.result.host_veth_name,
        state.result.host_veth_name,
        state.result.host_veth_name
    );
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
    for cidr in run_cidrs {
        if *cidr != state.request.guest_cidr {
            rules.push_str(&format!(
                "    iifname \"{}\" ip daddr {cidr} drop\n",
                state.result.host_veth_name
            ));
        }
    }
    rules.push_str(&format!(
        "    iifname \"{}\" accept\n  }}\n  chain prerouting {{\n    type nat hook prerouting priority dstnat; policy accept;\n",
        state.result.host_veth_name
    ));
    for attachment in state.attachments.values() {
        if let Some(port) = attachment.ssh_public_port {
            let guest = cidr_address(&attachment.guest_ip_cidr)?;
            rules.push_str(&format!(
                "    iifname != \"{}\" tcp dport {port} dnat ip to {guest}:22\n",
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
    netns_root: &Path,
) -> Result<()> {
    let mut child = Command::new(program);
    child
        .args(args)
        .env_clear()
        .env("IP_NETNS_DIR", netns_root)
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

fn run_status<'a>(
    program: &Path,
    args: impl IntoIterator<Item = &'a OsStr>,
    netns_root: &Path,
) -> bool {
    Command::new(program)
        .args(args)
        .env_clear()
        .env("IP_NETNS_DIR", netns_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn run_output<'a>(
    program: &Path,
    args: impl IntoIterator<Item = &'a OsStr>,
    netns_root: &Path,
) -> Result<String> {
    let output = Command::new(program)
        .args(args)
        .env_clear()
        .env("IP_NETNS_DIR", netns_root)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("execute trusted helper {}", program.display()))?;
    if !output.status.success() {
        bail!(
            "trusted helper {} failed with {}: {}",
            program.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }
    String::from_utf8(output.stdout).context("trusted helper emitted non-UTF-8 output")
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

fn namespace_inode(root: &Path, name: &str) -> Result<u64> {
    let path = root.join(name);
    let metadata = std::fs::symlink_metadata(&path)
        .with_context(|| format!("stat run network namespace {}", path.display()))?;
    if metadata.file_type().is_symlink() || metadata.uid() != 0 {
        bail!("run network namespace handle is not a root-owned nsfs entry")
    }
    Ok(metadata.ino())
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
                mac_address: "02:00:00:00:00:01".to_owned(),
                guest_ip_cidr: "10.77.0.2/29".to_owned(),
                ssh_public_port: Some(22_001),
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

        let rules = render_nft_rules(&state, &["10.77.0.0/29", "10.78.0.0/29"]).unwrap();

        for required in [
            "meta nfproto ipv6 drop",
            "fib daddr type local drop",
            "ip daddr 10.0.0.0/8 drop",
            "ip daddr 100.64.0.0/10 drop",
            "ip daddr 169.254.0.0/16 drop",
            "ip daddr 168.63.129.16/32 drop",
            "ip daddr 172.16.0.0/12 drop",
            "ip daddr 192.168.0.0/16 drop",
            "ip daddr 10.78.0.0/29 drop",
            "tcp dport 22001 dnat ip to 10.77.0.2:22",
            "ip saddr 10.77.0.0/29",
            "masquerade",
        ] {
            assert!(rules.contains(required), "missing nft rule: {required}");
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
