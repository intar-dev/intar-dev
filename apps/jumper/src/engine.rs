//! Everything that waits on the network runs here, on its own tokio runtime.
//! The UI sends [`Command`]s and receives [`Event`]s; it never blocks.

use std::sync::Arc;
use std::time::Duration;

use subspace::{Error, SignIn, Subspace, Tokens};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use url::Url;

use crate::secrets::Keychain;
use crate::state::{Command, Event};

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
                while let Some(command) = inbox.recv().await {
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
                    };
                    // Keep the keychain current: after a sign-in, after a refresh, and
                    // empty once signed out, whether the learner or the server ended it.
                    if matches!(event, Event::SignedOut) {
                        channel = None;
                    }
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
                }
            });
        })?;
    Ok(Engine { commands, events })
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
