//! What a build runs, from a bundle alone: the target's key and its chain
//! recomputed, the stages in run order, `defer` and the geometry (#311 §6).

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context as _, Result, bail, ensure};
use intar_contracts::oci::OciDigest;
use intar_contracts::scenario::{
    ImageV1, PLATFORM_BASE_IMAGE, ScriptV1, base_key, build_keys, image_keys,
};
use intar_contracts::source::{SourceBundleV2, validate_bundle};

use crate::checkpoint::CheckpointIdentity;
use crate::platform::PLATFORM_BASE_DISK_BYTES;
use crate::sha256::sha256_bytes_hex;

const MIB: u64 = 1024 * 1024;
/// The checkpoint namespace: one scope per checkpoint, so retention is the
/// cache's LRU alone.
const CHECKPOINT_SCOPE: &str = "intar-image-3/stage";
/// Changes with anything the driver does around a stage.
pub(crate) const PROVISIONING_ABI: &str = "intar-machine-stages-v1";

/// What to build out of a bundle.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BuildTarget {
    /// The platform base `trixie`: no stages, finalize and repack only.
    Base,
    /// A repository image.
    Image(String),
    /// A scenario's machine.
    Machine { scenario: String, machine: String },
}

/// One node of the chain: the base's children first.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlannedNode {
    pub name: String,
    pub key: OciDigest,
    pub parent_key: OciDigest,
}

/// One stage as it runs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlannedStage {
    /// The key of the node whose setup this is.
    pub node_key: OciDigest,
    pub name: String,
    pub script: String,
    /// Empty for a chain image; the machine's `env` for its own stages.
    pub env: BTreeMap<String, String>,
}

/// A checked build of one target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BuildPlan {
    pub build_key: OciDigest,
    pub chain: Vec<PlannedNode>,
    pub stages: Vec<PlannedStage>,
    /// The union of the chain's and the target's `defer`.
    pub defer: BTreeSet<String>,
    pub disk_bytes: u64,
    /// Set when the target is a wake image or a machine from one.
    pub wake: Option<WakeRole>,
}

/// What a target is to the wake steps (#348 §3).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WakeRole {
    /// A wake image: built as usual, then booted and suspended.
    Base,
    /// A machine from the wake image `base`: its own stages run in the
    /// woken base, and its suspended guest is published as a delta.
    Pack { base: String },
}

