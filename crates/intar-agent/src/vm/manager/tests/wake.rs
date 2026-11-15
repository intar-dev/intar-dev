//! Waking a VM: the decision, the wake VM config and the one fallback.

use intar_contracts::oci::WakeV1;
use intar_jailer_protocol::JailWakePaths;

use super::*;
use crate::config::WakeConfig;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const NOW_MS: u64 = 400 * DAY_MS;

fn profile() -> OciDigest {
    OciDigest::try_from(format!("sha256:{}", "d".repeat(64))).expect("digest")
}

fn guest() -> WakeV1 {
    let hex = "a".repeat(64);
    serde_json::from_value(json!({
        "ram": {"size_bytes": 2_u64 << 30, "chunk_size": 4 << 20, "chunks": [], "sha256": hex},
        "shape": {"memory_bytes": 2_u64 << 30, "boot_vcpus": 1, "max_vcpus": 4, "balloon": true, "max_phys_bits": 36},
        "cpu_profile": profile().as_str(),
        "vmm": {"min_version": "v55.0", "built_with": "v55.0.0"},
        "booted_at_unix_ms": NOW_MS - DAY_MS,
    }))
    .expect("wake")
}

fn config() -> WakeConfig {
    WakeConfig {
        enabled: true,
        profiles: vec![profile()],
    }
}

fn facts<'a>(config: &'a WakeConfig, wake: &'a WakeV1) -> StartFacts<'a> {
    StartFacts {
        config,
        wake: Some(wake),
        prepared: true,
        jailer_supports_wake: true,
        vmm_version: "v55.0.0",
        now_unix_ms: NOW_MS,
        memory_mib: 1024,
        cpu_millis: 2_000,
        fell_back_recently: false,
    }
}

fn cold_because(decision: StartDecision, needle: &str) {
    match decision {
        StartDecision::Cold(reason) => assert!(reason.contains(needle), "{reason}"),
        StartDecision::Wake => panic!("expected a cold boot because of {needle}"),
    }
}

#[test]
fn a_vm_wakes_only_when_every_condition_holds() {
    let (config, wake) = (config(), guest());
    assert_eq!(decide_start(&facts(&config, &wake)), StartDecision::Wake);

    let off = WakeConfig {
        enabled: false,
        ..config.clone()
    };
    cold_because(decide_start(&facts(&off, &wake)), "wake is off");
    cold_because(
        decide_start(&StartFacts {
            wake: None,
            ..facts(&config, &wake)
        }),
        "no suspended guest",
    );
    cold_because(
        decide_start(&StartFacts {
            prepared: false,
            ..facts(&config, &wake)
        }),
        "not prepared",
    );
    let unpinned = WakeConfig {
        profiles: Vec::new(),
        ..config.clone()
    };
    cold_because(decide_start(&facts(&unpinned, &wake)), "CPU profile");
    cold_because(
        decide_start(&StartFacts {
            jailer_supports_wake: false,
            ..facts(&config, &wake)
        }),
        "jailerd",
    );
    for older in ["v54.9.9", "v9", "55.0.0", "vfoo"] {
        cold_because(
            decide_start(&StartFacts {
                vmm_version: older,
                ..facts(&config, &wake)
            }),
            "cloud-hypervisor",
        );
    }
    for newer in ["v55.0.0", "v55.0", "v55.0.1", "v56.0.0", "v100.0.0"] {
        assert_eq!(
            decide_start(&StartFacts {
                vmm_version: newer,
                ..facts(&config, &wake)
            }),
            StartDecision::Wake,
            "{newer}"
        );
    }
    let mut old = guest();
    old.booted_at_unix_ms = NOW_MS - 330 * DAY_MS;
    cold_because(decide_start(&facts(&config, &old)), "330 days");
    old.booted_at_unix_ms += 1;
    assert_eq!(decide_start(&facts(&config, &old)), StartDecision::Wake);

    cold_because(
        decide_start(&StartFacts {
            memory_mib: 2049,
            ..facts(&config, &wake)
        }),
        "memory",
    );
    let mut fixed = guest();
    fixed.shape.balloon = false;
    cold_because(decide_start(&facts(&config, &fixed)), "memory");
    assert_eq!(
        decide_start(&StartFacts {
            memory_mib: 2048,
            ..facts(&config, &fixed)
        }),
        StartDecision::Wake
    );

    cold_because(
        decide_start(&StartFacts {
            cpu_millis: 4_001,
            ..facts(&config, &wake)
        }),
        "vCPUs",
    );
    for cpu_millis in [1, 1_000, 4_000] {
        assert_eq!(
            decide_start(&StartFacts {
                cpu_millis,
                ..facts(&config, &wake)
            }),
            StartDecision::Wake
        );
    }
    cold_because(
        decide_start(&StartFacts {
            fell_back_recently: true,
            ..facts(&config, &wake)
        }),
        "fell back",
    );
}

