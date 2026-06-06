use std::sync::Arc;

use dashmap::DashMap;
use russh::{Disconnect, server::Handle};
use stargate_core::SessionKind;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Default)]
pub struct SessionRegistry {
    entries: Arc<DashMap<String, Vec<SessionEntry>>>,
}

#[derive(Clone)]
struct SessionEntry {
    id: Uuid,
    kind: SessionKind,
    token: CancellationToken,
    ssh_handle: Option<Handle>,
}

pub struct SessionLease {
    id: Uuid,
    username: String,
    registry: SessionRegistry,
    token: CancellationToken,
}

impl SessionRegistry {
    pub fn register(
        &self,
        username: String,
        kind: SessionKind,
        ssh_handle: Option<Handle>,
    ) -> SessionLease {
        let id = Uuid::new_v4();
        let token = CancellationToken::new();
        let entry = SessionEntry {
            id,
            kind,
            token: token.clone(),
            ssh_handle,
        };
        self.entries
            .entry(username.clone())
            .or_default()
            .push(entry);
        SessionLease {
            id,
            username,
            registry: self.clone(),
            token,
        }
    }

    pub async fn terminate_username(&self, username: &str) {
        let removed = self.entries.remove(username).map(|(_, entries)| entries);
        if let Some(entries) = removed {
            for entry in entries {
                entry.token.cancel();
                let _ = entry.kind;
                if let Some(handle) = entry.ssh_handle {
                    tokio::spawn(async move {
                        let _ = handle
                            .disconnect(
                                Disconnect::ByApplication,
                                "route deleted".to_owned(),
                                "en-US".to_owned(),
                            )
                            .await;
                    });
                }
            }
        }
    }

    fn unregister(&self, username: &str, id: Uuid) {
        if let Some(mut entry) = self.entries.get_mut(username) {
            entry.retain(|session| session.id != id);
            if entry.is_empty() {
                drop(entry);
                self.entries.remove(username);
            }
        }
    }
}

impl SessionLease {
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    pub fn terminate(&self) {
        self.token.cancel();
    }
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        self.registry.unregister(&self.username, self.id);
    }
}