/// Validate `bundle` strictly, recompute the target's key and its chain's
/// keys, and refuse when `expected_key` differs from the recomputed one.
///
/// # Errors
/// Returns every validation problem, an unknown target, a key mismatch or a
/// geometry under the base's 2 GiB.
pub fn plan_build(
    bundle: &SourceBundleV2,
    target: &BuildTarget,
    expected_key: Option<&OciDigest>,
) -> Result<BuildPlan> {
    if let Err(problems) = validate_bundle(bundle) {
        bail!("the bundle is invalid:\n{}", problems.join("\n"));
    }
    let image_keys = image_keys(&bundle.images).map_err(anyhow::Error::msg)?;
    let images: BTreeMap<&str, &ImageV1> = bundle
        .images
        .iter()
        .map(|image| (image.name.as_str(), image))
        .collect();
    let (build_key, from, own) = match target {
        BuildTarget::Base => (base_key(), None, None),
        BuildTarget::Image(name) => {
            let image = images
                .get(name.as_str())
                .with_context(|| format!("the bundle has no image `{name}`"))?;
            let key = image_keys.get(name).context("image key")?.clone();
            (key, Some(image.from.as_str()), None)
        }
        BuildTarget::Machine { scenario, machine } => {
            let found = bundle
                .scenarios
                .iter()
                .find(|candidate| candidate.slug == *scenario)
                .with_context(|| format!("the bundle has no scenario `{scenario}`"))?;
            let spec = found
                .machines
                .iter()
                .find(|candidate| candidate.name == *machine)
                .with_context(|| format!("scenario `{scenario}` has no machine `{machine}`"))?;
            let keys = build_keys(found, &bundle.images).map_err(anyhow::Error::msg)?;
            let key = keys.machines.get(machine).context("machine key")?.clone();
            (key, Some(spec.from.as_str()), Some(spec))
        }
    };
    if let Some(expected) = expected_key {
        ensure!(
            *expected == build_key,
            "the bundle builds {}, not the requested {}",
            build_key.as_str(),
            expected.as_str()
        );
    }

    // The chain, root first: every image between the base and the target.
    let mut chain_images = Vec::new();
    if let BuildTarget::Image(name) = target {
        chain_images.push(*images.get(name.as_str()).context("image")?);
    }
    let mut parent = from;
    while let Some(name) = parent.filter(|name| *name != PLATFORM_BASE_IMAGE) {
        let image = images.get(name).context("image of the chain")?;
        chain_images.push(image);
        parent = Some(image.from.as_str());
    }
    chain_images.reverse();

    let mut chain = Vec::new();
    let mut stages = Vec::new();
    let mut defer = BTreeSet::new();
    let mut parent_key = base_key();
    for image in &chain_images {
        let key = image_keys.get(&image.name).context("image key")?.clone();
        stages.extend(planned(&key, &image.setup, &BTreeMap::new()));
        defer.extend(image.defer.iter().cloned());
        chain.push(PlannedNode {
            name: image.name.clone(),
            key: key.clone(),
            parent_key: std::mem::replace(&mut parent_key, key),
        });
    }
    let root_mib = chain_images.first().and_then(|image| image.disk_mib);
    let mut disk_mib = root_mib;
    if let Some(machine) = own {
        stages.extend(planned(&build_key, &machine.setup, &machine.env));
        defer.extend(machine.defer.iter().cloned());
        if machine.from == PLATFORM_BASE_IMAGE && !machine.setup.is_empty() {
            disk_mib = Some(machine.disk_mib);
        }
        if build_key != parent_key {
            chain.push(PlannedNode {
                name: machine.name.clone(),
                key: build_key.clone(),
                parent_key,
            });
        }
    }
    let wake = match (target, own) {
        (BuildTarget::Image(name), _)
            if images.get(name.as_str()).is_some_and(|image| image.wake) =>
        {
            Some(WakeRole::Base)
        }
        (_, Some(machine))
            if images
                .get(machine.from.as_str())
                .is_some_and(|image| image.wake) =>
        {
            Some(WakeRole::Pack {
                base: machine.from.clone(),
            })
        }
        _ => None,
    };
    let disk_bytes = disk_mib.map_or(PLATFORM_BASE_DISK_BYTES, |mib| u64::from(mib) * MIB);
    ensure!(
        disk_bytes >= PLATFORM_BASE_DISK_BYTES,
        "a build's disk is at least the base's 2048 MiB, not {} MiB",
        disk_bytes / MIB
    );
    Ok(BuildPlan {
        build_key,
        chain,
        stages,
        defer,
        disk_bytes,
        wake,
    })
}

fn planned(
    key: &OciDigest,
    setup: &[ScriptV1],
    env: &BTreeMap<String, String>,
) -> Vec<PlannedStage> {
    setup
        .iter()
        .map(|stage| PlannedStage {
            node_key: key.clone(),
            name: stage.name.clone(),
            script: stage.script.clone(),
            env: env.clone(),
        })
        .collect()
}

/// What a checkpoint depends on outside the plan: the host's QEMU, CPU and
/// device arguments, and the base's digests.
#[derive(Clone, Debug)]
pub(crate) struct CheckpointHost {
    pub base_sha256: String,
    pub kernel_sha256: String,
    pub initrd_sha256: String,
    pub qemu_version: String,
    pub qemu_cpu: String,
    pub qemu_devices: Vec<String>,
}

