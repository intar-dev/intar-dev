//! The run's machine on this computer: downloaded into the local cache when
//! it is not there, started through zpm, watched through Kino's reports, and stopped with the run.
//
// What the guest's Kino reports is shown here and handed to the engine as
// the state intar takes, the shape an agent host reports a VM in.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use intar_contracts::bridge::{VmTerminalStateKindV1, VmTerminalStateV1};
use intar_contracts::bridge_v9::{VmPhaseV2, VmStateV3};
use subspace::contract::LocalRunV1;
use subspace::{ArchiveCastV1, Subspace};
use zpm::machine::{Cache, Plan, RunningMachine};
use zpm::reports::GuestReport;

use crate::state::MachineStatus;
use crate::terminal::{RunKey, Target, Terminal};

/// Where a machine's recorded sessions are copied to, in its run directory.
const SESSIONS: &str = "sessions";
/// What intar takes for one replay, and for all of a machine's.
const MAX_CAST_BYTES: usize = 8 * 1024 * 1024;
const MAX_REPLAY_BYTES: usize = 64 * 1024 * 1024;
/// How long the guest gets to finish a session's recording after a logout.
const LOGOUT_GRACE: std::time::Duration = std::time::Duration::from_millis(700);

pub struct Local {
    cache: PathBuf,
    runs: PathBuf,
    /// The run a machine is running for, and the machine.
    machine: Option<(LocalRunV1, RunningMachine)>,
    last: Option<MachineStatus>,
    /// The key the terminal logs in with, until the terminal took it.
    key: Option<RunKey>,
    /// The machine's open terminal, to log out of before the machine stops.
    terminal: Option<Terminal>,
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
            key: None,
            terminal: None,
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
        // The app's terminal logs in with a key made for this run.
        let key = match RunKey::generate() {
            Ok(key) => key,
            Err(reason) => return MachineStatus::Failed(reason),
        };
        let login = key.public_openssh.clone();
        let (run_id, machine) = (run.run_id.clone(), machine.clone());
        let handle = tokio::runtime::Handle::current();
        // A guest without internet access reaches the app through this
        // program, run as `<program> relay <port>`: the app itself.
        let relay = match std::env::var_os("INTAR_RELAY") {
            Some(program) => PathBuf::from(program),
            None => match std::env::current_exe() {
                Ok(program) => program,
                Err(error) => {
                    return MachineStatus::Failed(format!(
                        "The app could not find its own program file: {error}"
                    ));
                }
            },
        };
        let started = tokio::task::spawn_blocking(move || {
            let arch = zpm::Arch::host().map_or("qemu-system-x86_64", zpm::Arch::qemu_binary);
            let plan = Plan {
                name: &machine.name,
                image: &machine.image,
                spec: &machine.spec,
                kino: &machine.kino,
                cpu_millis: machine.cpu_millis,
                memory_mib: machine.memory_mib,
                disk_mib: machine.disk_mib,
                egress: machine.egress,
                relay: &relay,
                authorized_keys: &[login],
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
                self.key = Some(key);
                MachineStatus::Booting
            }
            Ok(Err(error)) => MachineStatus::Failed(error.to_string()),
            Err(_) => MachineStatus::Failed("The machine could not be started.".to_owned()),
        }
    }

    /// Stops the machine, if one runs. Waits for QEMU to be gone.
    pub async fn stop(&mut self) {
        self.last = None;
        self.key = None;
        self.terminal = None;
        if let Some((_, machine)) = self.machine.take() {
            let _ = tokio::task::spawn_blocking(move || machine.stop()).await;
        }
    }

    /// Stops the machine and sends what its sessions recorded to intar, so
    /// the run's page can replay them. The run has to be ended afterwards; a
    /// run that ends first takes no recordings. `Ok` is how many sessions
    /// were sent.
    pub async fn stop_and_save(&mut self, channel: &Subspace) -> Result<usize, String> {
        let Some((run, machine)) = self.machine.as_ref() else {
            return Ok(0);
        };
        let listed = run
            .machines
            .iter()
            .find(|listed| listed.name == machine.name);
        // An intar that predates the archive routes names neither.
        let target = run
            .execution_id
            .clone()
            .zip(listed.and_then(|listed| listed.runtime_name.clone()));
        let dir = self.runs.join(&run.run_id).join(&machine.name);
        // Logging out lets the guest finish the session's recording; a session
        // cut off by the stopping machine is left unfinished and is not kept.
        if let Some(terminal) = self.terminal.take() {
            terminal.close();
            tokio::time::sleep(LOGOUT_GRACE).await;
        }
        // The disk is read only once the guest no longer writes to it.
        self.stop().await;
        let Some((execution_id, vm)) = target else {
            return Ok(0);
        };
        save_sessions(&dir, channel, &execution_id, &vm).await
    }

