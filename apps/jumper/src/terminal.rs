//! A machine's terminal without its window (#402): an SSH session to the
//! guest's forwarded port, and the grid its output is drawn from. The window
//! side is `ui/terminal_view.rs`.
//
// ponytail: one session per machine and no reconnect; a closed session says
// so in the grid. Recording a local run's sessions is an open decision (#399).

use std::sync::Arc;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};
use intar_contracts::guest::GUEST_USERNAME;
use russh::keys::ssh_key::{Algorithm, PublicKey};
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, client};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// Lines kept above the screen.
const SCROLLBACK: usize = 10_000;

/// What the emulator holds: the screen, the scrollback and the modes.
pub type Grid = Arc<FairMutex<Term<Replies>>>;

/// The key the app logs in to a run's machines with. It lives as long as the
/// run and is never written anywhere.
pub struct RunKey {
    private: Arc<PrivateKey>,
    /// The line for the guest's `authorized_keys`.
    pub public_openssh: String,
}

impl RunKey {
    pub fn generate() -> Result<Self, String> {
        let failed = |error: russh::keys::ssh_key::Error| {
            format!("The app could not make a key for the terminal: {error}")
        };
        let private = PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519)
            .map_err(failed)?;
        Ok(Self {
            public_openssh: private.public_key().to_openssh().map_err(failed)?,
            private: Arc::new(private),
        })
    }
}

/// Where a machine's SSH is and how to know it is that machine.
pub struct Target {
    /// On 127.0.0.1.
    pub port: u16,
    pub key: Arc<PrivateKey>,
    /// The guest's host keys as its Kino reported them, in OpenSSH form.
    pub host_keys: Vec<String>,
}

impl Target {
    pub fn new(port: u16, key: &RunKey, host_keys: Vec<String>) -> Self {
        Self {
            port,
            key: key.private.clone(),
            host_keys,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Size {
    pub columns: usize,
    pub rows: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }

    fn screen_lines(&self) -> usize {
        self.rows
    }

    fn columns(&self) -> usize {
        self.columns
    }
}

enum ToGuest {
    Bytes(Vec<u8>),
    Resize(Size),
}

/// The emulator's own answers to the guest, such as where the cursor is.
#[derive(Clone)]
pub struct Replies(UnboundedSender<ToGuest>);

impl EventListener for Replies {
    fn send_event(&self, event: Event) {
        if let Event::PtyWrite(text) = event {
            let _ = self.0.send(ToGuest::Bytes(text.into_bytes()));
        }
    }
}

/// One machine's terminal: read the grid to draw it, write what was typed.
#[derive(Clone)]
pub struct Terminal {
    pub machine: String,
    pub grid: Grid,
    to_guest: UnboundedSender<ToGuest>,
}

impl std::fmt::Debug for Terminal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Terminal")
            .field("machine", &self.machine)
            .finish_non_exhaustive()
    }
}

impl Terminal {
    pub fn write(&self, bytes: Vec<u8>) {
        // The session is gone once the run is; typing then goes nowhere.
        let _ = self.to_guest.send(ToGuest::Bytes(bytes));
    }

    /// The grid takes the new size at once, so the next frame fits; the
    /// guest hears of it through the session.
    pub fn resize(&self, size: Size) {
        let mut grid = self.grid.lock();
        if (grid.columns(), grid.screen_lines()) != (size.columns, size.rows) {
            grid.resize(size);
            let _ = self.to_guest.send(ToGuest::Resize(size));
        }
    }
}

/// Opens `machine`'s terminal. The session runs on the calling tokio runtime
/// until the guest closes it or the [`Terminal`] and its copies are dropped.
/// The receiver hears whenever the grid changed.
pub fn open(machine: &str, target: Target, size: Size) -> (Terminal, UnboundedReceiver<()>) {
    let (to_guest, from_window) = unbounded_channel();
    let (changed, changes) = unbounded_channel();
    let config = Config {
        scrolling_history: SCROLLBACK,
        ..Config::default()
    };
    let grid = Arc::new(FairMutex::new(Term::new(
        config,
        &size,
        Replies(to_guest.clone()),
    )));
    let terminal = Terminal {
        machine: machine.to_owned(),
        grid: grid.clone(),
        to_guest,
    };
    tokio::spawn(async move {
        let mut parser = Processor::<StdSyncHandler>::new();
        let mut show = |bytes: &[u8]| {
            parser.advance(&mut *grid.lock(), bytes);
            let _ = changed.send(());
        };
        let ended = session(&target, size, from_window, &mut show).await;
        let note = match ended {
            Ok(()) => "The session ended.".to_owned(),
            Err(reason) => reason,
        };
        show(format!("\r\n\x1b[0;2m{note}\x1b[0m\r\n").as_bytes());
    });
    (terminal, changes)
}

