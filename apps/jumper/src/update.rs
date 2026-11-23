//! Replaces the app with a newer one (#404). The app runs from its bundle,
//! `Intar.app`; an update is that bundle zipped, as a release publishes it.
//! The zip is checked against the SHA-256 the app was told, unpacked beside
//! the running bundle, checked again as a bundle, and then the two change
//! places. The old bundle is kept until the new one is in place, so a swap
//! that fails half way is put back.
//!
//! Only macOS: the bundle, its signature and the tools used here are its own.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest as _, Sha256};

/// Why an update was not installed. Every one leaves the running app as it
/// was.
#[derive(Debug)]
pub enum Refusal {
    /// The program is not inside an app bundle, as a development build.
    NotABundle,
    /// macOS runs a downloaded app that was never moved from a read-only
    /// copy; there is no bundle to replace until the learner moves it.
    Translocated,
    /// The app's folder cannot be written by this user.
    NotWritable(PathBuf),
    /// The download is not the file the app was told to expect.
    WrongDigest,
    /// What was unpacked is not the app, not intact, or not newer.
    NotTheUpdate(String),
    /// The swap failed half way and the app could not be put back: it is
    /// in this folder, whole, and no longer where it was.
    Stranded(PathBuf),
    Io(std::io::Error),
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotABundle => write!(f, "this copy of the app is not an installed app"),
            Self::Translocated => write!(
                f,
                "move Intar into the Applications folder and open it again; macOS keeps a downloaded app read-only until it is moved"
            ),
            Self::NotWritable(folder) => write!(
                f,
                "the folder {} cannot be changed by this user",
                folder.display()
            ),
            Self::WrongDigest => write!(f, "the download is not the published update"),
            Self::NotTheUpdate(why) => write!(f, "the download is not a usable update: {why}"),
            Self::Stranded(kept) => write!(
                f,
                "the app could not be put back in its place; it is kept at {}, move it back from there",
                kept.display()
            ),
            Self::Io(error) => write!(f, "{error}"),
        }
    }
}

impl From<std::io::Error> for Refusal {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// The bundle a program at `program` runs from:
/// `<folder>/<name>.app/Contents/MacOS/<program>`.
pub fn bundle_of(program: &Path) -> Result<PathBuf, Refusal> {
    // macOS names the read-only copy's mount this way.
    if program
        .components()
        .any(|part| part.as_os_str() == "AppTranslocation")
    {
        return Err(Refusal::Translocated);
    }
    let bundle = program
        .parent()
        .filter(|macos| macos.file_name().is_some_and(|name| name == "MacOS"))
        .and_then(Path::parent)
        .filter(|contents| contents.file_name().is_some_and(|name| name == "Contents"))
        .and_then(Path::parent)
        .filter(|bundle| bundle.extension().is_some_and(|ext| ext == "app"))
        .ok_or(Refusal::NotABundle)?;
    Ok(bundle.to_path_buf())
}

/// A release that is newer than the running app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub version: String,
    pub sha256: String,
    pub url: url::Url,
}

/// The largest download taken for an update; the app is some 15 MB.
const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;
/// How long a download may take in all; a stalled one must not hold the app.
const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
/// Where the app's releases are. An offer from anywhere else is none: intar
/// names the download and its hash, and must not be able to name the place.
const RELEASES: &str = "https://github.com/intar-dev/intar-dev/releases/download/";
/// Names another place for the app's releases, as `INTAR_URL` names another
/// intar: for trying an update against a stand-in. Whoever can set the app's
/// environment runs what they like anyway.
const RELEASES_OVERRIDE: &str = "INTAR_RELEASES";
/// The staging folders an install makes beside the app.
const STAGING: &str = ".intar-update-";

impl Offer {
    /// `release` as an offer, when it is strictly newer than `running` and
    /// its download is one of the app's own releases.
    pub fn of(release: subspace::contract::AppReleaseV1, running: &str) -> Option<Self> {
        let releases = std::env::var(RELEASES_OVERRIDE).unwrap_or_else(|_| RELEASES.to_owned());
        Self::from(release, running, &releases)
    }

    fn from(
        release: subspace::contract::AppReleaseV1,
        running: &str,
        releases: &str,
    ) -> Option<Self> {
        let url = url::Url::parse(&release.url).ok()?;
        (url.as_str().starts_with(releases) && version(&release.version)? > version(running)?)
            .then_some(Self {
                version: release.version,
                sha256: release.sha256,
                url,
            })
    }