fn jail_paths() -> (JailPathMap, JailWakePaths) {
    let wake = JailWakePaths {
        host_ram: PathBuf::from("/jail/disks/wake.ram"),
        host_stub: PathBuf::from("/jail/boot/wake-stub"),
        host_cpu_profile: PathBuf::from("/jail/boot/cpu-profile.json"),
        jailed_ram: PathBuf::from("/disks/wake.ram"),
        jailed_stub: PathBuf::from("/boot/wake-stub"),
        jailed_cpu_profile: PathBuf::from("/boot/cpu-profile.json"),
    };
    let paths = JailPathMap {
        host_jail_root: PathBuf::from("/jail"),
        host_api_socket: PathBuf::from("/jail/run/ch.sock"),
        host_vsock_socket: PathBuf::from("/jail/run/kino.vsock"),
        host_kernel: PathBuf::from("/jail/boot/kernel"),
        host_initrd: Some(PathBuf::from("/jail/boot/initrd")),
        host_root_disk: PathBuf::from("/jail/disks/root.raw"),
        host_runtime_disk: PathBuf::from("/jail/disks/runtime.raw"),
        host_recording_disk: PathBuf::from("/jail/disks/recordings.vfat"),
        jailed_api_socket: PathBuf::from("/run/ch.sock"),
        jailed_vsock_socket: PathBuf::from("/run/kino.vsock"),
        jailed_kernel: PathBuf::from("/boot/kernel"),
        jailed_initrd: Some(PathBuf::from("/boot/initrd")),
        jailed_root_disk: PathBuf::from("/disks/root.raw"),
        jailed_runtime_disk: PathBuf::from("/disks/runtime.raw"),
        jailed_recording_disk: PathBuf::from("/disks/recordings.vfat"),
        host_serial_log: PathBuf::from("/jail/logs/serial.log"),
        host_console_log: PathBuf::from("/jail/logs/console.log"),
        host_stderr_log: PathBuf::from("/jail/logs/stderr.log"),
        jailed_serial_log: PathBuf::from("/logs/serial.log"),
        jailed_console_log: PathBuf::from("/logs/console.log"),
        wake: Some(wake.clone()),
    };
    (paths, wake)
}