/// The bytes a key press sends to the guest, as xterm does. `key` is the
/// key's name, `typed` the character it would type. `None` for a key that
/// sends nothing, and for every key held with the platform's command key.
pub fn encode_key(
    key: &str,
    typed: Option<&str>,
    control: bool,
    alt: bool,
    shift: bool,
    platform: bool,
    app_cursor: bool,
) -> Option<Vec<u8>> {
    if platform {
        return None;
    }
    // Full-screen programs switch the arrow keys to their "application" form.
    let cursor = |end: char| format!("\x1b{}{end}", if app_cursor { 'O' } else { '[' });
    let sequence = match key {
        "enter" => "\r".to_owned(),
        "backspace" => "\x7f".to_owned(),
        "escape" => "\x1b".to_owned(),
        "tab" if shift => "\x1b[Z".to_owned(),
        "tab" => "\t".to_owned(),
        "up" => cursor('A'),
        "down" => cursor('B'),
        "right" => cursor('C'),
        "left" => cursor('D'),
        "home" => cursor('H'),
        "end" => cursor('F'),
        "insert" => "\x1b[2~".to_owned(),
        "delete" => "\x1b[3~".to_owned(),
        "pageup" => "\x1b[5~".to_owned(),
        "pagedown" => "\x1b[6~".to_owned(),
        "f1" => "\x1bOP".to_owned(),
        "f2" => "\x1bOQ".to_owned(),
        "f3" => "\x1bOR".to_owned(),
        "f4" => "\x1bOS".to_owned(),
        "f5" => "\x1b[15~".to_owned(),
        "f6" => "\x1b[17~".to_owned(),
        "f7" => "\x1b[18~".to_owned(),
        "f8" => "\x1b[19~".to_owned(),
        "f9" => "\x1b[20~".to_owned(),
        "f10" => "\x1b[21~".to_owned(),
        "f11" => "\x1b[23~".to_owned(),
        "f12" => "\x1b[24~".to_owned(),
        _ if control => {
            let code = match key {
                "space" | "@" | "2" => 0,
                "[" => 0x1b,
                "\\" => 0x1c,
                "]" => 0x1d,
                "^" | "6" => 0x1e,
                "_" | "-" | "/" => 0x1f,
                letter => match letter.as_bytes() {
                    [byte @ b'a'..=b'z'] => byte & 0x1f,
                    _ => return None,
                },
            };
            char::from(code).to_string()
        }
        "space" => " ".to_owned(),
        // Option composes characters on a Mac; elsewhere Alt is Meta, which
        // programs read as Escape before the key.
        _ if alt && !cfg!(target_os = "macos") && key.chars().count() == 1 => {
            format!("\x1b{key}")
        }
        _ => typed?.to_owned(),
    };
    Some(sequence.into_bytes())
}

/// Accepts the guest's own host key and nothing else.
struct KnownGuest(Vec<PublicKey>);

impl client::Handler for KnownGuest {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // A key itself, never a certificate; comments are not part of a key.
        let PublicKeyOrCertificate::PublicKey { key, .. } = server else {
            return Ok(false);
        };
        Ok(self
            .0
            .iter()
            .any(|known| known.key_data() == key.key_data()))
    }
}