/// The identity of the checkpoint after each stage (#311 §6.3 item 0): the
/// node's parent key, the stages run so far and their env, the geometry and
/// the host. No scenario or machine name, so one image key in two scenarios
/// shares its checkpoints.
pub(crate) fn checkpoint_identities(
    plan: &BuildPlan,
    host: &CheckpointHost,
) -> Result<Vec<CheckpointIdentity>> {
    let mut identities = Vec::with_capacity(plan.stages.len());
    let mut previous: Option<(&OciDigest, String)> = None;
    for stage in &plan.stages {
        let parent_prefix = match &previous {
            Some((node, key)) if *node == &stage.node_key => key.clone(),
            // A node's first stage starts from its parent's image.
            _ => node_parent(plan, &stage.node_key)?.as_str().to_owned(),
        };
        let stage_bytes = encode_stage(stage);
        let mut scope_input = parent_prefix.clone().into_bytes();
        scope_input.extend_from_slice(&stage_bytes);
        let identity = CheckpointIdentity {
            scenario_id: CHECKPOINT_SCOPE.to_owned(),
            vm_name: sha256_bytes_hex(&scope_input),
            parent_prefix,
            stage_bytes,
            base_sha256: host.base_sha256.clone(),
            kernel_sha256: host.kernel_sha256.clone(),
            initrd_sha256: host.initrd_sha256.clone(),
            disk_geometry_bytes: plan.disk_bytes,
            qemu_version: host.qemu_version.clone(),
            qemu_cpu: host.qemu_cpu.clone(),
            qemu_devices: host.qemu_devices.clone(),
            provisioning_abi: PROVISIONING_ABI.to_owned(),
        };
        previous = Some((&stage.node_key, identity.cache_key()?));
        identities.push(identity);
    }
    Ok(identities)
}

fn node_parent<'a>(plan: &'a BuildPlan, key: &OciDigest) -> Result<&'a OciDigest> {
    plan.chain
        .iter()
        .find(|node| node.key == *key)
        .map(|node| &node.parent_key)
        .context("a stage of no planned node")
}