#[test]
fn a_wake_config_is_the_cold_config_with_only_the_listed_differences() {
    let (paths, wake_paths) = jail_paths();
    let cold = build_cloud_hypervisor_vm_config(CloudHypervisorVmConfigInput {
        cpu_millis: 3_000,
        name: "web",
        cmdline: "console=hvc0 root=LABEL=INTARROOT",
        paths: &paths,
        memory_mib: 1024,
        tap: "tap0",
        mac: "02:00:00:00:00:01",
        kino_vsock_cid: 42,
    })
    .expect("cold config");
    let cold_json = serde_json::to_value(&cold).expect("json");
    let woken = wake_vm_config(cold, &guest(), &wake_paths, 1024).expect("wake config");

    let mut expected = cold_json;
    expected["payload"]["kernel"] = json!("/boot/wake-stub");
    expected["cpus"] = json!({
        "boot_vcpus": 1, "max_vcpus": 4,
        "profile": {"File": "/boot/cpu-profile.json"},
        "max_phys_bits": 36,
    });
    expected["net"][0]["offload_tso"] = json!(true);
    expected["net"][0]["offload_ufo"] = json!(true);
    expected["net"][0]["offload_csum"] = json!(true);
    expected["memory"] = json!({
        "size": 0,
        "zones": [{"id": "mem0", "size": 2_i64 << 30, "file": "/disks/wake.ram", "shared": false}],
    });
    expected["balloon"] = json!({"size": 1_i64 << 30});
    let mut actual = serde_json::to_value(&woken).expect("json");
    // The profile's own encoding is the client's; compare what it names.
    let profile = actual["cpus"]["profile"].take();
    expected["cpus"]["profile"] = json!(null);
    assert_eq!(
        serde_json::from_value::<cloud_hypervisor_client::CpuProfile>(profile).expect("profile"),
        cloud_hypervisor_client::CpuProfile::File("/boot/cpu-profile.json".to_owned())
    );
    assert_eq!(actual, expected);

    // Without a balloon the config sets none.
    let mut fixed = guest();
    fixed.shape.balloon = false;
    let cold = build_cloud_hypervisor_vm_config(CloudHypervisorVmConfigInput {
        cpu_millis: 3_000,
        name: "web",
        cmdline: "console=hvc0",
        paths: &paths,
        memory_mib: 2048,
        tap: "tap0",
        mac: "02:00:00:00:00:01",
        kino_vsock_cid: 42,
    })
    .expect("cold config");
    let woken = wake_vm_config(cold, &fixed, &wake_paths, 2048).expect("wake config");
    assert!(woken.balloon.is_none());
}

#[test]
fn an_image_that_fell_back_stays_cold_for_an_hour() {
    let image = profile();
    let other = OciDigest::try_from(format!("sha256:{}", "f".repeat(64))).expect("digest");
    let start = Instant::now();
    let mut fallbacks = BTreeMap::new();
    assert!(!fell_back_recently(&fallbacks, &image, start));

    remember_fallback(&mut fallbacks, &image, start);
    assert!(fell_back_recently(&fallbacks, &image, start));
    assert!(!fell_back_recently(&fallbacks, &other, start));
    let later = |seconds| start + Duration::from_secs(seconds);
    assert!(fell_back_recently(&fallbacks, &image, later(3_599)));
    assert!(!fell_back_recently(&fallbacks, &image, later(3_600)));

    // Entries past the hour go when another is kept.
    remember_fallback(&mut fallbacks, &other, later(3_600));
    assert_eq!(fallbacks.len(), 1);
}

/// A jailer and VMM that log what they are asked and answer from a script.
#[derive(Default)]
struct FakeStart {
    log: Vec<String>,
    next: u32,
    /// Whether each attempt's launch, in order, fails.
    launch_fails: Vec<bool>,
    boot_fails: bool,
    /// The first-report outcome of a woken generation.
    report: Option<&'static str>,
    fallbacks: u32,
    deleted: bool,
}

impl StartBackend for FakeStart {
    type Launched = u32;

    async fn launch(&mut self, wake: bool) -> Result<u32> {
        self.next += 1;
        let generation = self.next;
        self.log.push(format!("launch {generation} wake={wake}"));
        if self.launch_fails.get(generation as usize - 1) == Some(&true) {
            anyhow::bail!("jailerd launch failed");
        }
        Ok(generation)
    }

    async fn boot(&mut self, generation: &u32, wake: bool) -> Result<()> {
        self.log.push(format!("boot {generation} wake={wake}"));
        if wake && self.boot_fails {
            anyhow::bail!("vm.create refused");
        }
        Ok(())
    }