    /// The machine's terminal opened; it is logged out of when the run ends.
    pub fn opened(&mut self, terminal: Terminal) {
        self.terminal = Some(terminal);
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
        // The replay marks when each task was first solved; that is noted
        // beside the sessions while the machine runs.
        if let Some(report) = latest
            .as_ref()
            .filter(|report| !report.lab.tasks.is_empty())
        {
            let sessions = self
                .runs
                .join(&run.run_id)
                .join(&machine.name)
                .join(SESSIONS);
            let tasks = report.lab.tasks.clone();
            tokio::spawn(async move {
                let _ = dhd::check_passes::record_check_passes(&sessions, &tasks).await;
            });
        }
        let mut status = latest.as_ref().map(MachineStatus::of);
        // Once the guest's SSH is up and it has said which host keys are its
        // own, the terminal can open; that happens once per run.
        let terminal = latest
            .as_ref()
            .filter(|report| report.ssh_ready && !report.ssh_host_keys_openssh.is_empty())
            .and_then(|report| {
                let key = self.key.take()?;
                Some((
                    machine.name.clone(),
                    Target::new(machine.ssh_port, &key, report.ssh_host_keys_openssh.clone()),
                ))
            });
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
        Polled {
            status,
            report,
            terminal,
        }
    }
}

/// Reads the finished sessions off the stopped machine's recordings disk in
/// `dir`, renders their replays and sends them to intar.
async fn save_sessions(
    dir: &Path,
    channel: &Subspace,
    execution_id: &str,
    vm: &str,
) -> Result<usize, String> {
    let failed = |error: anyhow::Error| format!("{error:#}");
    let sessions = dir.join(SESSIONS);
    let (disk, into) = (dir.join("rec.vfat"), sessions.clone());
    tokio::task::spawn_blocking(move || dhd::recordings::extract(&disk, &into))
        .await
        .map_err(|_| "reading the recorded sessions stopped".to_owned())?
        .map_err(failed)?;
    let replay = dir.join("replay");
    tokio::fs::create_dir_all(&replay)
        .await
        .map_err(|error| format!("{}: {error}", replay.display()))?;
    let Some(rendered) = dhd::replay_media::render_session_media_into(&sessions, &replay)
        .await
        .map_err(failed)?
    else {
        return Ok(0);
    };
    let mut casts = Vec::new();
    for path in &rendered.cast_paths {
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_owned();
        casts.push(ArchiveCastV1 { filename, bytes });
    }
    // intar takes what it can show: no single replay over 8 MiB and no
    // more than 64 MiB for a machine.
    // ponytail: over a limit nothing is sent; send the sessions that fit
    // once a learner hits it.
    let total: usize = casts.iter().map(|cast| cast.bytes.len()).sum();
    if total > MAX_REPLAY_BYTES || casts.iter().any(|cast| cast.bytes.len() > MAX_CAST_BYTES) {
        return Err("the recorded sessions are larger than intar keeps for a run".to_owned());
    }
    let timeline = serde_json::to_value(&rendered.timeline).map_err(|error| error.to_string())?;
    channel
        .archive(execution_id, vm, &casts, &timeline)
        .await
        .map_err(|error| error.to_string())?;
    Ok(casts.len())
}

#[derive(Default)]
pub struct Polled {
    pub status: Option<MachineStatus>,
    pub report: Option<VmStateV3>,
    /// A machine whose terminal can open now, by name.
    pub terminal: Option<(String, Target)>,
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
        // The terminal can open a moment after the lab is ready: wait for both.
        let mut terminal = None;
        while (matches!(status, MachineStatus::Booting)
            || matches!(status, MachineStatus::Ready { .. }) && terminal.is_none())
            && began.elapsed() < Duration::from_secs(900)
        {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let polled = local.poll();
            terminal = terminal.or(polled.terminal);
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
        // The app's own key and the guest's reported host key open a shell.
        let mut typed = false;
        let mut opened = None;
        if let Some((machine, target)) = terminal {
            let size = crate::terminal::Size {
                columns: 100,
                rows: 30,
            };
            let (terminal, mut changes) = crate::terminal::open(&machine, target, size);
            terminal.write(b"echo terminal-$((40+2))\r".to_vec());
            let shows = |wanted: &str| {
                let grid = terminal.grid.lock();
                let screen: String = grid
                    .renderable_content()
                    .display_iter
                    .map(|cell| cell.c)
                    .collect();
                screen.contains(wanted)
            };
            let _ = tokio::time::timeout(Duration::from_secs(10), async {
                while !shows("terminal-42") && changes.recv().await.is_some() {}
            })
            .await;
            typed = shows("terminal-42");
            eprintln!("live: terminal on {machine}: {typed}");
            opened = Some(terminal.clone());
        }
        // Ending as the app does: log out, stop, send the sessions, then end.
        if let Some(terminal) = opened {
            local.opened(terminal);
        }
        let saved = local.stop_and_save(&channel).await;
        eprintln!("live: sessions saved: {saved:?}");
        local.stop().await;
        let ended = channel.end_run(&run.run_id).await;
        eprintln!("live: ended: {:?}", ended.map(|answer| answer.run.active));
        assert!(
            matches!(status, MachineStatus::Ready { .. }),
            "the lab did not come up: {status:?}"
        );
        assert!(reported > 0, "no report reached intar");
        assert!(typed, "the terminal did not show a command's output");
        assert_eq!(saved, Ok(1), "the terminal's session was not saved");
    }

