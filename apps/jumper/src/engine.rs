//! Everything that waits on the network runs here, on its own tokio runtime.
//! The UI sends [`Command`]s and receives [`Event`]s; it never blocks.

use std::sync::Arc;
use std::time::Duration;

use subspace::contract::LocalRunAnswerV1;
use subspace::{Error, SignIn, Subspace, Tokens};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use url::Url;

use crate::local::Local;
use crate::secrets::Keychain;
use crate::state::{Command, Event, MachineStatus};
use crate::terminal::{self, Size};
use crate::update::{self, Offer};

/// How often the running machine's reports are looked at.
const MACHINE_POLL: Duration = Duration::from_millis(300);
/// How long the learner has to finish in the browser.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

pub struct Engine {
    pub commands: UnboundedSender<Command>,
    pub events: UnboundedReceiver<Event>,
}

/// Starts the engine's thread. It ends when the UI drops its command sender.
pub fn start(base: Url) -> std::io::Result<Engine> {
    let (commands, mut inbox) = unbounded_channel::<Command>();
    let (outbox, events) = unbounded_channel::<Event>();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    std::thread::Builder::new()
        .name("jumper-engine".into())
        .spawn(move || {
            runtime.block_on(async move {
                let http = reqwest::Client::new();
                let keychain = Keychain::new(&base);
                let mut channel: Option<Arc<Subspace>> = None;
                // What the keychain holds, to write only when a call changed the tokens.
                let mut stored: Option<Tokens> = None;
                let mut local = Local::new();
                // The newer app intar offers, once asked.
                let mut offer: Option<Offer> = None;
                let mut tick = tokio::time::interval(MACHINE_POLL);
                // Commands that arrived while a machine was being started.
                let mut waiting = std::collections::VecDeque::new();
                loop {
                    let command = if let Some(command) = waiting.pop_front() { command } else { tokio::select! {
                        command = inbox.recv() => match command {
                            Some(command) => command,
                            // The window is gone: stop the machine with it.
                            None => break,
                        },
                        _ = tick.tick() => {
                            let polled = local.poll();
                            if let Some((machine, target)) = polled.terminal {
                                // The window fits the grid to its size at its first paint.
                                let size = Size { columns: 80, rows: 24 };
                                let (terminal, changes) = terminal::open(&machine, target, size);
                                local.opened(terminal.clone());
                                if outbox.send(Event::Terminal(terminal, changes)).is_err() {
                                    break;
                                }
                            }
                            if let Some(status) = polled.status
                                && outbox.send(Event::Machine(status)).is_err()
                            {
                                break;
                            }
                            // The guest's latest report goes to intar, which also keeps the
                            // run from being closed as silent. A report that cannot be sent
                            // is not queued: Kino repeats its latest every ten seconds.
                            if let (Some(vm), Some(reporting)) = (polled.report, channel.clone()) {
                                let closed = match reporting.report(&vm.run_id.clone(), vec![vm]).await {
                                    Ok(answer) => (!answer.run.active).then_some(Event::Run(answer.run)),
                                    // intar closed the run: its machine stops.
                                    Err(Error::Refused { run: Some(run), .. }) => Some(Event::Run(*run)),
                                    Err(Error::SignedOut) => Some(Event::SignedOut),
                                    Err(_) => None,
                                };
                                if let Some(event) = closed {
                                    local.stop().await;
                                    if matches!(event, Event::SignedOut) {
                                        channel = None;
                                    }
                                    if outbox.send(event).is_err() {
                                        break;
                                    }
                                }
                            }
                            continue;
                        }
                    } };
                    // The machine goes before the run or the sign-in does. A run the
                    // learner ends has its sessions sent to intar first: intar takes
                    // none for a run that is over.
                    let mut unsaved = None;
                    if let (Command::EndRun { run_id }, Some(channel)) = (&command, &channel)
                        && local.runs(run_id)
                    {
                        let _ = outbox.send(Event::Machine(MachineStatus::Saving));
                        unsaved = local.stop_and_save(channel).await.err();
                    }
                    if matches!(command, Command::EndRun { .. } | Command::SignOut) {
                        local.stop().await;
                    }
                    let event = match command {
                        Command::Restore => match keychain.load() {
                            Ok(Some(tokens)) => {
                                stored = Some(tokens.clone());
                                channel = Some(Arc::new(Subspace::new(http.clone(), base.clone(), tokens)));
                                Event::SignedIn
                            }
                            Ok(None) => Event::SignedOut,
                            Err(error) => Event::Failed(format!("The keychain could not be read: {error}")),
                        },
                        // ponytail: the tokens are forgotten here but stay valid on the
                        // server until they expire; revoke them once subspace can.
                        Command::SignOut => Event::SignedOut,
                        Command::SignIn => match sign_in(&http, &base, &outbox).await {
                            Ok(signed_in) => {
                                channel = Some(Arc::new(signed_in));
                                Event::SignedIn
                            }
                            Err(error) => Event::Failed(error.to_string()),
                        },
                        Command::LoadCatalog => match &channel {
                            None => Event::SignedOut,
                            Some(channel) => match channel.catalog().await {
                                Ok(catalog) => Event::Catalog(catalog.courses),
                                Err(Error::SignedOut) => Event::SignedOut,
                                Err(error) => Event::Failed(error.to_string()),
                            },
                        },
                        // Each press of Start is its own request; the server answers a repeat
                        // of the same key with the same run.
                        Command::StartRun { scenario_id, organization_id } => {
                            let key = uuid::Uuid::new_v4().to_string();
                            run_event(&channel, async |channel| {
                                channel
                                    .start_run(&scenario_id, organization_id.as_deref(), &[intar_contracts::guest::GUEST_CONTRACT], &key)
                                    .await
                            })
                            .await
                        }
                        Command::ReadRun { run_id } => run_event(&channel, async |channel| channel.run(&run_id).await).await,
                        Command::EndRun { run_id } => run_event(&channel, async |channel| channel.end_run(&run_id).await).await,
                        // A check that fails offers nothing; the next launch asks again.
                        Command::CheckUpdate => {
                            offer = subspace::app_release(&http, &base)
                                .await
                                .ok()
                                .flatten()
                                .and_then(|release| Offer::of(release, env!("CARGO_PKG_VERSION")));
                            Event::Update(offer.as_ref().map(|offer| offer.version.clone()))
                        }
                        Command::InstallUpdate => match &offer {
                            None => Event::Update(None),
                            // The machine would be left running without its app.
                            Some(_) if local.running() => Event::UpdateFailed("End the run before the app updates.".to_owned()),
                            Some(offer) => match install_update(&http, offer).await {
                                Ok(()) => Event::Restart,
                                Err(refusal) => Event::UpdateFailed(format!("The app was not updated: {refusal}.")),
                            },
                        },
                    };
                    // Keep the keychain current: after a sign-in, after a refresh, and
                    // empty once signed out, whether the learner or the server ended it.
                    if matches!(event, Event::SignedOut) {
                        channel = None;
                        local.stop().await;
                    }
                    // An active run gets its machine; a run intar closed loses it.
                    let boot = match (&event, &channel) {
                        (Event::Run(run), _) if !run.active => {
                            local.stop().await;
                            None
                        }
                        (Event::Run(run), Some(channel)) if !local.runs(&run.run_id) => Some((run.clone(), channel.clone())),
                        _ => None,
                    };
                    let current = match &channel {
                        Some(channel) => Some(channel.tokens().await),
                        None => None,
                    };
                    if current != stored {
                        let written = match &current {
                            Some(tokens) => keychain.save(tokens),
                            None => keychain.clear(),
                        };
                        stored = current;
                        if let Err(error) = written {
                            let note = format!("The keychain could not be updated, so the next launch may ask you to sign in again: {error}");
                            if outbox.send(Event::Failed(note)).is_err() {
                                break;
                            }
                        }
                    }
                    if outbox.send(event).is_err() {
                        break;
                    }
                    // Said after the run's end, so it stays on the closed run's screen.
                    if let Some(reason) = unsaved {
                        let note = format!("This run's terminal sessions could not be saved for its replay: {reason}");
                        if outbox.send(Event::Failed(note)).is_err() {
                            break;
                        }
                    }
                    if let Some((run, channel)) = boot {
                        let _ = outbox.send(Event::Machine(MachineStatus::Starting));
                        let downloaded = |done, total| {
                            let _ = outbox.send(Event::Machine(MachineStatus::Downloading { done, total }));
                        };
                        // A download can take minutes. Ending the run or signing out
                        // drops the start, and with it the download; anything else waits.
                        let status = {
                            let start = local.start(&run, channel, &downloaded);
                            tokio::pin!(start);
                            loop {
                                tokio::select! {
                                    status = &mut start => break Some(status),
                                    command = inbox.recv() => {
                                        let stop = !matches!(
                                            command,
                                            Some(
                                                Command::LoadCatalog
                                                    | Command::ReadRun { .. }
                                                    | Command::Restore
                                                    | Command::CheckUpdate
                                                    | Command::InstallUpdate
                                            )
                                        );
                                        waiting.extend(command);
                                        if stop {
                                            break None;
                                        }
                                    }
                                }
                            }
                        };
                        if let Some(status) = status
                            && outbox.send(Event::Machine(status)).is_err()
                        {
                            break;
                        }
                    }
                }
                local.stop().await;
            });
        })?;
    Ok(Engine { commands, events })
}