    async fn first_report(&mut self, generation: &u32, limit: Duration) -> Option<&'static str> {
        assert_eq!(limit, WAKE_FIRST_REPORT_LIMIT);
        self.log.push(format!("wait {generation}"));
        self.report
    }

    async fn destroy(&mut self, generation: u32) -> Result<()> {
        self.log.push(format!("destroy {generation}"));
        Ok(())
    }

    async fn ensure_wanted(&mut self) -> Result<()> {
        if self.deleted {
            anyhow::bail!("vm create cancelled by delete request");
        }
        Ok(())
    }

    fn record_fallback(&mut self) {
        self.fallbacks += 1;
    }
}

#[tokio::test]
async fn a_wake_that_reports_in_time_is_kept() -> Result<()> {
    let mut fake = FakeStart::default();
    let (generation, start) = start_vm(&mut fake, StartDecision::Wake).await?;
    assert_eq!(generation, 1);
    assert_eq!(start.path, VmStartPath::Wake);
    assert_eq!(start.reason, None);
    assert_eq!(
        fake.log,
        ["launch 1 wake=true", "boot 1 wake=true", "wait 1"]
    );
    assert_eq!(fake.fallbacks, 0);
    Ok(())
}

#[tokio::test]
async fn a_silent_wake_is_destroyed_and_the_vm_boots_cold_once() -> Result<()> {
    let mut fake = FakeStart {
        report: Some("no report within 10 s"),
        ..FakeStart::default()
    };
    let (generation, start) = start_vm(&mut fake, StartDecision::Wake).await?;
    assert_eq!(generation, 2, "a new generation, nothing reused");
    assert_eq!(start.path, VmStartPath::WakeFallback);
    assert_eq!(start.reason.as_deref(), Some("no report within 10 s"));
    assert_eq!(
        fake.log,
        [
            "launch 1 wake=true",
            "boot 1 wake=true",
            "wait 1",
            "destroy 1",
            "launch 2 wake=false",
            "boot 2 wake=false",
        ]
    );
    assert_eq!(fake.fallbacks, 1);
    Ok(())
}

#[tokio::test]
async fn a_refused_or_failed_wake_falls_back_and_a_failed_cold_launch_fails() -> Result<()> {
    let mut refused = FakeStart {
        boot_fails: true,
        ..FakeStart::default()
    };
    let (_, start) = start_vm(&mut refused, StartDecision::Wake).await?;
    assert_eq!(start.reason.as_deref(), Some("the VMM refused the wake"));
    assert!(refused.log.contains(&"destroy 1".to_owned()));

    // The second launch is cold and the last: its failure fails the VM.
    let mut failing = FakeStart {
        launch_fails: vec![true, true],
        ..FakeStart::default()
    };
    assert!(start_vm(&mut failing, StartDecision::Wake).await.is_err());
    assert_eq!(failing.log, ["launch 1 wake=true", "launch 2 wake=false"]);
    assert_eq!(failing.fallbacks, 1);

    // A cold decision never tries a wake and never falls back.
    let mut cold = FakeStart {
        report: Some("no report within 10 s"),
        ..FakeStart::default()
    };
    let (_, start) = start_vm(
        &mut cold,
        StartDecision::Cold("wake is off on this host".to_owned()),
    )
    .await?;
    assert_eq!(start.path, VmStartPath::Cold);
    assert_eq!(start.reason.as_deref(), Some("wake is off on this host"));
    assert_eq!(cold.log, ["launch 1 wake=false", "boot 1 wake=false"]);
    assert_eq!(cold.fallbacks, 0);
    Ok(())
}

#[tokio::test]
async fn a_vm_deleted_during_its_wake_neither_falls_back_nor_boots_cold() {
    let mut fake = FakeStart {
        report: Some("no report within 10 s"),
        deleted: true,
        ..FakeStart::default()
    };
    assert!(start_vm(&mut fake, StartDecision::Wake).await.is_err());
    assert_eq!(fake.fallbacks, 0, "no false fallback is kept");
    assert_eq!(
        fake.log,
        [
            "launch 1 wake=true",
            "boot 1 wake=true",
            "wait 1",
            "destroy 1"
        ]
    );
}