    #[tokio::test]
    async fn a_stopped_machines_sessions_are_rendered_and_sent() {
        use std::io::Write as _;
        use std::sync::Mutex;

        use axum::body::Bytes;
        use axum::extract::{Path as UrlPath, State};
        use axum::http::{HeaderMap, Method};

        // intar's archive routes, noting what they were sent.
        type Calls = Arc<Mutex<Vec<(String, String, Option<String>, Bytes)>>>;
        async fn route(
            State(calls): State<Calls>,
            method: Method,
            UrlPath(path): UrlPath<String>,
            headers: HeaderMap,
            body: Bytes,
        ) -> axum::Json<serde_json::Value> {
            let length = headers
                .get("content-length")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            calls
                .lock()
                .expect("calls")
                .push((method.to_string(), path, length, body));
            axum::Json(serde_json::json!({ "done": false, "nextExpectedPart": 1 }))
        }
        let calls = Calls::default();
        let app = axum::Router::new()
            .route("/api/local/archive/{*path}", axum::routing::any(route))
            .with_state(calls.clone());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("listen");
        let base = format!("http://{}", listener.local_addr().expect("address"));
        tokio::spawn(async move { axum::serve(listener, app).await });
        let channel = Subspace::new(
            reqwest::Client::new(),
            base.parse().expect("url"),
            subspace::Tokens {
                access_token: "token".into(),
                refresh_token: None,
                expires_at: u64::MAX,
            },
        );

        // A recordings disk as a guest leaves it: one finished session, one cut off.
        let dir = tempfile::tempdir().expect("dir");
        let disk = dir.path().join("rec.vfat");
        zpm::rundisk::write_recording_disk(&disk).expect("disk");
        let session = concat!(
            r#"{"type":"header","format":"kino.raw-event-log","version":1,"width":80,"height":24,"start_timestamp_ms":1000}"#,
            "\n",
            r#"{"type":"event","offset_ms":10,"event":"o","data_b64":"aGVsbG8NCg=="}"#,
            "\n",
            r#"{"type":"event","offset_ms":900,"event":"x","exit_code":0}"#,
            "\n",
        );
        {
            let image = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&disk)
                .expect("open");
            let files = fatfs::FileSystem::new(image, fatfs::FsOptions::new()).expect("fat");
            let root = files.root_dir();
            for (name, text) in [
                ("ssh-session-1000-7.krec", session),
                ("ssh-session-2000-9.krec.partial", session),
            ] {
                root.create_file(name)
                    .expect("create")
                    .write_all(text.as_bytes())
                    .expect("write");
            }
        }

        assert_eq!(
            save_sessions(dir.path(), &channel, "execution-1", "web-run-1").await,
            Ok(1)
        );
        let calls = calls.lock().expect("calls");
        let steps: Vec<_> = calls
            .iter()
            .map(|(method, path, ..)| format!("{method} {path}"))
            .collect();
        let vm = "execution-1/vms/web-run-1";
        assert_eq!(
            steps,
            [
                "POST begin".to_owned(),
                format!("POST {vm}/artifacts/1/multipart-begin"),
                format!("PUT {vm}/artifacts/1/parts/1"),
                format!("POST {vm}/artifacts/1/complete"),
                format!("POST {vm}/timeline"),
                format!("POST {vm}/complete"),
            ]
        );
        // The manifest names the cast that the part then carries, whole.
        let begin: serde_json::Value = serde_json::from_slice(&calls[0].3).expect("begin");
        let cast = &calls[2];
        assert_eq!(begin["runId"], "execution-1");
        assert_eq!(begin["vmName"], "web-run-1");
        assert_eq!(begin["artifacts"][0]["kind"], "ssh_recording_segment");
        assert_eq!(begin["artifacts"][0]["filename"], "session-01.cast");
        assert_eq!(begin["artifacts"][0]["sizeBytes"], cast.3.len());
        assert_eq!(cast.2.as_deref(), Some(cast.3.len().to_string().as_str()));
        assert!(String::from_utf8_lossy(&cast.3).contains("hello"));
        let timeline: serde_json::Value = serde_json::from_slice(&calls[4].3).expect("timeline");
        assert_eq!(timeline["sessions"][0]["index"], 1);
        assert_eq!(timeline["sessions"][0]["castFilename"], "session-01.cast");
        assert_eq!(timeline["sessions"][0]["exitCode"], 0);
        assert!(
            timeline["sessions"][0]["transcript"]
                .as_str()
                .is_some_and(|text| text.contains("hello"))
        );
    }
}
