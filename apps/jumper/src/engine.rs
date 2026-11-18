//! Everything that waits on the network runs here, on its own tokio runtime.
//! The UI sends [`Command`]s and receives [`Event`]s; it never blocks.

use std::sync::Arc;
use std::time::Duration;

use subspace::{Error, SignIn, Subspace};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use url::Url;

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
                // ponytail: tokens live in memory, so every launch signs in again;
                // the OS keychain is next (#400).
                let mut channel: Option<Arc<Subspace>> = None;
                while let Some(command) = inbox.recv().await {
                    let event = match command {
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
