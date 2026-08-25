use std::sync::Arc;

use dashmap::DashMap;
use russh::{Disconnect, server::Handle};
use stargate_core::SessionKind;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Default)]
pub struct SessionRegistry {
    routes: Arc<DashMap<String, RouteSessions>>,
}

#[derive(Default)]
struct RouteSessions {
    /// Incremented before every route-wide cancellation. A child lease may
    /// only be registered under the generation that admitted its parent.
    generation: u64,
    entries: Vec<SessionEntry>,
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
    generation: u64,
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
        let generation = {
            let mut route = self.routes.entry(username.clone()).or_default();
            let generation = route.generation;
            route.entries.push(entry);
            generation
        };
        SessionLease {
            id,
            username,
            generation,
            registry: self.clone(),
            token,
        }
    }

    fn register_child(
        &self,
        parent: &SessionLease,
        kind: SessionKind,
        ssh_handle: Option<Handle>,
    ) -> Option<SessionLease> {
        // Check before and while holding the route entry. The second check
        // closes the gap where a cancellation drains and removes the old
        // route state after the optimistic check.
        if parent.token.is_cancelled() {
            return None;
        }

        let id = Uuid::new_v4();
        let token = CancellationToken::new();
        let entry = SessionEntry {
            id,
            kind,
            token: token.clone(),
            ssh_handle,
        };
        let mut route = self.routes.entry(parent.username.clone()).or_default();
        if parent.token.is_cancelled() || route.generation != parent.generation {
            return None;
        }
        route.entries.push(entry);

        Some(SessionLease {
            id,
            username: parent.username.clone(),
            generation: parent.generation,
            registry: self.clone(),
            token,
        })
    }

    pub async fn terminate_username(&self, username: &str) {
        // Advancing the generation and taking every lease happens while the
        // same DashMap entry is locked. A stale connection can therefore not
        // add a bridge after this method has linearized its revocation.
        let removed = {
            let mut route = self.routes.entry(username.to_owned()).or_default();
            route.generation = route.generation.wrapping_add(1);
            let removed = std::mem::take(&mut route.entries);
            // Cancellation is synchronous. Do it before releasing the route
            // entry so an old parent can neither observe its previous token
            // nor recreate an empty entry with the old generation.
            for entry in &removed {
                entry.token.cancel();
            }
            removed
        };
        for entry in removed {
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

    fn unregister(&self, username: &str, id: Uuid) {
        if let Some(mut route) = self.routes.get_mut(username) {
            route.entries.retain(|session| session.id != id);
        }
        // `remove_if` keeps the empty check and removal in one shard lock, so
        // a concurrent registration cannot be dropped from the registry.
        self.routes
            .remove_if(username, |_, route| route.entries.is_empty());
    }
}

impl SessionLease {
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    /// Register a child activity (the authenticated connection or one of its
    /// bridges) only while this admission is still current. If a route was
    /// deleted or replaced after the parent was checked, no child is created.
    pub fn register_child(
        &self,
        kind: SessionKind,
        ssh_handle: Option<Handle>,
    ) -> Option<SessionLease> {
        self.registry.register_child(self, kind, ssh_handle)
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

#[cfg(test)]
mod tests {
    use tokio::sync::oneshot;

    use stargate_core::SessionKind;

    use super::SessionRegistry;

    #[tokio::test]
    async fn revocation_between_connection_check_and_bridge_registration_rejects_bridge() {
        let registry = SessionRegistry::default();
        let connection = registry.register("run-01-web".to_owned(), SessionKind::NativeSsh, None);
        let (checked_tx, checked_rx) = oneshot::channel();
        let (resume_tx, resume_rx) = oneshot::channel();

        let child = tokio::spawn(async move {
            // Model an exec or shell request that passed its connection check
            // immediately before an administrator replaces or deletes route.
            assert!(!connection.token().is_cancelled());
            checked_tx.send(()).expect("test coordinator is available");
            resume_rx.await.expect("test coordinator resumes bridge");
            connection.register_child(SessionKind::NativeSsh, None)
        });

        checked_rx.await.expect("bridge reached the stale check");
        registry.terminate_username("run-01-web").await;
        resume_tx.send(()).expect("bridge task is waiting");

        assert!(
            child.await.expect("bridge task completes").is_none(),
            "a stale connection registered a bridge after route revocation"
        );
    }

    #[test]
    fn unchanged_route_keeps_connection_eligible_for_a_bridge() {
        let registry = SessionRegistry::default();
        let connection = registry.register("run-01-web".to_owned(), SessionKind::NativeSsh, None);

        let bridge = connection.register_child(SessionKind::NativeSsh, None);

        assert!(bridge.is_some());
        assert!(!connection.token().is_cancelled());
    }
}
