use std::collections::BTreeSet;

use intar_contracts::stargate::{
    ActivateTerminalTargetRequest, GENERATION_MAX_LEN, IssueTerminalSessionRequest, RouteMetadata,
    StageTerminalTargetRequest, TerminalSessionMode, TerminalTarget, TerminalTargetState,
    validate_route_username,
};
use russh::keys::ssh_key::{Algorithm, PublicKey};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use crate::{Result, StargateError};

const TARGET_USERNAME_MAX_LEN: usize = 64;
const METADATA_ID_MAX_LEN: usize = 128;
const ATTACHMENT_ID_MAX_LEN: usize = 128;
/// The public lifetime of one terminal route.
pub const ROUTE_TTL: Duration = Duration::hours(4);
/// A create call can not outlive the route TTL. The allowance absorbs clock
/// skew between the control plane and the gateway.
const ROUTE_TTL_SKEW: Duration = Duration::minutes(1);

/// One terminal route as the gateway holds it. The target is a typed state:
/// either the route has no target yet, or it has exactly one complete target.
/// There is no representation with a partly filled target, and a pending route
/// holds no guest address and no guest key at all.
/// The target of one terminal route, as the gateway holds it. A staged target
/// is validated and stored but is NOT authorization: `ready_target` returns
/// nothing for it, so no socket dials the guest and no SSH bridge starts. Only
/// `Active` reaches the guest network.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum StoredTarget {
    /// The route has no target. A pending browser route starts here.
    Missing,
    /// Staged by the control plane and waiting for activation.
    Staged {
        attachment_id: String,
        target: TerminalTarget,
    },
    /// Active. The PTY may open and the recording may start.
    Active {
        attachment_id: String,
        target: TerminalTarget,
    },
}

impl StoredTarget {
    pub fn attachment_id(&self) -> Option<&str> {
        match self {
            Self::Missing => None,
            Self::Staged { attachment_id, .. } | Self::Active { attachment_id, .. } => {
                Some(attachment_id)
            }
        }
    }

    pub fn staged(&self) -> Option<(&str, &TerminalTarget)> {
        match self {
            Self::Staged {
                attachment_id,
                target,
            } => Some((attachment_id, target)),
            _ => None,
        }
    }

    /// The target, only when the route is active. Every dial path calls this,
    /// so a staged target can not reach the guest.
    pub fn active(&self) -> Option<&TerminalTarget> {
        match self {
            Self::Active { target, .. } => Some(target),
            _ => None,
        }
    }

    /// Whether the two states give the same authorization: the same target
    /// data, in the same readiness class. The attachment identifier is route
    /// bookkeeping, and a fresh identifier over the same active target must
    /// not revoke a live session.
    pub fn same_authorization(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Missing, Self::Missing) => true,
            (
                Self::Staged {
                    target: previous, ..
                },
                Self::Staged {
                    target: current, ..
                },
            )
            | (
                Self::Active {
                    target: previous, ..
                },
                Self::Active {
                    target: current, ..
                },
            ) => previous == current,
            _ => false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StoredTerminalRoute {
    pub route_username: String,
    pub generation: String,
    #[serde(with = "time::serde::timestamp")]
    pub expires_at: OffsetDateTime,
    pub mode: TerminalSessionMode,
    pub metadata: RouteMetadata,
    pub target: StoredTarget,
    #[serde(with = "time::serde::timestamp")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::timestamp")]
    pub updated_at: OffsetDateTime,
}

impl StoredTerminalRoute {
    pub fn ready_target(&self) -> Option<&TerminalTarget> {
        self.target.active()
    }

    pub fn is_expired_at(&self, now: OffsetDateTime) -> bool {
        self.expires_at <= now
    }

