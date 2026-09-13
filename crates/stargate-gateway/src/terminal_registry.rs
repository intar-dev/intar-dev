use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::watch;
use uuid::Uuid;

/// The attach fan-out for pending terminal routes.
///
/// One entry per route, and one notification channel per group of waiters. A
/// waiter subscribes before it reads the stored route, so an attach that lands
/// between the two steps still wakes it. The entry goes away with its last
/// waiter, so the table can not grow without a bound.
#[derive(Clone, Default)]
pub struct TerminalRouteTargetRegistry {
    routes: Arc<DashMap<String, TargetWatch>>,
}

#[derive(Default)]
struct TargetWatch {
    sender: watch::Sender<u64>,
    waiters: usize,
}

pub struct TargetSubscription {
    registry: TerminalRouteTargetRegistry,
    route_username: String,
    receiver: watch::Receiver<u64>,
}

impl TerminalRouteTargetRegistry {
    pub fn subscribe(&self, route_username: &str) -> TargetSubscription {
        let mut entry = self.routes.entry(route_username.to_owned()).or_default();
        if entry.waiters == 0 {
            // A new group of waiters must not observe the notification of an
            // earlier group that already finished.
            let (sender, _) = watch::channel(0);
            entry.sender = sender;
        }
        entry.waiters += 1;
        let receiver = entry.sender.subscribe();
        drop(entry);
        TargetSubscription {
            registry: self.clone(),
            route_username: route_username.to_owned(),
            receiver,
        }
    }

    pub fn notify(&self, route_username: &str) {
        if let Some(entry) = self.routes.get(route_username) {
            entry
                .sender
                .send_modify(|value| *value = value.wrapping_add(1));
        }
    }

    fn release(&self, route_username: &str) {
        if let Some(mut entry) = self.routes.get_mut(route_username) {
            entry.waiters = entry.waiters.saturating_sub(1);
        }
        self.routes
            .remove_if(route_username, |_, entry| entry.waiters == 0);
    }

    #[cfg(test)]
    fn tracked_routes(&self) -> usize {
        self.routes.len()
    }
}

impl TargetSubscription {
    /// Wait for the next attach notification. A notification that arrives
    /// between `subscribe` and the stored-route read is not lost: the caller
    /// reads the stored route first, and this future resolves immediately when
    /// the value already changed.
    pub async fn changed(&mut self) {
        let _ = self.receiver.changed().await;
    }
}

impl Drop for TargetSubscription {
    fn drop(&mut self) {
        self.registry.release(&self.route_username);
    }
}

/// The set of live browser sockets, keyed by route and generation. One socket
/// per pair, so a second tab can not open a second PTY for one route.
#[derive(Clone, Default)]
pub struct TerminalSocketRegistry {
    sockets: Arc<DashMap<SocketKey, Arc<SocketClaim>>>,
}

type SocketKey = (String, String);

struct SocketClaim {
    id: Uuid,
}

/// One socket's hold on a route generation. The hold is released by identity:
/// a socket that already lost its slot can not evict the socket that took it.
pub struct TerminalSocketClaim {
    registry: TerminalSocketRegistry,
    key: SocketKey,
    id: Uuid,
}

impl TerminalSocketRegistry {
    /// Claim the socket slot. `None` means another socket already holds it.
    pub fn open(&self, route_username: String, generation: String) -> Option<TerminalSocketClaim> {
        let id = Uuid::new_v4();
        let key: SocketKey = (route_username, generation);
        match self.sockets.entry(key.clone()) {
            dashmap::mapref::entry::Entry::Occupied(_) => None,
            dashmap::mapref::entry::Entry::Vacant(entry) => {
                entry.insert(Arc::new(SocketClaim { id }));
                Some(TerminalSocketClaim {
                    registry: self.clone(),
                    key,
                    id,
                })
            }
        }
    }