/// Downloads the offered app, puts it in this one's place and starts it.
async fn install_update(http: &reqwest::Client, offer: &Offer) -> Result<(), update::Refusal> {
    let bundle = update::bundle_of(&std::env::current_exe()?)?;
    let zip = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("intar")
        .join("jumper")
        .join(format!("update-{}.zip", offer.version));
    offer.download(http, &zip).await?;
    let installed = {
        let (bundle, zip, sha256) = (bundle, zip.clone(), offer.sha256.clone());
        // Hashing, unpacking and verifying take seconds; not on the engine's loop.
        tokio::task::spawn_blocking(move || {
            update::install(&bundle, env!("CARGO_PKG_VERSION"), &zip, &sha256)
        })
        .await
        .map_err(|error| update::Refusal::Io(std::io::Error::other(error)))?
    };
    let _ = tokio::fs::remove_file(&zip).await;
    update::start(&installed?)?;
    Ok(())
}

async fn sign_in(
    http: &reqwest::Client,
    base: &Url,
    outbox: &UnboundedSender<Event>,
) -> Result<Subspace, Error> {
    let sign_in = SignIn::begin(base).await?;
    // The UI opens the browser and shows the link.
    let _ = outbox.send(Event::SignInStarted(sign_in.authorize_url().to_string()));
    let tokens = tokio::time::timeout(SIGN_IN_TIMEOUT, sign_in.finish(http))
        .await
        .map_err(|_| Error::SignIn("no answer from the browser in five minutes".into()))??;
    Ok(Subspace::new(http.clone(), base.clone(), tokens))
}

/// One call about a run, as the event the UI gets.
async fn run_event(
    channel: &Option<Arc<Subspace>>,
    call: impl AsyncFnOnce(&Subspace) -> Result<LocalRunAnswerV1, Error>,
) -> Event {
    let Some(channel) = channel else {
        return Event::SignedOut;
    };
    match call(channel).await {
        Ok(answer) => Event::Run(answer.run),
        Err(Error::SignedOut) => Event::SignedOut,
        // A run the server has closed is still the run to show.
        Err(Error::Refused { run: Some(run), .. }) => Event::Run(*run),
        Err(Error::Refused { message, .. }) if !message.is_empty() => Event::Failed(message),
        Err(error) => Event::Failed(error.to_string()),
    }
}