    /// Check the identity that an attach call repeats. Every value must match
    /// the stored route exactly. An empty or different value can not attach.
    pub fn matches_attach_identity(
        &self,
        run_id: &str,
        vm_id: &str,
        user_id: &str,
        generation: &str,
    ) -> bool {
        self.metadata.run_id == run_id
            && self.metadata.vm_id == vm_id
            && self.metadata.user_id == user_id
            && self.generation == generation
    }
}

/// Validate one create call. The gateway reads only this value, so a browser
/// route can not receive a target from the create call.
pub fn validate_terminal_session_request(
    request: IssueTerminalSessionRequest,
) -> Result<StoredTerminalRoute> {
    validate_route_username(&request.route_username).map_err(StargateError::Validation)?;
    validate_generation(&request.generation)?;
    validate_metadata(&request.metadata)?;
    let expires_at = validate_route_expiry(request.route_expires_at)?;
    let target = match (request.mode, request.target) {
        (TerminalSessionMode::Browser, TerminalTargetState::Pending) => StoredTarget::Missing,
        (TerminalSessionMode::Browser, TerminalTargetState::Ready(_)) => {
            return Err(StargateError::Validation(
                "a browser terminal route starts with state pending".to_owned(),
            ));
        }
        (TerminalSessionMode::Native, TerminalTargetState::Ready(target)) => {
            let target = validate_target(*target)?;
            if let crate::SshTargetTransport::Relay { target: relay } = &target.transport {
                validate_relay_route(
                    relay,
                    &request.metadata.vm_id,
                    &request.metadata.user_id,
                    &request.generation,
                )?;
                if relay.host.host_id != request.metadata.host_id {
                    return Err(StargateError::Validation(
                        "relay host does not match route".into(),
                    ));
                }
            }
            if target.authorized_client_public_keys_openssh.is_empty() {
                return Err(StargateError::Validation(
                    "authorized_client_public_keys_openssh must not be empty for native sessions"
                        .to_owned(),
                ));
            }
            // A native route is ready at creation: its create call already
            // follows the control plane admission.
            StoredTarget::Active {
                attachment_id: new_attachment_id(),
                target,
            }
        }
        (TerminalSessionMode::Native, TerminalTargetState::Pending) => {
            return Err(StargateError::Validation(
                "a native terminal route needs a ready target".to_owned(),
            ));
        }
    };

    let now = OffsetDateTime::now_utc();
    Ok(StoredTerminalRoute {
        route_username: request.route_username,
        generation: request.generation,
        expires_at,
        mode: request.mode,
        metadata: request.metadata,
        target,
        created_at: now,
        updated_at: now,
    })
}

/// Validate one stage call. The target is complete, or the call is rejected: a
/// pending route can not be staged with an empty or partial target.
pub fn validate_stage_request(request: StageTerminalTargetRequest) -> Result<TerminalTarget> {
    validate_generation(&request.generation)?;
    validate_metadata_id(&request.run_id, "run_id")?;
    validate_metadata_id(&request.vm_id, "vm_id")?;
    validate_metadata_id(&request.user_id, "user_id")?;
    if let crate::SshTargetTransport::Relay { target: relay } = &request.target.transport {
        validate_relay_route(relay, &request.vm_id, &request.user_id, &request.generation)?;
    }
    validate_target(request.target)
}
fn validate_relay_route(
    target: &crate::relay::RelayTarget,
    vm: &str,
    user: &str,
    generation: &str,
) -> Result<()> {
    if target.vm_id != vm
        || target.owner_id != user
        || format!("{}:{}", target.execution_id, target.execution_generation) != generation
    {
        return Err(StargateError::Validation(
            "relay assignment does not match route".into(),
        ));
    }
    Ok(())
}

/// Validate one activation call. Every field is required: an absent or empty
/// value is a validation error, never a match.
pub fn validate_activate_request(request: ActivateTerminalTargetRequest) -> Result<()> {
    validate_generation(&request.generation)?;
    validate_metadata_id(&request.run_id, "run_id")?;
    validate_metadata_id(&request.vm_id, "vm_id")?;
    validate_metadata_id(&request.user_id, "user_id")?;
    validate_attachment_id(&request.attachment_id)
}

fn validate_attachment_id(attachment_id: &str) -> Result<()> {
    if attachment_id.is_empty() || attachment_id.len() > ATTACHMENT_ID_MAX_LEN {
        return Err(StargateError::Validation(format!(
            "attachment_id must be 1..={ATTACHMENT_ID_MAX_LEN} characters"
        )));
    }
    Ok(())
}

pub fn new_attachment_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn validate_generation(generation: &str) -> Result<()> {
    if generation.is_empty() || generation.len() > GENERATION_MAX_LEN {
        return Err(StargateError::Validation(format!(
            "generation must be 1..={GENERATION_MAX_LEN} characters"
        )));
    }
    Ok(())
}

fn validate_metadata(metadata: &RouteMetadata) -> Result<()> {
    validate_metadata_id(&metadata.host_id, "host_id")?;
    validate_metadata_id(&metadata.run_id, "run_id")?;
    validate_metadata_id(&metadata.vm_id, "vm_id")?;
    validate_metadata_id(&metadata.user_id, "user_id")
}

fn validate_metadata_id(value: &str, field: &str) -> Result<()> {
    if value.is_empty() || value.len() > METADATA_ID_MAX_LEN {
        return Err(StargateError::Validation(format!(
            "metadata.{field} must be 1..={METADATA_ID_MAX_LEN} characters"
        )));
    }
    Ok(())
}

fn validate_route_expiry(raw: i64) -> Result<OffsetDateTime> {
    let value = OffsetDateTime::from_unix_timestamp(raw).map_err(|_| {
        StargateError::Validation("route_expires_at must be a valid Unix timestamp".to_owned())
    })?;
    let now = OffsetDateTime::now_utc();
    if value <= now {
        return Err(StargateError::Validation(
            "route_expires_at must be in the future".to_owned(),
        ));
    }
    if value > now + ROUTE_TTL + ROUTE_TTL_SKEW {
        return Err(StargateError::Validation(format!(
            "route_expires_at must be at most {} hours in the future",
            ROUTE_TTL.whole_hours()
        )));
    }
    Ok(value)
}

fn validate_target(target: TerminalTarget) -> Result<TerminalTarget> {
    validate_target_username(&target.username)?;
    target
        .transport
        .validate()
        .map_err(|e| StargateError::Validation(e.to_string()))?;
    let _ = parse_target_host_key(&target.host_key_openssh)?;
    let _ = parse_target_private_key(&target.private_key_openssh)?;
    let authorized_client_public_keys_openssh =
        normalize_authorized_client_public_keys(target.authorized_client_public_keys_openssh)?;

    Ok(TerminalTarget {
        username: target.username,
        transport: target.transport,
        host_key_openssh: target.host_key_openssh,
        private_key_openssh: target.private_key_openssh,
        authorized_client_public_keys_openssh,
    })
}

pub fn validate_target_username(username: &str) -> Result<()> {
    if username.is_empty() || username.len() > TARGET_USERNAME_MAX_LEN {
        return Err(StargateError::Validation(format!(
            "target.username must be 1..={TARGET_USERNAME_MAX_LEN} characters"
        )));
    }
    if !username
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(StargateError::Validation(
            "target.username may only contain ASCII letters, digits, '.', '_' and '-'".to_owned(),
        ));
    }
    Ok(())
}

