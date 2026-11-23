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
use crate::state::{Command, Event, History, Learn, MachineStatus};
use crate::terminal::{self, Size};
use crate::update::{self, Offer};

/// How often the running machine's reports are looked at.
const MACHINE_POLL: Duration = Duration::from_millis(300);
/// The largest replay part the app plays, as the website's
/// `MAX_INLINE_REPLAY_BYTES`.
pub const MAX_REPLAY_BYTES: usize = 2 * 1024 * 1024;
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
                // reqwest has no crypto provider of its own; install ring first.
                let _ = rustls::crypto::ring::default_provider().install_default();
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
                                let run_id = vm.run_id.clone();
                                let closed = match reporting.report(&run_id, vec![vm]).await {
                                    // The report may have verified a check: the learning
                                    // panel follows. A refresh that fails waits for the next.
                                    Ok(answer) if answer.run.active => {
                                        let refreshed = learn(&reporting, Learn::Run { run_id }).await;
                                        if matches!(refreshed, Event::Learning(_)) && outbox.send(refreshed).is_err() {
                                            break;
                                        }
                                        None
                                    }
                                    Ok(answer) => Some(Event::Run(answer.run)),
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
                        Command::Learn(call) => match &channel {
                            None => Event::SignedOut,
                            Some(channel) => learn(channel, call).await,
                        },
                        Command::History(call) => match &channel {
                            None => Event::SignedOut,
                            Some(channel) => history(channel, call).await,
                        },
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
                        Command::InstallUpdate => match offer.take() {
                            None => Event::Update(None),
                            // The machine would be left running without its app.
                            // ponytail: only this app's machine is seen; a second copy of the
                            // app that runs one keeps running on the program it has loaded.
                            Some(kept) if local.running() => {
                                offer = Some(kept);
                                Event::UpdateFailed("End the run before the app updates.".to_owned())
                            }
                            Some(taken) => match install_update(&http, &taken).await {
                                Ok(bundle) => match update::start(&bundle) {
                                    Ok(()) => Event::Restart,
                                    // The new app is in place and this one is the old one
                                    // still running: there is nothing to offer any more.
                                    Err(_) => Event::UpdateFailed("The new version is installed. Quit Intar and open it again.".to_owned()),
                                },
                                Err(refusal) => {
                                    offer = Some(taken);
                                    Event::UpdateFailed(format!("The app was not updated: {refusal}."))
                                }
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
                    // The new app is starting. Whatever was asked while it was installed
                    // is not begun: a run started now would be left without its app.
                    let restarting = matches!(event, Event::Restart);
                    // A run that opens brings what it teaches.
                    let opened = match (&event, &channel) {
                        (Event::Run(run), Some(channel)) if run.active => Some((run.run_id.clone(), channel.clone())),
                        _ => None,
                    };
                    if outbox.send(event).is_err() || restarting {
                        break;
                    }
                    // Said after the run's end, so it stays on the closed run's screen.
                    if let Some(reason) = unsaved {
                        let note = format!("This run's terminal sessions could not be saved for its replay: {reason}");
                        if outbox.send(Event::Failed(note)).is_err() {
                            break;
                        }
                    }
                    if let Some((run_id, channel)) = opened
                        && !quiet_send(&outbox, learn(&channel, Learn::Run { run_id }).await)
                    {
                        break;
                    }
                    if let Some((run, channel)) = boot {
                        let learning = channel.clone();
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
                                        // What the learner reads does not wait for the machine.
                                        let answer = match command {
                                            Some(Command::Learn(call)) => learn(&learning, call).await,
                                            Some(Command::History(call)) => history(&learning, call).await,
                                            other => {
                                                let stop = !matches!(
                                                    other,
                                                    Some(
                                                        Command::LoadCatalog
                                                            | Command::ReadRun { .. }
                                                            | Command::Restore
                                                            | Command::CheckUpdate
                                                            | Command::InstallUpdate
                                                    )
                                                );
                                                waiting.extend(other);
                                                if stop {
                                                    break None;
                                                }
                                                continue;
                                            }
                                        };
                                        if !quiet_send(&outbox, answer) {
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

/// Downloads the offered app and puts it in this one's place; the bundle to
/// start.
async fn install_update(
    http: &reqwest::Client,
    offer: &Offer,
) -> Result<std::path::PathBuf, update::Refusal> {
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
    installed
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

/// One call about what the learner reads, as the event the UI gets.
async fn learn(channel: &Subspace, call: Learn) -> Event {
    let answer = match call {
        Learn::Lecture(at) => channel
            .lecture(&at.course_id, &at.lecture_id, at.organization_id.as_deref())
            .await
            .map(Event::Lecture),
        Learn::CompleteLecture(at) => channel
            .complete_lecture(&at.course_id, &at.lecture_id, at.organization_id.as_deref())
            .await
            .map(Event::Lecture),
        Learn::Run { run_id } => channel
            .learning(&run_id)
            .await
            .map(|answer| Event::Learning(answer.learning)),
        Learn::RevealHint { run_id, hint_key } => channel
            .reveal_hint(&run_id, &hint_key)
            .await
            .map(|answer| Event::Learning(answer.learning)),
        Learn::RevealSolution { run_id } => channel
            .reveal_solution(&run_id)
            .await
            .map(|answer| Event::Learning(answer.learning)),
    };
    answer.unwrap_or_else(failed)
}

/// One call about the learner's runs, as the event the UI gets.
async fn history(channel: &Subspace, call: History) -> Event {
    let answer = match call {
        History::List => channel
            .history()
            .await
            .map(|history| Event::History(history.runs)),
        History::Recap { run_id } => channel
            .recap(&run_id)
            .await
            .map(|answer| Event::Recap(answer.recap)),
        History::Replay {
            run_id,
            artifact_id,
        } => channel
            .replay(&run_id, &artifact_id, MAX_REPLAY_BYTES)
            .await
            .map(|cast| Event::Replay {
                run_id,
                artifact_id,
                cast,
            }),
    };
    answer.unwrap_or_else(failed)
}

/// Sends an event from beside the engine's main path; false once the window
/// is gone. A lost sign-in is not said here: the main path forgets the
/// tokens and stops the machine when its next call hears it.
fn quiet_send(outbox: &UnboundedSender<Event>, event: Event) -> bool {
    matches!(event, Event::SignedOut) || outbox.send(event).is_ok()
}

/// A failed call, in the learner's words.
fn failed(error: Error) -> Event {
    match error {
        Error::SignedOut => Event::SignedOut,
        Error::Refused { message, .. } if !message.is_empty() => Event::Failed(message),
        error => Event::Failed(error.to_string()),
    }
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
        // A run the server has closed is still the run to show.
        Err(Error::Refused { run: Some(run), .. }) => Event::Run(*run),
        Err(error) => failed(error),
    }
}