    /// Downloads the offer's zip to `file`. What it holds is checked by
    /// [`install`], against the offer's SHA-256.
    pub async fn download(&self, http: &reqwest::Client, file: &Path) -> Result<(), Refusal> {
        use tokio::io::AsyncWriteExt as _;

        let failed = |error: reqwest::Error| Refusal::Io(std::io::Error::other(error));
        let mut response = http
            .get(self.url.clone())
            .timeout(DOWNLOAD_TIMEOUT)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(failed)?;
        if let Some(parent) = file.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut out = tokio::fs::File::create(file).await?;
        let mut taken = 0_u64;
        while let Some(chunk) = response.chunk().await.map_err(failed)? {
            taken += chunk.len() as u64;
            if taken > MAX_UPDATE_BYTES {
                return Err(Refusal::NotTheUpdate(
                    "the download is too large".to_owned(),
                ));
            }
            out.write_all(&chunk).await?;
        }
        out.flush().await?;
        Ok(())
    }
}

/// `major.minor.patch` as numbers; anything else is not a version.
pub fn version(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.split('.').map(str::parse::<u64>);
    let version = (
        parts.next()?.ok()?,
        parts.next()?.ok()?,
        parts.next()?.ok()?,
    );
    parts.next().is_none().then_some(version)
}