pub fn parse_target_host_key(value: &str) -> Result<PublicKey> {
    let key = PublicKey::from_openssh(value)
        .map_err(|_| StargateError::Validation("target.host_key_openssh is invalid".to_owned()))?;
    if key.algorithm() != Algorithm::Ed25519 {
        return Err(StargateError::Validation(
            "target.host_key_openssh must use ssh-ed25519".to_owned(),
        ));
    }
    Ok(key)
}

pub fn parse_target_private_key(value: &str) -> Result<russh::keys::PrivateKey> {
    let key = russh::keys::decode_secret_key(value, None).map_err(|_| {
        StargateError::Validation("target.private_key_openssh is invalid".to_owned())
    })?;
    if key.algorithm() != Algorithm::Ed25519 {
        return Err(StargateError::Validation(
            "target.private_key_openssh must use ssh-ed25519".to_owned(),
        ));
    }
    Ok(key)
}

fn normalize_authorized_client_public_keys(values: Vec<String>) -> Result<Vec<String>> {
    let mut normalized = Vec::new();
    let mut seen = BTreeSet::new();

    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed = parse_authorized_client_public_key(trimmed)?;
        let openssh = parsed.to_openssh().map_err(|_| {
            StargateError::Validation(
                "authorized_client_public_keys_openssh contains an invalid key".to_owned(),
            )
        })?;
        if seen.insert(openssh.clone()) {
            normalized.push(openssh);
        }
    }

    Ok(normalized)
}

fn parse_authorized_client_public_key(value: &str) -> Result<PublicKey> {
    let key = PublicKey::from_openssh(value).map_err(|_| {
        StargateError::Validation(
            "authorized_client_public_keys_openssh contains an invalid key".to_owned(),
        )
    })?;
    if !uses_supported_client_key_algorithm(&key) {
        return Err(StargateError::Validation(
            "authorized_client_public_keys_openssh must use ssh-ed25519 or sk-ssh-ed25519@openssh.com"
                .to_owned(),
        ));
    }
    Ok(key)
}