/// Runs the session until either side ends it. `show` takes the guest's output.
async fn session(
    target: &Target,
    size: Size,
    mut from_window: UnboundedReceiver<ToGuest>,
    show: &mut impl FnMut(&[u8]),
) -> Result<(), String> {
    let failed = |error: russh::Error| format!("The terminal lost its connection: {error}");
    let known: Vec<PublicKey> = target
        .host_keys
        .iter()
        .filter_map(|line| PublicKey::from_openssh(line).ok())
        .collect();
    if known.is_empty() {
        return Err("The machine has not said which SSH key is its own.".to_owned());
    }
    let mut connection = client::connect(
        Arc::new(client::Config::default()),
        ("127.0.0.1", target.port),
        KnownGuest(known),
    )
    .await
    .map_err(|error| format!("The terminal could not connect to the machine: {error}"))?;
    let login = connection
        .authenticate_publickey(
            GUEST_USERNAME,
            PrivateKeyWithHashAlg::new(target.key.clone(), None),
        )
        .await
        .map_err(failed)?;
    if !login.success() {
        return Err("The machine did not accept the app's key.".to_owned());
    }
    let cells = |size: Size| {
        (
            u32::try_from(size.columns).unwrap_or(u32::MAX),
            u32::try_from(size.rows).unwrap_or(u32::MAX),
        )
    };
    let mut channel = connection.channel_open_session().await.map_err(failed)?;
    let (columns, rows) = cells(size);
    channel
        .request_pty(false, "xterm-256color", columns, rows, 0, 0, &[])
        .await
        .map_err(failed)?;
    channel.request_shell(false).await.map_err(failed)?;
    loop {
        tokio::select! {
            message = channel.wait() => match message {
                Some(ChannelMsg::Data { data }) => show(&data),
                Some(ChannelMsg::ExtendedData { data, .. }) => show(&data),
                Some(ChannelMsg::Eof | ChannelMsg::Close) | None => return Ok(()),
                Some(_) => {}
            },
            typed = from_window.recv() => match typed {
                Some(ToGuest::Bytes(bytes)) => channel.data(&bytes[..]).await.map_err(failed)?,
                Some(ToGuest::Resize(size)) => {
                    let (columns, rows) = cells(size);
                    channel.window_change(columns, rows, 0, 0).await.map_err(failed)?;
                }
                // The window let go of the terminal.
                None => return Ok(()),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(grid: &Grid) -> String {
        let grid = grid.lock();
        let mut lines = vec![String::new(); grid.screen_lines()];
        // Scrolled back, the lines on screen count from below zero.
        let scrolled = i32::try_from(grid.grid().display_offset()).expect("offset");
        for cell in grid.renderable_content().display_iter {
            if let Some(line) = usize::try_from(cell.point.line.0 + scrolled)
                .ok()
                .and_then(|line| lines.get_mut(line))
            {
                line.push(cell.c);
            }
        }
        lines
            .iter()
            .map(|line| line.trim_end())
            .collect::<Vec<_>>()
            .join("\n")
            .trim_end()
            .to_owned()
    }

    #[test]
    fn keys_become_what_xterm_sends() {
        let plain = |key: &str, typed: Option<&str>| {
            encode_key(key, typed, false, false, false, false, false)
        };
        assert_eq!(plain("a", Some("a")), Some(b"a".to_vec()));
        assert_eq!(
            plain("a", Some("A")),
            Some(b"A".to_vec()),
            "shift types its own text"
        );
        assert_eq!(plain("enter", None), Some(b"\r".to_vec()));
        assert_eq!(plain("backspace", None), Some(vec![0x7f]));
        assert_eq!(plain("up", None), Some(b"\x1b[A".to_vec()));
        assert_eq!(plain("f5", None), Some(b"\x1b[15~".to_vec()));
        assert_eq!(plain("shift", None), None, "a modifier alone sends nothing");
        // Full-screen programs ask for the other arrow form.
        assert_eq!(
            encode_key("up", None, false, false, false, false, true),
            Some(b"\x1bOA".to_vec())
        );
        let control = |key: &str| encode_key(key, None, true, false, false, false, false);
        assert_eq!(control("c"), Some(vec![3]));
        assert_eq!(control("d"), Some(vec![4]));
        assert_eq!(control("["), Some(vec![0x1b]));
        assert_eq!(control("space"), Some(vec![0]));
        assert_eq!(control("1"), None);
        assert_eq!(
            encode_key("tab", None, false, false, true, false, false),
            Some(b"\x1b[Z".to_vec())
        );
        // Command shortcuts belong to the app, never to the guest.
        assert_eq!(
            encode_key("c", Some("c"), false, false, false, true, false),
            None
        );
    }

    #[tokio::test]
    async fn a_terminal_that_cannot_connect_says_so_in_its_grid() {
        let key = RunKey::generate().expect("key");
        assert!(key.public_openssh.starts_with("ssh-ed25519 "));
        let size = Size {
            columns: 80,
            rows: 6,
        };

        // No host key reported: the app does not connect to it knows not what.
        let (terminal, mut changes) = open("web", Target::new(1, &key, vec![]), size);
        changes.recv().await.expect("a change");
        assert_eq!(
            text(&terminal.grid),
            "\nThe machine has not said which SSH key is its own."
        );

        // A port nothing listens on.
        let port = std::net::TcpListener::bind(("127.0.0.1", 0))
            .expect("bind")
            .local_addr()
            .expect("address")
            .port();
        let host = vec![key.public_openssh.clone()];
        let (terminal, mut changes) = open("web", Target::new(port, &key, host), size);
        changes.recv().await.expect("a change");
        assert!(
            text(&terminal.grid).contains("The terminal could not connect to the machine"),
            "{}",
            text(&terminal.grid)
        );

        // A resize reaches the grid at once.
        terminal.resize(Size {
            columns: 100,
            rows: 30,
        });
        assert_eq!(terminal.grid.lock().columns(), 100);
    }

    /// Against a real guest: `INTAR_TEST_SSH=<port>,<private key file>,<host
    /// public key file>` with the port on 127.0.0.1.
    #[tokio::test]
    #[ignore = "needs a running guest"]
    async fn a_session_shows_a_command_and_answers_the_guests_questions() {
        let setting = std::env::var("INTAR_TEST_SSH").expect("INTAR_TEST_SSH");
        let [port, private, host] = setting.split(',').collect::<Vec<_>>()[..] else {
            panic!("INTAR_TEST_SSH is <port>,<private key file>,<host public key file>");
        };
        let private = std::fs::read_to_string(private).expect("private key");
        let target = Target {
            port: port.parse().expect("port"),
            key: Arc::new(PrivateKey::from_openssh(private).expect("private key")),
            host_keys: vec![std::fs::read_to_string(host).expect("host key")],
        };
        let size = Size {
            columns: 100,
            rows: 30,
        };
        let (terminal, mut changes) = open("guest", target, size);
        // `stty size` asks the pty; the cursor report is the emulator's own answer.
        terminal
            .write(b"stty size; printf 'wide: \\xe4\\xb8\\xad\\n'; echo done-$((40+2))\r".to_vec());
        let waited = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while changes.recv().await.is_some() {
                if text(&terminal.grid).contains("done-42") {
                    break;
                }
            }
        })
        .await;
        let shown = text(&terminal.grid);
        eprintln!("{shown}");
        assert!(waited.is_ok(), "no output in ten seconds");
        assert!(shown.contains("30 100"), "the guest sees the grid's size");
        assert!(shown.contains("wide: 中"));

        // A full-screen program takes the other screen and gives it back.
        let mut until = async |wanted: &str, full_screen: bool| {
            let there = || {
                let on_other = terminal
                    .grid
                    .lock()
                    .mode()
                    .contains(alacritty_terminal::term::TermMode::ALT_SCREEN);
                on_other == full_screen && text(&terminal.grid).contains(wanted)
            };
            let waited = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                while !there() && changes.recv().await.is_some() {}
            })
            .await;
            if waited.is_err() {
                eprintln!("waiting for {wanted:?}:\n{}", text(&terminal.grid));
            }
            waited.is_ok() && there()
        };
        // The lab images carry no pager or editor, so the shell switches screens itself.
        terminal.write(
            b"printf '\\033[?1049hon-the-other-screen'; read -n1; printf '\\033[?1049l'\r".to_vec(),
        );
        assert!(
            until("on-the-other-screen", true).await,
            "the other screen shows"
        );
        terminal.write(b"q".to_vec());
        assert!(until("done-42", false).await, "the shell's screen is back");
        // Scrollback keeps what ran off the top.
        terminal.write(b"seq 1 500\r".to_vec());
        assert!(until("\n500", false).await);
        terminal
            .grid
            .lock()
            .scroll_display(alacritty_terminal::grid::Scroll::Top);
        assert!(
            text(&terminal.grid).contains("stty size"),
            "the first line is still there"
        );
    }
}
