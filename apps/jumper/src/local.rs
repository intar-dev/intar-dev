//! The run's machine on this computer: downloaded into the local cache when
//! it is not there, started through zpm, watched through Kino's reports, and stopped with the run.
//
// What the guest's Kino reports is shown here and handed to the engine as
// the state intar takes, the shape an agent host reports a VM in.

use std::path::PathBuf;
use std::sync::Arc;

use intar_contracts::bridge::{VmTerminalStateKindV1, VmTerminalStateV1};
use intar_contracts::bridge_v9::{VmPhaseV2, VmStateV3};
use subspace::Subspace;
use subspace::contract::LocalRunV1;
use zpm::machine::{Cache, Plan, RunningMachine};
use zpm::reports::GuestReport;

use crate::state::MachineStatus;

pub struct Local {
    cache: PathBuf,
    runs: PathBuf,
    /// The run a machine is running for, and the machine.
    machine: Option<(LocalRunV1, RunningMachine)>,
    last: Option<MachineStatus>,
}

impl Local {
    /// The app's files are in the user's local data directory.
    pub fn new() -> Self {
        let home = dirs::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("intar")
            .join("jumper");
        Self {
            cache: home.join("cache"),
            runs: home.join("runs"),
            machine: None,
            last: None,
        }
    }

    pub fn runs(&self, run_id: &str) -> bool {
        self.machine
            .as_ref()
            .is_some_and(|(running, _)| running.run_id == run_id)
    }

    /// Starts the run's machine. The guest's `intar` command is answered by
    /// passing it on to intar over `channel`. What the machine boots from is
    /// downloaded first when it is not here; `downloaded` hears how far that is.
    pub async fn start(
        &mut self,
        run: &LocalRunV1,
        channel: Arc<Subspace>,
        downloaded: &dyn Fn(u64, u64),
    ) -> MachineStatus {
        self.stop().await;
        let [machine] = run.machines.as_slice() else {
            return MachineStatus::Failed(format!(
                "This lab has {} machines, and this version of the app runs labs with one.",
                run.machines.len()
            ));
        };
        let (cache, dir) = (
            self.cache.clone(),
            self.runs.join(&run.run_id).join(&machine.name),
        );
        if let Err(reason) =
            crate::pull::pull(&channel, &Cache::new(&cache), machine, downloaded).await
        {
            return MachineStatus::Failed(reason);
        }
        let (run_id, machine) = (run.run_id.clone(), machine.clone());
        let handle = tokio::runtime::Handle::current();
        let started = tokio::task::spawn_blocking(move || {
            let arch = zpm::Arch::host().map_or("qemu-system-x86_64", zpm::Arch::qemu_binary);
            let plan = Plan {
                name: &machine.name,
                image: &machine.image,
                spec: &machine.spec,
                kino: &machine.kino,
                cpu_millis: machine.cpu_millis,
                memory_mib: machine.memory_mib,
                // ponytail: no key, so no SSH in the guest, until the app has a terminal (#402).
                authorized_keys: &[],
            };
            let (asked_run, asked_machine) = (run_id, machine.name.clone());
            // ponytail: QEMU from PATH; the app ships its own with #403.
            zpm::machine::start(
                std::path::Path::new(arch),
                std::path::Path::new("qemu-img"),
                &Cache::new(cache),
                &dir,
                &plan,
                // Called on the broker's own thread, so waiting here blocks no one else.
                move |request| {
                    handle
                        .block_on(channel.run_cli(&asked_run, &asked_machine, request))
                        .ok()
                },
            )
        })
        .await;
        match started {
            Ok(Ok(machine)) => {
                self.machine = Some((run.clone(), machine));
                MachineStatus::Booting
            }
            Ok(Err(error)) => MachineStatus::Failed(error.to_string()),
            Err(_) => MachineStatus::Failed("The machine could not be started.".to_owned()),
        }
    }

    /// Stops the machine, if one runs. Waits for QEMU to be gone.
    pub async fn stop(&mut self) {
        self.last = None;
        if let Some((_, machine)) = self.machine.take() {
            let _ = tokio::task::spawn_blocking(move || machine.stop()).await;
        }
    }