fn uses_supported_client_key_algorithm(key: &PublicKey) -> bool {
    matches!(key.algorithm(), Algorithm::Ed25519 | Algorithm::SkEd25519)
}

pub fn authorized_client_public_keys(target: &TerminalTarget) -> Result<Vec<PublicKey>> {
    target
        .authorized_client_public_keys_openssh
        .iter()
        .map(|value| parse_authorized_client_public_key(value))
        .collect()
}

pub fn allows_client_public_key(target: &TerminalTarget, candidate: &PublicKey) -> Result<bool> {
    if !uses_supported_client_key_algorithm(candidate) {
        return Ok(false);
    }
    // Compare only the key material. PublicKey equality also compares the
    // OpenSSH comment, and profile keys are stored with their comment while
    // the key a client presents over the wire has none, so full value equality
    // would reject a correct client key.
    Ok(authorized_client_public_keys(target)?
        .into_iter()
        .any(|expected| expected.key_data() == candidate.key_data()))
}

#[cfg(test)]
mod tests {
    use intar_contracts::stargate::{
        ActivateTerminalTargetRequest, IssueTerminalSessionRequest, RouteMetadata,
        StageTerminalTargetRequest, TerminalSessionMode, TerminalTarget, TerminalTargetState,
    };
    use russh::keys::ssh_key::Algorithm;
    use time::OffsetDateTime;

    use super::{
        StoredTarget, StoredTerminalRoute, validate_activate_request, validate_stage_request,
        validate_terminal_session_request,
    };

    const ECDSA_CLIENT_KEY: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHwf2HMM5TRXvo2SQJjsNkiDD5KqiiNjrGVv3UUh+mMT5RHxiRtOnlqvjhQtBq0VpmpCV/PwUdhOig4vkbqAcEc= user@example.com";

    #[test]
    fn browser_route_starts_pending_without_target_fields() {
        let route = validate_terminal_session_request(pending_request())
            .expect("a browser route must accept state pending");

        assert!(matches!(route.target, StoredTarget::Missing));
        assert!(route.ready_target().is_none());
        assert_eq!(route.generation, "exec-01:7");
        assert_eq!(route.metadata.run_id, "run-01");
    }

    #[test]
    fn browser_route_rejects_a_ready_target() {
        let (host_key, private_key) = ed25519_target_credentials();
        let mut request = pending_request();
        request.target = TerminalTargetState::Ready(Box::new(target(
            &host_key,
            &private_key,
            vec![client_key_openssh()],
        )));

        assert!(validate_terminal_session_request(request).is_err());
    }

    #[test]
    fn create_accepts_a_ready_target_only_for_native_mode() {
        let (host_key, private_key) = ed25519_target_credentials();
        let mut request = pending_request();
        request.mode = TerminalSessionMode::Native;
        request.target = TerminalTargetState::Ready(Box::new(target(
            &host_key,
            &private_key,
            vec![client_key_openssh()],
        )));
        assert!(validate_terminal_session_request(request).is_ok());

        let mut request = pending_request();
        request.mode = TerminalSessionMode::Native;
        request.target =
            TerminalTargetState::Ready(Box::new(target(&host_key, &private_key, Vec::new())));
        assert!(validate_terminal_session_request(request).is_err());

        let mut request = pending_request();
        request.mode = TerminalSessionMode::Native;
        assert!(validate_terminal_session_request(request).is_err());
    }

    #[test]
    fn pending_route_rejects_empty_metadata_ids() {
        let mutations: [fn(&mut IssueTerminalSessionRequest); 5] = [
            |r| r.metadata.run_id = String::new(),
            |r| r.metadata.vm_id = String::new(),
            |r| r.metadata.user_id = String::new(),
            |r| r.metadata.host_id = String::new(),
            |r| r.generation = String::new(),
        ];
        for mutate in mutations {
            let mut request = pending_request();
            mutate(&mut request);
            assert!(
                validate_terminal_session_request(request).is_err(),
                "an empty identity value must fail closed"
            );
        }
    }

    #[test]
    fn route_expiry_is_capped_at_four_hours() {
        let mut request = pending_request();
        request.route_expires_at =
            (OffsetDateTime::now_utc() + time::Duration::hours(4)).unix_timestamp();
        assert!(validate_terminal_session_request(request).is_ok());

        let mut request = pending_request();
        request.route_expires_at =
            (OffsetDateTime::now_utc() + time::Duration::hours(5)).unix_timestamp();
        assert!(validate_terminal_session_request(request).is_err());
    }