/// `name`, `script` and the env, length-prefixed like a build key record.
fn encode_stage(stage: &PlannedStage) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut put = |text: &str| {
        bytes.extend_from_slice(&(text.len() as u64).to_be_bytes());
        bytes.extend_from_slice(text.as_bytes());
    };
    put(&stage.name);
    put(&stage.script);
    for (name, value) in &stage.env {
        put(name);
        put(value);
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use intar_contracts::scenario::{MachineV1, ScenarioV1};

    pub(crate) fn bundle() -> SourceBundleV2 {
        let bytes = include_bytes!("../../tests/fixtures/broken-nginx.json");
        serde_json::from_slice(bytes).expect("fixture bundle")
    }

    fn webserver() -> BuildTarget {
        BuildTarget::Machine {
            scenario: "broken-nginx".to_owned(),
            machine: "webserver".to_owned(),
        }
    }

    fn host() -> CheckpointHost {
        CheckpointHost {
            base_sha256: "a".repeat(64),
            kernel_sha256: "b".repeat(64),
            initrd_sha256: "c".repeat(64),
            qemu_version: "qemu 10".to_owned(),
            qemu_cpu: "host".to_owned(),
            qemu_devices: vec!["-device".to_owned(), "virtio".to_owned()],
        }
    }

    fn machine_mut<'a>(bundle: &'a mut SourceBundleV2, name: &str) -> &'a mut MachineV1 {
        bundle
            .scenarios
            .iter_mut()
            .flat_map(|scenario| scenario.machines.iter_mut())
            .find(|machine| machine.name == name)
            .expect("machine")
    }

    #[test]
    fn a_machine_on_the_base_runs_its_setup_with_its_env() {
        let mut bundle = bundle();
        machine_mut(&mut bundle, "webserver")
            .env
            .insert("GREETING".to_owned(), "hi".to_owned());
        let plan = plan_build(&bundle, &webserver(), None).expect("plan");
        let names: Vec<&str> = plan
            .stages
            .iter()
            .map(|stage| stage.name.as_str())
            .collect();
        assert_eq!(names, ["packages", "break-nginx"]);
        assert!(
            plan.stages
                .iter()
                .all(|stage| stage.env["GREETING"] == "hi")
        );
        assert_eq!(plan.disk_bytes, 4096 * MIB);
        assert_eq!(plan.chain.len(), 1);
        assert_eq!(plan.chain[0].parent_key, base_key());
    }

    #[test]
    fn chain_stages_run_first_with_an_empty_env() {
        let mut bundle = bundle();
        bundle.images.push(ImageV1 {
            name: "web".to_owned(),
            from: PLATFORM_BASE_IMAGE.to_owned(),
            disk_mib: Some(3072),
            defer: vec!["nginx.service".to_owned()],
            setup: vec![ScriptV1 {
                name: "install".to_owned(),
                script: "apt-get install -y nginx\n".to_owned(),
            }],
            wake: false,
        });
        let machine = machine_mut(&mut bundle, "webserver");
        machine.from = "web".to_owned();
        machine.env.insert("A".to_owned(), "b".to_owned());
        machine.defer = vec!["late.service".to_owned()];
        let plan = plan_build(&bundle, &webserver(), None).expect("plan");
        assert_eq!(plan.stages[0].name, "install");
        assert!(plan.stages[0].env.is_empty());
        assert_eq!(plan.stages[1].env["A"], "b");
        // The geometry is the chain root's.
        assert_eq!(plan.disk_bytes, 3072 * MIB);
        assert_eq!(
            plan.defer.iter().map(String::as_str).collect::<Vec<_>>(),
            ["late.service", "nginx.service"]
        );
        assert_eq!(plan.chain.len(), 2);
        assert_eq!(plan.chain[1].parent_key, plan.chain[0].key);

        let image =
            plan_build(&bundle, &BuildTarget::Image("web".to_owned()), None).expect("image");
        assert_eq!(image.stages.len(), 1);
        assert_eq!(image.build_key, plan.chain[0].key);
    }

    #[test]
    fn a_tampered_bundle_is_refused() {
        let bundle = bundle();
        let expected = plan_build(&bundle, &webserver(), None)
            .expect("plan")
            .build_key;
        plan_build(&bundle, &webserver(), Some(&expected)).expect("the same bundle builds");
        let mut tampered = bundle;
        machine_mut(&mut tampered, "webserver").setup[1]
            .script
            .push_str("echo extra\n");
        let error = plan_build(&tampered, &webserver(), Some(&expected)).expect_err("refused");
        assert!(error.to_string().contains("not the requested"), "{error}");
        let mut invalid = tampered;
        invalid.image_format = "intar-image-2".to_owned();
        assert!(plan_build(&invalid, &webserver(), None).is_err());
    }

    #[test]
    fn a_machine_that_builds_nothing_is_the_base() {
        let mut bundle = bundle();
        let machine = machine_mut(&mut bundle, "webserver");
        machine.setup.clear();
        let plan = plan_build(&bundle, &webserver(), None).expect("plan");
        assert_eq!(plan.build_key, base_key());
        assert!(plan.stages.is_empty() && plan.chain.is_empty());
        assert_eq!(plan.disk_bytes, PLATFORM_BASE_DISK_BYTES);
        let base = plan_build(&bundle, &BuildTarget::Base, Some(&base_key())).expect("base");
        assert_eq!(base, plan);
    }

    #[test]
    fn checkpoints_follow_the_image_key_not_the_scenario() {
        let bundle = bundle();
        let mut other = bundle.clone();
        let mut copy: ScenarioV1 = other.scenarios[0].clone();
        copy.slug = "broken-nginx-again".to_owned();
        copy.title = "Again".to_owned();
        for machine in &mut copy.machines {
            machine.egress = !machine.egress;
        }
        other.scenarios = vec![copy];
        other.course_catalog.courses.clear();
        let first = plan_build(&bundle, &webserver(), None).expect("plan");
        let second = plan_build(
            &other,
            &BuildTarget::Machine {
                scenario: "broken-nginx-again".to_owned(),
                machine: "webserver".to_owned(),
            },
            None,
        )
        .expect("plan");
        assert_eq!(first.build_key, second.build_key);
        let key = |plan: &BuildPlan| -> Vec<String> {
            checkpoint_identities(plan, &host())
                .expect("identities")
                .iter()
                .map(|identity| identity.cache_key().expect("key"))
                .collect()
        };
        assert_eq!(key(&first), key(&second));

        // A changed last stage keeps the first checkpoint and moves the last.
        let mut changed = bundle;
        machine_mut(&mut changed, "webserver").setup[1]
            .script
            .push_str("true\n");
        let third = plan_build(&changed, &webserver(), None).expect("plan");
        let (before, after) = (key(&first), key(&third));
        assert_eq!(before[0], after[0]);
        assert_ne!(before[1], after[1]);
        // So does the host.
        let mut moved = host();
        moved.qemu_devices.push("-device".to_owned());
        let identities = checkpoint_identities(&first, &moved).expect("identities");
        assert_ne!(identities[0].cache_key().expect("key"), before[0]);
        // One scope per checkpoint.
        let scopes: BTreeSet<String> = checkpoint_identities(&first, &host())
            .expect("identities")
            .iter()
            .map(|identity| identity.vm_name.clone())
            .collect();
        assert_eq!(scopes.len(), 2);
    }
}