    /// What the machine said since the last call: its status if that
    /// changed, and its latest report as the state to send to intar.
    pub fn poll(&mut self) -> Polled {
        let Some((run, machine)) = self.machine.as_mut() else {
            return Polled::default();
        };
        let mut latest = None;
        while let Ok(report) = machine.reports.reports.try_recv() {
            latest = Some(report);
        }
        let mut status = latest.as_ref().map(MachineStatus::of);
        let report = latest
            .as_ref()
            .and_then(|report| vm_state(run, &machine.name, report, now_ms()));
        if !machine.is_running() {
            status = Some(MachineStatus::Failed("The machine stopped.".to_owned()));
            self.machine = None;
        }
        let status = status.filter(|status| self.last.as_ref() != Some(status));
        if let Some(status) = &status {
            self.last = Some(status.clone());
        }
        Polled { status, report }
    }
}

#[derive(Default)]
pub struct Polled {
    pub status: Option<MachineStatus>,
    pub report: Option<VmStateV3>,
}

fn now_ms() -> i64 {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
}

/// One report of the guest's Kino as the VM state intar takes for `machine`
/// of `run`. `None` when the run view lacks what a report has to name, as
/// from an intar that predates reports from the app.
///
/// intar keeps no endpoint a device names, so the terminal and the network
/// are left out; the lab and the phase are what it projects.
pub fn vm_state(
    run: &LocalRunV1,
    machine: &str,
    report: &GuestReport,
    now_ms: i64,
) -> Option<VmStateV3> {
    Some(VmStateV3 {
        owner_user_id: run.user_id.clone()?,
        runtime_execution_id: run.execution_id.clone()?,
        generation: run.generation?,
        run_id: run.run_id.clone(),
        name: machine.to_owned(),
        desired_version: None,
        phase: if report.failed.is_some() {
            VmPhaseV2::Failed
        } else if report.ssh_ready {
            VmPhaseV2::Ready
        } else {
            VmPhaseV2::Booting
        },
        image: None,
        kino: None,
        start: None,
        network: None,
        terminal: VmTerminalStateV1 {
            state: VmTerminalStateKindV1::Pending,
            target: None,
            reason: None,
            observed_at_unix_ms: now_ms,
        },
        runtime_constraints: None,
        resource_state: None,
        sandbox: None,
        ssh_host_keys_openssh: Vec::new(),
        lab: Some(report.lab.clone()),
        archive: None,
        // The guest's own failure text is for operators; the lab's state carries the outcome.
        error: None,
        updated_at_unix_ms: now_ms,
    })
}

#[cfg(test)]
mod tests {
    use intar_contracts::bridge_v9::{CheckStatus, LabState, VmLabV1, VmReadyV1, VmTaskV1};

    use super::*;

    fn run() -> LocalRunV1 {
        LocalRunV1 {
            run_id: "run-1".into(),
            scenario_id: "intar/web".into(),
            state: "provisioning".into(),
            active: true,
            user_id: Some("learner".into()),
            execution_id: Some("run-1".into()),
            generation: Some(1),
            machines: vec![],
        }
    }

    fn report(ssh_ready: bool, state: LabState) -> GuestReport {
        GuestReport {
            ssh_ready,
            failed: None,
            ssh_host_keys_openssh: vec!["ssh-ed25519 AAAA host".into()],
            lab: VmLabV1 {
                state,
                kino_version: "0.9.1".into(),
                ready: vec![VmReadyV1 {
                    name: "nginx".into(),
                    status: CheckStatus::Pass,
                    tail: String::new(),
                }],
                tasks: vec![VmTaskV1 {
                    id: "serve".into(),
                    status: CheckStatus::Pass,
                    message: String::new(),
                    passed_at_unix_ms: Some(5),
                }],
                timings_ms: Default::default(),
                failure: None,
                verify: None,
            },
        }
    }

    /// The exact JSON the app sends for one machine. The website's test
    /// `desktop-channel.workers.test.ts` posts this same text to the report
    /// route, so a change here that intar would refuse fails there.
    #[test]
    fn a_guest_report_becomes_the_state_intar_takes() {
        let vm = vm_state(
            &run(),
            "web",
            &report(true, LabState::Ready),
            1_700_000_000_000,
        )
        .expect("state");
        assert_eq!(
            serde_json::to_string(&vm).expect("json"),
            r#"{"owner_user_id":"learner","runtime_execution_id":"run-1","generation":1,"run_id":"run-1","name":"web","phase":"ready","terminal":{"state":"pending","observed_at_unix_ms":1700000000000},"ssh_host_keys_openssh":[],"lab":{"state":"ready","kino_version":"0.9.1","ready":[{"name":"nginx","status":"pass","tail":""}],"tasks":[{"id":"serve","status":"pass","message":"","passed_at_unix_ms":5}],"timings_ms":{}},"updated_at_unix_ms":1700000000000}"#
        );
        // Until SSH is up the machine is booting; a guest that failed is failed.
        assert_eq!(
            vm_state(&run(), "web", &report(false, LabState::Preparing), 1)
                .expect("state")
                .phase,
            VmPhaseV2::Booting
        );
        let mut failed = report(false, LabState::Preparing);
        failed.failed = Some("no network".into());
        let state = vm_state(&run(), "web", &failed, 1).expect("state");
        assert_eq!((state.phase, state.error), (VmPhaseV2::Failed, None));

        // A run view without the learner's id cannot be reported on.
        let mut old = run();
        old.user_id = None;
        assert!(vm_state(&old, "web", &report(true, LabState::Ready), 1).is_none());
    }