    #[test]
    fn target_must_name_a_literal_ip_and_an_ed25519_key() {
        let (host_key, private_key) = ed25519_target_credentials();
        let mut request = pending_request();
        request.mode = TerminalSessionMode::Native;
        let mut target = target(&host_key, &private_key, vec![client_key_openssh()]);
        target.transport = crate::SshTargetTransport::Direct {
            host: "worker.example.test".to_owned(),
            port: 22,
        };
        request.target = TerminalTargetState::Ready(Box::new(target));
        assert!(validate_terminal_session_request(request).is_err());
    }

    #[test]
    fn stage_requires_a_complete_target() {
        let (host_key, private_key) = ed25519_target_credentials();

        assert!(
            validate_stage_request(stage(target(
                &host_key,
                &private_key,
                vec![client_key_openssh()],
            )))
            .is_ok()
        );
        assert!(
            validate_stage_request(StageTerminalTargetRequest {
                generation: String::new(),
                ..stage(target(&host_key, &private_key, vec![client_key_openssh()]))
            })
            .is_err()
        );
        // A browser route needs no client SSH key: the browser never presents
        // one, and the gateway reaches the guest with its own key. The route
        // still denies every public SSH key while the list is empty.
        assert!(validate_stage_request(stage(target(&host_key, &private_key, Vec::new()))).is_ok());
        let mut bad_host_key = target(&host_key, &private_key, Vec::new());
        bad_host_key.host_key_openssh = "ssh-ed25519 not-a-key".to_owned();
        assert!(validate_stage_request(stage(bad_host_key)).is_err());
    }

    #[test]
    fn stage_rejects_an_empty_identity() {
        let (host_key, private_key) = ed25519_target_credentials();
        let ready = || target(&host_key, &private_key, vec![client_key_openssh()]);

        for request in [
            StageTerminalTargetRequest {
                run_id: String::new(),
                ..stage(ready())
            },
            StageTerminalTargetRequest {
                vm_id: String::new(),
                ..stage(ready())
            },
            StageTerminalTargetRequest {
                user_id: String::new(),
                ..stage(ready())
            },
        ] {
            assert!(validate_stage_request(request).is_err());
        }
    }

    #[test]
    fn activate_requires_every_identity_field_and_an_attachment_id() {
        let complete = || ActivateTerminalTargetRequest {
            run_id: "run-01".to_owned(),
            vm_id: "vm-01".to_owned(),
            user_id: "user-01".to_owned(),
            generation: "exec-01:7".to_owned(),
            attachment_id: "attachment-01".to_owned(),
        };
        assert!(validate_activate_request(complete()).is_ok());

        for request in [
            ActivateTerminalTargetRequest {
                run_id: String::new(),
                ..complete()
            },
            ActivateTerminalTargetRequest {
                vm_id: String::new(),
                ..complete()
            },
            ActivateTerminalTargetRequest {
                user_id: String::new(),
                ..complete()
            },
            ActivateTerminalTargetRequest {
                generation: String::new(),
                ..complete()
            },
            ActivateTerminalTargetRequest {
                attachment_id: String::new(),
                ..complete()
            },
        ] {
            assert!(
                validate_activate_request(request).is_err(),
                "an empty activation field must fail closed"
            );
        }
    }

    /// The whole point of the two phases: a staged target is stored and is
    /// still not authorization, so nothing dials the guest before activation.
    #[test]
    fn a_staged_target_is_not_a_ready_target() {
        let (host_key, private_key) = ed25519_target_credentials();
        let target = target(&host_key, &private_key, vec![client_key_openssh()]);
        let route = stored_route(
            StoredTarget::Staged {
                attachment_id: "attachment-01".to_owned(),
                target: target.clone(),
            },
            &private_key,
        );

        assert!(
            route.ready_target().is_none(),
            "a staged target must not be served as ready"
        );
        assert_eq!(route.target.attachment_id(), Some("attachment-01"));
        assert!(route.target.staged().is_some());

        let active = stored_route(
            StoredTarget::Active {
                attachment_id: "attachment-01".to_owned(),
                target,
            },
            &private_key,
        );
        assert!(active.ready_target().is_some());
        // Readiness is part of the comparison, so a route that moves between
        // the two states is a change. Replacing a staged target with an active
        // one is a new authorization, and the conservative answer is the safe
        // one. Only an identical active-to-active reissue keeps its sessions.
        assert!(!route.target.same_authorization(&active.target));
        assert!(active.target.same_authorization(&active.target));
    }