fn sha256_of(file: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(file)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Runs a system tool and gives what it printed, or why it failed.
fn tool(program: &str, arguments: &[&std::ffi::OsStr]) -> Result<String, Refusal> {
    let output = Command::new(program).args(arguments).output()?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    } else {
        Err(Refusal::NotTheUpdate(format!(
            "{program}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

/// The Apple team that signed `bundle`; none for an ad hoc signature.
fn team_of(bundle: &Path) -> Result<Option<String>, Refusal> {
    let output = Command::new("/usr/bin/codesign")
        .args(["-d", "--verbose=2"])
        .arg(bundle)
        .output()?;
    if !output.status.success() {
        return Err(Refusal::NotTheUpdate(format!(
            "the running app's signature: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    // codesign describes a signature on stderr.
    Ok(team_in(&String::from_utf8_lossy(&output.stderr)).map(str::to_owned))
}

fn team_in(description: &str) -> Option<&str> {
    description
        .lines()
        .find_map(|line| line.strip_prefix("TeamIdentifier="))
        .filter(|team| *team != "not set")
}

/// Puts the app in `zip` in the place of `bundle`, which is version
/// `running`. The zip must hash to `sha256` and hold a strictly newer app.
/// On success the returned bundle path is the new app's, ready to be started.
pub fn install(bundle: &Path, running: &str, zip: &Path, sha256: &str) -> Result<PathBuf, Refusal> {
    if !sha256_of(zip)?.eq_ignore_ascii_case(sha256) {
        return Err(Refusal::WrongDigest);
    }
    let folder = bundle.parent().ok_or(Refusal::NotABundle)?;
    // What an install that was killed left behind. The app runs from its
    // bundle, so none of these holds it.
    for stale in std::fs::read_dir(folder)?.filter_map(Result::ok) {
        if stale.file_name().to_string_lossy().starts_with(STAGING) {
            let _ = std::fs::remove_dir_all(stale.path());
        }
    }
    // On the same volume as the bundle, so the swap is two renames.
    let staging = folder.join(format!("{STAGING}{}", std::process::id()));
    if let Err(error) = std::fs::create_dir(&staging) {
        return Err(match error.kind() {
            std::io::ErrorKind::PermissionDenied => Refusal::NotWritable(folder.to_path_buf()),
            _ => Refusal::Io(error),
        });
    }
    let installed = swap(bundle, running, zip, &staging);
    // The old bundle, or whatever a refusal left, goes with it; but never
    // the app itself, which a swap that could not be undone left in there.
    if !matches!(installed, Err(Refusal::Stranded(_))) {
        let _ = std::fs::remove_dir_all(&staging);
    }
    installed.map(|()| bundle.to_path_buf())
}

fn swap(bundle: &Path, running: &str, zip: &Path, staging: &Path) -> Result<(), Refusal> {
    let unpacked = staging.join("new");
    tool(
        "/usr/bin/ditto",
        &[
            "-x".as_ref(),
            "-k".as_ref(),
            zip.as_os_str(),
            unpacked.as_os_str(),
        ],
    )?;
    let name = bundle.file_name().ok_or(Refusal::NotABundle)?;
    // A release zips the bundle under its own name, whatever the learner
    // called their copy.
    let new = std::fs::read_dir(&unpacked)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|ext| ext == "app"))
        .ok_or_else(|| Refusal::NotTheUpdate("the zip holds no app".to_owned()))?;
    // Intact as a bundle: every file is what its signature sealed.
    tool(
        "/usr/bin/codesign",
        &[
            "--verify".as_ref(),
            "--strict".as_ref(),
            "--deep".as_ref(),
            new.as_os_str(),
        ],
    )?;
    // From the same team as the running app, once that one has a team: a
    // signature alone holds for whoever made it.
    if let Some(team) = team_of(bundle)? {
        let requirement =
            format!("-R=anchor apple generic and certificate leaf[subject.OU] = \"{team}\"");
        tool(
            "/usr/bin/codesign",
            &[
                "--verify".as_ref(),
                "--strict".as_ref(),
                requirement.as_ref(),
                new.as_os_str(),
            ],
        )?;
    }
    let program = std::env::current_exe()?
        .file_name()
        .map(|program| new.join("Contents").join("MacOS").join(program))
        .ok_or(Refusal::NotABundle)?;
    let reported = tool(&program.to_string_lossy(), &["--version".as_ref()])?;
    let offered = reported.strip_prefix("jumper ").and_then(version);
    match (offered, version(running)) {
        (Some(offered), Some(running)) if offered > running => {}
        _ => {
            return Err(Refusal::NotTheUpdate(format!(
                "it is `{reported}`, and version {running} is running"
            )));
        }
    }
    exchange(bundle, &new, &staging.join(name))
}

/// Moves `bundle` to `old` and `new` into its place. A failure leaves the
/// app where it was, or says where it is.
fn exchange(bundle: &Path, new: &Path, old: &Path) -> Result<(), Refusal> {
    let refused = |error: std::io::Error| match (error.kind(), bundle.parent()) {
        (std::io::ErrorKind::PermissionDenied, Some(folder)) => {
            Refusal::NotWritable(folder.to_path_buf())
        }
        _ => Refusal::Io(error),
    };
    std::fs::rename(bundle, old).map_err(refused)?;
    if let Err(error) = std::fs::rename(new, bundle) {
        // Put the running app back where it was.
        return Err(match std::fs::rename(old, bundle) {
            Ok(()) => refused(error),
            Err(_) => Refusal::Stranded(old.to_path_buf()),
        });
    }
    Ok(())
}

/// Starts the app at `bundle` as a new instance; the caller then quits.
pub fn start(bundle: &Path) -> std::io::Result<()> {
    Command::new("/usr/bin/open")
        .arg("-n")
        .arg(bundle)
        .spawn()
        .map(drop)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::path::Path;

    use subspace::contract::AppReleaseV1;

    use super::{Offer, Refusal, bundle_of, exchange, team_in, version};

    #[test]
    fn a_swap_that_fails_leaves_the_app_where_it_was() {
        let folder = tempfile::tempdir().unwrap();
        let bundle = folder.path().join("Intar.app");
        let staging = folder.path().join(".intar-update-1");
        let (new, old) = (staging.join("new.app"), staging.join("Intar.app"));
        let mark = |at: &Path, text: &str| {
            std::fs::create_dir_all(at).unwrap();
            std::fs::write(at.join("version"), text).unwrap();
        };
        let version_at = |at: &Path| std::fs::read_to_string(at.join("version")).unwrap();

        // The two change places.
        mark(&bundle, "old");
        mark(&new, "new");
        exchange(&bundle, &new, &old).unwrap();
        assert_eq!(version_at(&bundle), "new");
        assert_eq!(version_at(&old), "old");

        // No new bundle to move in: the app is back where it was.
        std::fs::remove_dir_all(&old).unwrap();
        assert!(matches!(exchange(&bundle, &new, &old), Err(Refusal::Io(_))));
        assert_eq!(version_at(&bundle), "new");
        assert!(!old.exists());
    }

    #[test]
    fn offers_only_a_strictly_newer_release_over_https() {
        let release = |version: &str, url: &str| AppReleaseV1 {
            version: version.to_owned(),
            sha256: "ab".repeat(32),
            url: url.to_owned(),
        };
        // Against the app's own releases, whatever this test's environment names.
        let offer = |release, running| Offer::from(release, running, super::RELEASES);
        let zip = "https://github.com/intar-dev/intar-dev/releases/download/desktop%2Fv0.2.0/intar-desktop_0.2.0_macos_arm64.zip";
        assert_eq!(
            offer(release("0.2.0", zip), "0.1.9").map(|offer| offer.version),
            Some("0.2.0".to_owned())
        );
        // The same, an older one, and what is no version.
        for (offered, running) in [("0.2.0", "0.2.0"), ("0.1.9", "0.2.0"), ("next", "0.1.0")] {
            assert_eq!(offer(release(offered, zip), running), None);
        }
        // Anywhere but the app's own releases, however the URL is dressed.
        for url in [
            "http://github.com/intar-dev/intar-dev/releases/download/desktop%2Fv0.2.0/app.zip",
            "https://example.test/app.zip",
            "https://github.com/someone-else/intar-dev/releases/download/desktop%2Fv0.2.0/app.zip",
            "https://github.com.example.test/intar-dev/intar-dev/releases/download/app.zip",
            "app.zip",
        ] {
            assert_eq!(offer(release("0.2.0", url), "0.1.0"), None, "{url}");
        }
    }

    #[test]
    fn finds_the_bundle_a_program_runs_from_and_refuses_what_is_none() {
        assert_eq!(
            bundle_of(Path::new("/Applications/Intar.app/Contents/MacOS/jumper")).unwrap(),
            Path::new("/Applications/Intar.app")
        );
        // A development build, and a program that only looks like one.
        for program in [
            "/work/target/debug/jumper",
            "/Applications/Intar.app/Contents/Helpers/jumper",
            "/Applications/Intar/Contents/MacOS/jumper",
        ] {
            assert!(matches!(
                bundle_of(Path::new(program)),
                Err(Refusal::NotABundle)
            ));
        }
        // A downloaded app that was opened without being moved.
        assert!(matches!(
            bundle_of(Path::new(
                "/private/var/folders/ab/T/AppTranslocation/1F2E/d/Intar.app/Contents/MacOS/jumper"
            )),
            Err(Refusal::Translocated)
        ));
    }

    #[test]
    fn reads_the_signing_team_and_none_for_an_ad_hoc_signature() {
        let signed = "Identifier=dev.intar.jumper\nAuthority=Developer ID Application: A (AB12CD34EF)\nTeamIdentifier=AB12CD34EF\n";
        assert_eq!(team_in(signed), Some("AB12CD34EF"));
        assert_eq!(team_in("Signature=adhoc\nTeamIdentifier=not set\n"), None);
        assert_eq!(team_in("Signature=adhoc\n"), None);
    }

    #[test]
    fn reads_three_numbers_as_a_version_and_orders_them_as_numbers() {
        assert_eq!(version("0.10.2"), Some((0, 10, 2)));
        assert!(version("0.10.0") > version("0.9.9"));
        for text in ["", "1.2", "1.2.3.4", "1.2.x", "v1.2.3", "1.2.3-rc1"] {
            assert_eq!(version(text), None, "{text}");
        }
    }

    #[tokio::test]
    async fn downloads_the_offer_and_install_refuses_what_does_not_hash_to_it() {
        let app = axum::Router::new().route(
            "/app.zip",
            axum::routing::get(|| async { b"not the published zip".to_vec() }),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        let offer = Offer {
            version: "0.2.0".to_owned(),
            sha256: "ab".repeat(32),
            url: format!("http://{address}/app.zip").parse().unwrap(),
        };
        let folder = tempfile::tempdir().unwrap();
        let zip = folder.path().join("cache").join("update.zip");
        offer.download(&reqwest::Client::new(), &zip).await.unwrap();
        assert_eq!(std::fs::read(&zip).unwrap(), b"not the published zip");

        // The hash is checked before anything is unpacked or moved.
        let bundle = folder.path().join("Intar.app");
        std::fs::create_dir(&bundle).unwrap();
        assert!(matches!(
            super::install(&bundle, "0.1.0", &zip, &offer.sha256),
            Err(Refusal::WrongDigest)
        ));
        assert!(bundle.is_dir());
        assert_eq!(std::fs::read_dir(folder.path()).unwrap().count(), 2);
    }
}