    fn release(&self, key: &SocketKey, id: Uuid) {
        // Compare and remove under one shard lock. A late release from an old
        // socket must never drop the slot of the socket that replaced it.
        self.sockets.remove_if(key, |_, claim| claim.id == id);
    }

    #[cfg(test)]
    fn live_sockets(&self) -> usize {
        self.sockets.len()
    }
}

impl TerminalSocketClaim {
    pub fn key(&self) -> &SocketKey {
        &self.key
    }
}

impl Drop for TerminalSocketClaim {
    fn drop(&mut self) {
        self.registry.release(&self.key, self.id);
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{TerminalRouteTargetRegistry, TerminalSocketRegistry};

    #[tokio::test]
    async fn only_one_socket_holds_a_route_generation() {
        let registry = TerminalSocketRegistry::default();
        let first = registry
            .open("run-01-web".to_owned(), "exec-01:7".to_owned())
            .expect("the first socket claims the route generation");
        assert_eq!(registry.live_sockets(), 1);
        assert!(
            registry
                .open("run-01-web".to_owned(), "exec-01:7".to_owned())
                .is_none(),
            "a duplicate socket for the same generation must be refused"
        );
        assert_eq!(registry.live_sockets(), 1);
        let other_generation = registry
            .open("run-01-web".to_owned(), "exec-01:8".to_owned())
            .expect("a new generation accepts a socket");
        assert_eq!(registry.live_sockets(), 2);

        drop(first);
        drop(other_generation);
        assert_eq!(registry.live_sockets(), 0);
    }

    #[tokio::test]
    async fn a_stale_socket_can_not_evict_the_socket_that_replaced_it() {
        let registry = TerminalSocketRegistry::default();
        let key = ("run-01-web".to_owned(), "exec-01:7".to_owned());
        let stale = registry
            .open(key.0.clone(), key.1.clone())
            .expect("first claim");
        let stale_id = stale.id;
        // The socket closes before its replacement claims the slot.
        drop(stale);
        let replacement = registry
            .open(key.0.clone(), key.1.clone())
            .expect("replacement claim");

        // A late release from the old socket must not touch the replacement.
        registry.release(&key, stale_id);
        assert_eq!(registry.live_sockets(), 1, "the replacement keeps its slot");
        assert!(replacement.key().0 == "run-01-web");
        drop(replacement);
        assert_eq!(registry.live_sockets(), 0);
    }

    #[tokio::test]
    async fn every_live_waiter_is_woken_by_the_attach_notification() {
        let registry = TerminalRouteTargetRegistry::default();
        let mut waiting = registry.subscribe("run-01-web");
        let mut second = registry.subscribe("run-01-web");

        registry.notify("run-01-web");

        for waiter in [&mut waiting, &mut second] {
            assert!(
                tokio::time::timeout(Duration::from_millis(50), waiter.changed())
                    .await
                    .is_ok(),
                "every live waiter must wake on the attach"
            );
        }
    }

    #[tokio::test]
    async fn a_waiter_that_arrives_after_the_last_group_starts_clean() {
        let registry = TerminalRouteTargetRegistry::default();
        drop(registry.subscribe("run-01-web"));
        let mut late = registry.subscribe("run-01-web");

        // The notification of the finished group must not resolve the new
        // group. The socket reads the stored route, so that notification is
        // not needed for correctness either way.
        assert!(
            tokio::time::timeout(Duration::from_millis(50), late.changed())
                .await
                .is_err()
        );
        registry.notify("run-01-web");
        assert!(
            tokio::time::timeout(Duration::from_millis(50), late.changed())
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn the_waiter_table_empties_when_the_last_waiter_leaves() {
        let registry = TerminalRouteTargetRegistry::default();
        let first = registry.subscribe("run-01-web");
        let second = registry.subscribe("run-01-web");
        assert_eq!(registry.tracked_routes(), 1);

        drop(first);
        assert_eq!(registry.tracked_routes(), 1);
        drop(second);
        assert_eq!(registry.tracked_routes(), 0);
    }
}