    #[test]
    fn stored_route_rejects_legacy_client_keys() {
        let (host_key, private_key) = ed25519_target_credentials();
        let mut target = target(&host_key, &private_key, Vec::new());
        target.authorized_client_public_keys_openssh = vec![ECDSA_CLIENT_KEY.to_owned()];
        let route = stored_route(
            StoredTarget::Active {
                attachment_id: "attachment-01".to_owned(),
                target,
            },
            &private_key,
        );
        let legacy_key =
            russh::keys::ssh_key::PublicKey::from_openssh(ECDSA_CLIENT_KEY).expect("legacy key");

        let target = route.ready_target().expect("stored target");
        assert!(super::authorized_client_public_keys(target).is_err());
        assert!(
            !super::allows_client_public_key(target, &legacy_key)
                .expect("legacy presented key must fail closed")
        );
    }

    #[test]
    fn attach_identity_matches_only_the_exact_route_identity() {
        let route = validate_terminal_session_request(pending_request()).expect("pending route");

        assert!(route.matches_attach_identity("run-01", "vm-01", "user-01", "exec-01:7"));
        assert!(!route.matches_attach_identity("run-02", "vm-01", "user-01", "exec-01:7"));
        assert!(!route.matches_attach_identity("run-01", "vm-02", "user-01", "exec-01:7"));
        assert!(!route.matches_attach_identity("run-01", "vm-01", "user-02", "exec-01:7"));
        assert!(!route.matches_attach_identity("run-01", "vm-01", "user-01", "exec-01:8"));
    }

    fn stored_route(target: StoredTarget, _private_key: &str) -> StoredTerminalRoute {
        StoredTerminalRoute {
            route_username: "run-01-worker".to_owned(),
            generation: "exec-01:7".to_owned(),
            expires_at: OffsetDateTime::now_utc() + time::Duration::hours(1),
            mode: TerminalSessionMode::Browser,
            metadata: metadata(),
            target,
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
        }
    }

    fn stage(target: TerminalTarget) -> StageTerminalTargetRequest {
        StageTerminalTargetRequest {
            run_id: "run-01".to_owned(),
            vm_id: "vm-01".to_owned(),
            user_id: "user-01".to_owned(),
            generation: "exec-01:7".to_owned(),
            target,
        }
    }

    fn client_key_openssh() -> String {
        let mut rng = russh::keys::key::safe_rng();
        russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519)
            .expect("client key")
            .public_key()
            .to_openssh()
            .expect("client key openssh")
    }

    fn target(
        host_key_openssh: &str,
        private_key_openssh: &str,
        authorized_client_public_keys_openssh: Vec<String>,
    ) -> TerminalTarget {
        TerminalTarget {
            username: "ubuntu".to_owned(),
            transport: crate::SshTargetTransport::Direct {
                host: "127.0.0.1".to_owned(),
                port: 22,
            },
            host_key_openssh: host_key_openssh.to_owned(),
            private_key_openssh: private_key_openssh.to_owned(),
            authorized_client_public_keys_openssh,
        }
    }

    fn ed25519_target_credentials() -> (String, String) {
        let mut rng = russh::keys::key::safe_rng();
        let target_host_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("host key");
        let target_private_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("target key");
        (
            target_host_key.public_key().to_openssh().expect("host key"),
            target_private_key
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .expect("private key")
                .to_string(),
        )
    }

    fn metadata() -> RouteMetadata {
        RouteMetadata {
            host_id: "host-01".to_owned(),
            run_id: "run-01".to_owned(),
            vm_id: "vm-01".to_owned(),
            user_id: "user-01".to_owned(),
        }
    }

    fn pending_request() -> IssueTerminalSessionRequest {
        IssueTerminalSessionRequest {
            route_username: "run-01-worker".to_owned(),
            generation: "exec-01:7".to_owned(),
            target: TerminalTargetState::Pending,
            route_expires_at: (OffsetDateTime::now_utc() + time::Duration::hours(1))
                .unix_timestamp(),
            mode: TerminalSessionMode::Browser,
            metadata: metadata(),
        }
    }
}
