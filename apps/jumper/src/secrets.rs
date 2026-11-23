//! The sign-in, kept in the OS keychain and never on disk: the macOS
//! Keychain, the Windows Credential Manager, or the Secret Service on Linux.
//! One entry per intar the app talks to.
//!
//! On macOS a release signed with the Developer ID and its provisioning
//! profile keeps it in the protected (data protection) keychain, in the
//! app's own access group: no prompt, whoever signed the build before. Any
//! other build lacks the entitlement for that store and keeps it in the login
//! keychain, which asks once per signer.

use std::sync::OnceLock;

use subspace::Tokens;
use url::Url;

const SERVICE: &str = "dev.intar.jumper";

/// The platform's store, set once. An error means no keychain is available;
/// the app then keeps the sign-in in memory for this launch.
fn ensure_store() -> Result<(), String> {
    static STORE: OnceLock<Result<(), String>> = OnceLock::new();
    STORE
        .get_or_init(|| {
            #[cfg(target_os = "macos")]
            let store = macos_store();
            #[cfg(target_os = "windows")]
            let store = windows_native_keyring_store::Store::new();
            #[cfg(target_os = "linux")]
            let store = zbus_secret_service_keyring_store::Store::new();
            keyring_core::set_default_store(store.map_err(|error| error.to_string())?);
            Ok(())
        })
        .clone()
}

/// The protected store when this build may use it, else the login keychain.
#[cfg(target_os = "macos")]
fn macos_store() -> keyring_core::Result<std::sync::Arc<keyring_core::CredentialStore>> {
    let protected = apple_native_keyring_store::protected::Store::new()?;
    // Without the keychain-access-groups entitlement the store refuses a
    // delete (errSecMissingEntitlement), while a read only finds nothing. The
    // probe item is never written, so the delete never removes anything.
    let probe = keyring_core::api::CredentialStoreApi::build(
        protected.as_ref(),
        SERVICE,
        "store-probe",
        None,
    )?
    .delete_credential();
    match probe {
        Ok(_) | Err(keyring_core::Error::NoEntry) => Ok(protected),
        Err(_) => Ok(apple_native_keyring_store::keychain::Store::new()?),
    }
}

pub struct Keychain {
    /// The intar's origin, so a local Worker and intar.dev do not share a sign-in.
    user: String,
}

impl Keychain {
    pub fn new(base: &Url) -> Self {
        Self {
            user: base.origin().ascii_serialization(),
        }
    }

    fn entry(&self) -> Result<keyring_core::Entry, String> {
        ensure_store()?;
        keyring_core::Entry::new(SERVICE, &self.user).map_err(|error| error.to_string())
    }

    /// The stored sign-in; `None` when there is none or it cannot be read as one.
    pub fn load(&self) -> Result<Option<Tokens>, String> {
        match self.entry()?.get_password() {
            Ok(raw) => Ok(serde_json::from_str(&raw).ok()),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn save(&self, tokens: &Tokens) -> Result<(), String> {
        let raw = serde_json::to_string(tokens).map_err(|error| error.to_string())?;
        self.entry()?
            .set_password(&raw)
            .map_err(|error| error.to_string())
    }

    pub fn clear(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes to the real keychain, so it runs only when asked:
    /// `cargo test -p jumper -- --ignored`.
    #[test]
    #[ignore = "writes to the OS keychain"]
    fn round_trips_a_sign_in() {
        let keychain = Keychain::new(&Url::parse("http://jumper-test.invalid:1").expect("url"));
        keychain.clear().expect("clear");
        assert_eq!(keychain.load().expect("load"), None);
        let tokens = Tokens {
            access_token: "a".into(),
            refresh_token: Some("r".into()),
            expires_at: 7,
        };
        keychain.save(&tokens).expect("save");
        assert_eq!(keychain.load().expect("load"), Some(tokens));
        keychain.clear().expect("clear");
        keychain.clear().expect("clear again");
        assert_eq!(keychain.load().expect("load"), None);
    }
}