    /// A whole run against a real intar, without the window: sign in through
    /// a browser, start a lecture's scenario, download and boot its machine,
    /// pass the guest's reports on, and end the run. It prints the sign-in
    /// link and waits for it to be opened.
    ///
    /// `INTAR_LIVE_COURSE="Linux Basics" cargo test -p jumper live_run -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "signs in to a real intar and starts a run there"]
    async fn live_run_downloads_boots_and_reports() {
        use std::time::{Duration, Instant};

        let base = std::env::var("INTAR_URL").unwrap_or_else(|_| "https://intar.dev".into());
        let base = url::Url::parse(&base).expect("INTAR_URL");
        let course = std::env::var("INTAR_LIVE_COURSE").unwrap_or_default();
        let http = reqwest::Client::new();
        let sign_in = subspace::SignIn::begin(&base)
            .await
            .expect("begin a sign-in");
        eprintln!("live: open {}", sign_in.authorize_url());
        let tokens = tokio::time::timeout(Duration::from_secs(600), sign_in.finish(&http))
            .await
            .expect("the sign-in link was not opened in ten minutes")
            .expect("sign in");
        let channel = Arc::new(Subspace::new(http, base, tokens));

        let catalog = channel.catalog().await.expect("catalog").courses;
        let (organization, scenario) = catalog
            .iter()
            .filter(|listed| listed.title.contains(&course))
            .find_map(|listed| {
                let lecture = listed.lectures.iter().find(|lecture| {
                    lecture.scenario_id.is_some()
                        && !matches!(lecture.state.as_str(), "locked" | "waiting_for_scenario")
                })?;
                eprintln!("live: {} / {}", listed.title, lecture.title);
                Some((listed.organization_id.clone(), lecture.scenario_id.clone()?))
            })
            .expect("a lecture of that course whose scenario can start");
        let run = channel
            .start_run(
                &scenario,
                organization.as_deref(),
                &[intar_contracts::guest::GUEST_CONTRACT],
                &uuid::Uuid::new_v4().to_string(),
            )
            .await
            .expect("start the run")
            .run;
        eprintln!(
            "live: run {} with {} machine(s)",
            run.run_id,
            run.machines.len()
        );

        // Whatever happens from here, the run is ended before the test judges it.
        let mut local = Local::new();
        let percent = std::cell::Cell::new(u64::MAX);
        let downloaded = |done: u64, total: u64| {
            let now = done * 100 / total.max(1);
            if percent.replace(now) != now {
                eprintln!("live: downloaded {now} % of {total} bytes");
            }
        };
        let began = Instant::now();
        let mut status = local.start(&run, channel.clone(), &downloaded).await;
        eprintln!("live: {status:?} after {:?}", began.elapsed());
        let mut reported = 0;
        while matches!(status, MachineStatus::Booting) && began.elapsed() < Duration::from_secs(900)
        {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let polled = local.poll();
            if let Some(vm) = polled.report {
                match channel.report(&run.run_id, vec![vm]).await {
                    Ok(_) => reported += 1,
                    Err(error) => eprintln!("live: report refused: {error}"),
                }
            }
            if let Some(next) = polled.status {
                eprintln!("live: {next:?} after {:?}", began.elapsed());
                status = next;
            }
        }
        local.stop().await;
        let ended = channel.end_run(&run.run_id).await;
        eprintln!("live: ended: {:?}", ended.map(|answer| answer.run.active));
        assert!(
            matches!(status, MachineStatus::Ready { .. }),
            "the lab did not come up: {status:?}"
        );
        assert!(reported > 0, "no report reached intar");
    }
}
