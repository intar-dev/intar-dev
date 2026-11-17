use std::collections::BTreeSet;

use intar_contracts::bridge::DesiredVmPhase;
use intar_contracts::bridge_v9::HostDesiredStateV3;
use intar_contracts::oci::OciDigest;

/// The exact content the agent must keep: the control plane's desired cache
/// and what every VM whose desired phase is `Running` boots from. The cache
/// does not derive, widen, or guess a pin.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct RequiredPins {
    /// Machine images, by manifest digest.
    pub(crate) images: BTreeSet<OciDigest>,
    /// Kino artifacts, by manifest digest.
    pub(crate) kino: BTreeSet<OciDigest>,
}

impl RequiredPins {
    pub(crate) fn from_desired_state(desired: &HostDesiredStateV3) -> Self {
        let running = desired
            .vms
            .iter()
            .filter(|vm| vm.desired_phase == DesiredVmPhase::Running);
        let mut pins = Self {
            images: desired.cached_images.iter().cloned().collect(),
            kino: desired.kino_pin.iter().cloned().collect(),
        };
        for vm in running {
            pins.images.insert(vm.image.clone());
            pins.kino.insert(vm.kino.clone());
        }
        pins
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.images.is_empty() && self.kino.is_empty()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    use intar_contracts::bridge::HostScope;
    use intar_contracts::bridge_v9::{DesiredVmV3, HOST_DESIRED_STATE_SCHEMA_VERSION_7};
    use intar_contracts::scenario::SpecMode;

    pub(crate) fn digest(digit: char) -> OciDigest {
        OciDigest::try_from(format!("sha256:{}", digit.to_string().repeat(64)))
            .unwrap_or_else(|error| panic!("test digest: {error}"))
    }

    pub(crate) fn desired_vm(name: &str, image: char, kino: char) -> DesiredVmV3 {
        DesiredVmV3 {
            vm_id: format!("{name}-id"),
            name: name.to_owned(),
            run_id: "run-1".to_owned(),
            runtime_execution_id: "execution-1".to_owned(),
            owner_user_id: "user-1".to_owned(),
            generation: 1,
            desired_phase: DesiredVmPhase::Running,
            lease_expires_at_unix_ms: 4_102_444_800_000,
            image: digest(image),
            kino: digest(kino),
            spec: digest('c'),
            mode: SpecMode::Learn,
            cpu_millis: 1_000,
            memory_mib: 512,
            disk_mib: 0,
            peers: Vec::new(),
            ssh_authorized_keys: Vec::new(),
            terminal: true,
            egress: false,
        }
    }

    pub(crate) fn desired_state(
        cached: &[char],
        kino_pin: Option<char>,
        vms: Vec<DesiredVmV3>,
    ) -> HostDesiredStateV3 {
        HostDesiredStateV3 {
            scope: HostScope::Personal,
            owner_user_id: "user-1".to_owned(),
            schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION_7,
            host_id: "host-1".to_owned(),
            version: 1,
            generated_at_unix_ms: 0,
            cached_images: cached.iter().copied().map(digest).collect(),
            kino_pin: kino_pin.map(digest),
            vms,
            builds: Vec::new(),
            source_compiles: Vec::new(),
        }
    }

    #[test]
    fn pins_are_the_desired_cache_the_kino_pin_and_the_running_vms() {
        let mut stopped = desired_vm("stopped", '3', '6');
        stopped.desired_phase = DesiredVmPhase::Absent;
        let state = desired_state(
            &['1'],
            Some('4'),
            vec![desired_vm("web", '2', '5'), stopped],
        );
        let pins = RequiredPins::from_desired_state(&state);

        assert_eq!(pins.images, BTreeSet::from([digest('1'), digest('2')]));
        assert_eq!(pins.kino, BTreeSet::from([digest('4'), digest('5')]));
    }

    #[test]
    fn an_empty_desired_state_pins_nothing() {
        let pins = RequiredPins::from_desired_state(&desired_state(&[], None, Vec::new()));
        assert!(pins.is_empty());
    }
}
