//! The run's machine on this computer: started through zpm from the local
//! cache, watched through Kino's reports, and stopped with the run.
//
// ponytail: what the guest reports is shown here but not sent to intar yet,
// so intar still sees the run as starting and closes it after an hour
// without a report. Sending needs the learner's id in the run view (#399).

use std::path::PathBuf;
use std::sync::Arc;

use subspace::Subspace;
use subspace::contract::LocalRunV1;
use zpm::machine::{Cache, Plan, RunningMachine};

use crate::state::MachineStatus;

pub struct Local {
    cache: PathBuf,
    runs: PathBuf,
    /// The run a machine is running for, and the machine.
    machine: Option<(String, RunningMachine)>,
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
            .is_some_and(|(running, _)| running == run_id)
    }

    /// Starts the run's machine. The guest's `intar` command is answered by
    /// passing it on to intar over `channel`.
    pub async fn start(&mut self, run: &LocalRunV1, channel: Arc<Subspace>) -> MachineStatus {
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
                self.machine = Some((run.run_id.clone(), machine));
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

    /// The machine's status if it changed since the last call.
    pub fn poll(&mut self) -> Option<MachineStatus> {
        let (_, machine) = self.machine.as_mut()?;
        let mut status = None;
        while let Ok(report) = machine.reports.reports.try_recv() {
            status = Some(MachineStatus::of(&report));
        }
        if !machine.is_running() {
            status = Some(MachineStatus::Failed("The machine stopped.".to_owned()));
            self.machine = None;
        }
        let status = status.filter(|status| self.last.as_ref() != Some(status))?;
        self.last = Some(status.clone());
        Some(status)
    }
}
