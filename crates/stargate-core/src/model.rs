use std::collections::BTreeSet;

use intar_contracts::stargate::{
    IssueTerminalSessionRequest, IssueWorkspaceAppSessionRequest, RouteMetadata,
    TerminalSessionMode, WorkspaceAppProtocol,
};
use russh::keys::ssh_key::{Algorithm, PublicKey};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{Result, StargateError};

const ROUTE_USERNAME_MAX_LEN: usize = 128;
const TARGET_USERNAME_MAX_LEN: usize = 64;
const WORKSPACE_APP_ROUTE_ID_MAX_LEN: usize = 63;
const WORKSPACE_APP_UPSTREAM_HOST_MAX_LEN: usize = 253;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RegisteredRoute {
    pub route_username: String,
    pub target_username: String,
    pub target_ip: String,
    pub target_port: u16,
    pub authorized_client_public_keys_openssh: Vec<String>,
    pub target_host_key_openssh: String,
    pub target_private_key_openssh: String,
    #[serde(with = "time::serde::timestamp")]
    pub expires_at: OffsetDateTime,
    pub metadata: RouteMetadata,
}

#[derive(Clone, Debug, Serialize)]
pub struct RouteRecord {
    pub route_username: String,
    pub target_username: String,
    pub target_ip: String,
    pub target_port: u16,
    pub authorized_client_public_keys_openssh: Vec<String>,
    pub target_host_key_openssh: String,
    pub target_private_key_openssh: String,
    #[serde(with = "time::serde::timestamp")]
    pub expires_at: OffsetDateTime,
    pub metadata: RouteMetadata,
    #[serde(with = "time::serde::timestamp")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::timestamp")]
    pub updated_at: OffsetDateTime,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RegisteredWorkspaceAppRoute {
    pub route_id: String,
    pub create_only: bool,
    pub target_username: String,
    pub target_ip: String,
    pub target_ssh_port: u16,
    pub target_host_key_openssh: String,
    pub target_private_key_openssh: String,
    pub target_app_port: u16,
    pub protocol: WorkspaceAppProtocol,
    pub upstream_host: Option<String>,
    #[serde(with = "time::serde::timestamp")]
    pub expires_at: OffsetDateTime,
    pub metadata: RouteMetadata,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceAppRouteRecord {
    pub route_id: String,
    pub target_username: String,
    pub target_ip: String,
    pub target_ssh_port: u16,
    pub target_host_key_openssh: String,
    pub target_private_key_openssh: String,
    pub target_app_port: u16,
    pub protocol: WorkspaceAppProtocol,
    pub upstream_host: Option<String>,
    #[serde(with = "time::serde::timestamp")]
    pub expires_at: OffsetDateTime,
    pub metadata: RouteMetadata,
    #[serde(with = "time::serde::timestamp")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::timestamp")]
    pub updated_at: OffsetDateTime,
}

pub fn validate_terminal_session_request(
    request: IssueTerminalSessionRequest,
) -> Result<(RegisteredRoute, TerminalSessionMode)> {
    validate_route_username(&request.route_username)?;
    validate_target_username(&request.target_username)?;
    if request.target_port == 0 {
        return Err(StargateError::Validation(
            "target_port must be between 1 and 65535".to_owned(),
        ));
    }
    let _ = request
        .target_ip
        .parse::<std::net::IpAddr>()
        .map_err(|_| StargateError::Validation("target_ip must be a literal IP".to_owned()))?;
    let route_expires_at =
        OffsetDateTime::from_unix_timestamp(request.route_expires_at).map_err(|_| {
            StargateError::Validation("route_expires_at must be a valid Unix timestamp".to_owned())
        })?;
    if route_expires_at <= OffsetDateTime::now_utc() {
        return Err(StargateError::Validation(
            "route_expires_at must be in the future".to_owned(),
        ));
    }
    validate_target_credentials(
        &request.target_host_key_openssh,
        &request.target_private_key_openssh,
    )?;
    let authorized_client_public_keys_openssh =
        normalize_authorized_client_public_keys(request.authorized_client_public_keys_openssh)?;

    let mode = request.mode;
    if mode == TerminalSessionMode::Browser && !authorized_client_public_keys_openssh.is_empty() {
        return Err(StargateError::Validation(
            "authorized_client_public_keys_openssh must be empty for browser sessions".to_owned(),
        ));
    }
    Ok((
        RegisteredRoute {
            route_username: request.route_username,
            target_username: request.target_username,
            target_ip: request.target_ip,
            target_port: request.target_port,
            authorized_client_public_keys_openssh,
            target_host_key_openssh: request.target_host_key_openssh,
            target_private_key_openssh: request.target_private_key_openssh,
            expires_at: route_expires_at,
            metadata: request.metadata,
        },
        mode,
    ))
}

pub fn validate_workspace_app_session_request(
    request: IssueWorkspaceAppSessionRequest,
) -> Result<RegisteredWorkspaceAppRoute> {
    validate_workspace_app_route_id(&request.route_id)?;
    validate_target_username(&request.target_username)?;
    if request.target_ssh_port == 0 {
        return Err(StargateError::Validation(
            "target_ssh_port must be between 1 and 65535".to_owned(),
        ));
    }
    if request.target_app_port == 0 {
        return Err(StargateError::Validation(
            "target_app_port must be between 1 and 65535".to_owned(),
        ));
    }
    let _ = request
        .target_ip
        .parse::<std::net::IpAddr>()
        .map_err(|_| StargateError::Validation("target_ip must be a literal IP".to_owned()))?;
    let expires_at = validate_future_timestamp(request.route_expires_at)?;
    validate_target_credentials(
        &request.target_host_key_openssh,
        &request.target_private_key_openssh,
    )?;
    if let Some(upstream_host) = request.upstream_host.as_deref() {
        validate_workspace_app_upstream_host(upstream_host)?;
    }

    Ok(RegisteredWorkspaceAppRoute {
        route_id: request.route_id,
        create_only: request.create_only,
        target_username: request.target_username,
        target_ip: request.target_ip,
        target_ssh_port: request.target_ssh_port,
        target_host_key_openssh: request.target_host_key_openssh,
        target_private_key_openssh: request.target_private_key_openssh,
        target_app_port: request.target_app_port,
        protocol: request.protocol,
        upstream_host: request.upstream_host,
        expires_at,
        metadata: request.metadata,
    })
}

fn validate_future_timestamp(raw: i64) -> Result<OffsetDateTime> {
    let value = OffsetDateTime::from_unix_timestamp(raw).map_err(|_| {
        StargateError::Validation("route_expires_at must be a valid Unix timestamp".to_owned())
    })?;
    if value <= OffsetDateTime::now_utc() {
        return Err(StargateError::Validation(
            "route_expires_at must be in the future".to_owned(),
        ));
    }
    Ok(value)
}

fn validate_target_credentials(host_key: &str, private_key: &str) -> Result<()> {
    let _ = parse_target_host_key(host_key)?;
    let _ = parse_target_private_key(private_key)?;
    Ok(())
}

fn parse_target_host_key(value: &str) -> Result<PublicKey> {
    let key = PublicKey::from_openssh(value)
        .map_err(|_| StargateError::Validation("target_host_key_openssh is invalid".to_owned()))?;
    if key.algorithm() != Algorithm::Ed25519 {
        return Err(StargateError::Validation(
            "target_host_key_openssh must use ssh-ed25519".to_owned(),
        ));
    }
    Ok(key)
}

fn parse_target_private_key(value: &str) -> Result<russh::keys::PrivateKey> {
    let key = russh::keys::decode_secret_key(value, None).map_err(|_| {
        StargateError::Validation("target_private_key_openssh is invalid".to_owned())
    })?;
    if key.algorithm() != Algorithm::Ed25519 {
        return Err(StargateError::Validation(
            "target_private_key_openssh must use ssh-ed25519".to_owned(),
        ));
    }
    Ok(key)
}

pub fn validate_workspace_app_route_id(route_id: &str) -> Result<()> {
    if route_id.len() > WORKSPACE_APP_ROUTE_ID_MAX_LEN {
        return Err(StargateError::Validation(format!(
            "route_id must be at most {WORKSPACE_APP_ROUTE_ID_MAX_LEN} characters"
        )));
    }
    let Some(opaque_id) = route_id.strip_prefix("wa-") else {
        return Err(StargateError::Validation(
            "route_id must start with 'wa-'".to_owned(),
        ));
    };
    if opaque_id.is_empty() {
        return Err(StargateError::Validation(
            "route_id must contain a non-empty opaque ID after 'wa-'".to_owned(),
        ));
    }
    let bytes = opaque_id.as_bytes();
    let valid_edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    if !valid_edge(bytes[0])
        || !valid_edge(bytes[bytes.len() - 1])
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
    {
        return Err(StargateError::Validation(
            "route_id suffix must be a lowercase DNS label".to_owned(),
        ));
    }
    Ok(())
}

fn validate_workspace_app_upstream_host(upstream_host: &str) -> Result<()> {
    if upstream_host.is_empty()
        || upstream_host.len() > WORKSPACE_APP_UPSTREAM_HOST_MAX_LEN
        || upstream_host.ends_with('.')
    {
        return Err(StargateError::Validation(
            "upstream_host must be a lowercase DNS hostname without a port".to_owned(),
        ));
    }
    for label in upstream_host.split('.') {
        let bytes = label.as_bytes();
        let valid_edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
        if bytes.is_empty()
            || bytes.len() > 63
            || !valid_edge(bytes[0])
            || !valid_edge(bytes[bytes.len() - 1])
            || bytes.iter().any(|byte| !valid_edge(*byte) && *byte != b'-')
        {
            return Err(StargateError::Validation(
                "upstream_host must be a lowercase DNS hostname without a port".to_owned(),
            ));
        }
    }
    Ok(())
}

impl RouteRecord {
    pub fn authorized_client_public_keys(&self) -> Result<Vec<PublicKey>> {
        self.authorized_client_public_keys_openssh
            .iter()
            .map(|value| parse_authorized_client_public_key(value))
            .collect()
    }

    pub fn allows_client_public_key(&self, candidate: &PublicKey) -> Result<bool> {
        if !uses_supported_client_key_algorithm(candidate) {
            return Ok(false);
        }
        // Compare only the key material. PublicKey equality also compares the
        // OpenSSH comment, and profile keys are stored with their comment
        // while the key a client presents over the wire has none — so
        // full-value equality always rejected a correct client key.
        Ok(self
            .authorized_client_public_keys()?
            .into_iter()
            .any(|expected| expected.key_data() == candidate.key_data()))
    }

    pub fn target_host_key(&self) -> Result<PublicKey> {
        parse_target_host_key(&self.target_host_key_openssh)
    }

    pub fn is_expired_at(&self, now: OffsetDateTime) -> bool {
        self.expires_at <= now
    }
}

impl WorkspaceAppRouteRecord {
    pub fn target_host_key(&self) -> Result<PublicKey> {
        parse_target_host_key(&self.target_host_key_openssh)
    }

    pub fn is_expired_at(&self, now: OffsetDateTime) -> bool {
        self.expires_at <= now
    }
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

pub fn validate_route_username(username: &str) -> Result<()> {
    validate_username(username, ROUTE_USERNAME_MAX_LEN, "route_username")
}

pub fn validate_target_username(username: &str) -> Result<()> {
    validate_username(username, TARGET_USERNAME_MAX_LEN, "target_username")
}

fn validate_username(username: &str, max_len: usize, field: &str) -> Result<()> {
    if username.is_empty() || username.len() > max_len {
        return Err(StargateError::Validation(format!(
            "{field} must be 1..={max_len} characters"
        )));
    }
    let valid = username
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if !valid {
        return Err(StargateError::Validation(format!(
            "{field} may only contain ASCII letters, digits, '.', '_' and '-'"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use intar_contracts::stargate::{
        IssueTerminalSessionRequest, IssueWorkspaceAppSessionRequest, RouteMetadata,
        TerminalSessionMode, WorkspaceAppProtocol,
    };
    use russh::keys::ssh_key::{Algorithm, EcdsaCurve, PublicKey};
    use time::OffsetDateTime;

    use super::{
        validate_route_username, validate_target_username, validate_terminal_session_request,
        validate_workspace_app_route_id, validate_workspace_app_session_request,
        validate_workspace_app_upstream_host,
    };

    const SK_ED25519_CLIENT_KEY: &str = "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAICFo/k5LU8863u66YC9eUO2170QduohPURkQnbLa/dczAAAABHNzaDo= user@example.com";
    const ECDSA_CLIENT_KEY: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHwf2HMM5TRXvo2SQJjsNkiDD5KqiiNjrGVv3UUh+mMT5RHxiRtOnlqvjhQtBq0VpmpCV/PwUdhOig4vkbqAcEc= user@example.com";

    // Profile keys are stored with their comment; the key a client offers
    // during SSH auth carries none. Authorization must compare key material
    // only, and still reject a genuinely different key.
    #[test]
    fn allows_client_public_key_ignores_comment() {
        let base =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBklzf1Qy77LwsjmDlGvCAhBpCkhpti25927fAnOMEIR";
        let route = super::RouteRecord {
            route_username: "run-01-worker".to_owned(),
            target_username: "ubuntu".to_owned(),
            target_ip: "127.0.0.1".to_owned(),
            target_port: 22,
            authorized_client_public_keys_openssh: vec![format!("{base} laptop-key")],
            target_host_key_openssh: String::new(),
            target_private_key_openssh: String::new(),
            expires_at: OffsetDateTime::now_utc() + time::Duration::hours(1),
            metadata: RouteMetadata::default(),
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
        };

        let wire_key =
            russh::keys::ssh_key::PublicKey::from_openssh(base).expect("wire key parses");
        let other = russh::keys::ssh_key::PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA8ax6Yk1ZMSRpAkk8cIriNXtVufy6mxst2stQk66n+d",
        )
        .expect("other key parses");

        assert!(route.allows_client_public_key(&wire_key).expect("check"));
        assert!(!route.allows_client_public_key(&other).expect("check"));
    }

    #[test]
    fn username_validation_accepts_expected_values() {
        assert!(validate_route_username("run-01-web").is_ok());
        assert!(validate_target_username("ubuntu").is_ok());
    }

    #[test]
    fn username_validation_rejects_disallowed_values() {
        assert!(validate_route_username("worker@bad").is_err());
        assert!(validate_target_username("").is_err());
    }

    #[test]
    fn workspace_app_route_id_requires_canonical_wa_label() {
        assert!(validate_workspace_app_route_id("wa-a").is_ok());
        assert!(validate_workspace_app_route_id("wa-01-opaque").is_ok());
        assert!(validate_workspace_app_route_id(&format!("wa-{}", "a".repeat(60))).is_ok());

        for invalid in [
            "",
            "wa-",
            "app-opaque",
            "WA-opaque",
            "wa--opaque",
            "wa-opaque-",
            "wa-opaque.value",
            "wa-opaque_value",
        ] {
            assert!(
                validate_workspace_app_route_id(invalid).is_err(),
                "{invalid} should be rejected"
            );
        }
        assert!(validate_workspace_app_route_id(&format!("wa-{}", "a".repeat(61))).is_err());
    }

    #[test]
    fn workspace_app_upstream_host_requires_a_canonical_dns_name() {
        assert!(validate_workspace_app_upstream_host("hello.demo.127.0.0.1.sslip.io").is_ok());
        assert!(validate_workspace_app_upstream_host("service-1.internal").is_ok());

        for invalid in [
            "",
            "Service.internal",
            "service.internal.",
            "https://service.internal",
            "service.internal:8080",
            "*.internal",
            "-service.internal",
            "service_.internal",
            "service..internal",
        ] {
            assert!(
                validate_workspace_app_upstream_host(invalid).is_err(),
                "{invalid} should be rejected"
            );
        }
        assert!(
            validate_workspace_app_upstream_host(&format!("{}.internal", "a".repeat(64))).is_err()
        );
    }

    #[test]
    fn terminal_session_request_accepts_valid_payload() {
        let mut rng = russh::keys::key::safe_rng();
        let target_host_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("host key");
        let target_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("target key");

        let request = IssueTerminalSessionRequest {
            route_username: "run-01-worker".to_owned(),
            target_username: "ubuntu".to_owned(),
            target_ip: "127.0.0.1".to_owned(),
            target_port: 22,
            target_host_key_openssh: target_host_key.public_key().to_openssh().expect("host"),
            target_private_key_openssh: private_key_openssh(&target_key),
            authorized_client_public_keys_openssh: Vec::new(),
            route_expires_at: (OffsetDateTime::now_utc() + time::Duration::hours(1))
                .unix_timestamp(),
            mode: TerminalSessionMode::Browser,
            metadata: RouteMetadata::default(),
        };

        assert!(validate_terminal_session_request(request).is_ok());
    }

    #[test]
    fn terminal_session_request_rejects_invalid_target_ip() {
        let mut rng = russh::keys::key::safe_rng();
        let target_host_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("host key");
        let target_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("target key");

        let request = IssueTerminalSessionRequest {
            route_username: "run-01-worker".to_owned(),
            target_username: "ubuntu".to_owned(),
            target_ip: "worker.example.test".to_owned(),
            target_port: 22,
            target_host_key_openssh: target_host_key.public_key().to_openssh().expect("host"),
            target_private_key_openssh: private_key_openssh(&target_key),
            authorized_client_public_keys_openssh: Vec::new(),
            route_expires_at: (OffsetDateTime::now_utc() + time::Duration::hours(1))
                .unix_timestamp(),
            mode: TerminalSessionMode::Native,
            metadata: RouteMetadata::default(),
        };

        assert!(validate_terminal_session_request(request).is_err());
    }

    #[test]
    fn terminal_session_request_deduplicates_authorized_client_keys() {
        let mut rng = russh::keys::key::safe_rng();
        let target_host_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("host key");
        let target_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("target key");
        let client_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("client key");
        let client_key_openssh = client_key.public_key().to_openssh().expect("client");

        let request = IssueTerminalSessionRequest {
            route_username: "run-01-worker".to_owned(),
            target_username: "ubuntu".to_owned(),
            target_ip: "127.0.0.1".to_owned(),
            target_port: 22,
            target_host_key_openssh: target_host_key.public_key().to_openssh().expect("host"),
            target_private_key_openssh: private_key_openssh(&target_key),
            authorized_client_public_keys_openssh: vec![
                client_key_openssh.clone(),
                format!("  {client_key_openssh}  "),
            ],
            route_expires_at: (OffsetDateTime::now_utc() + time::Duration::hours(1))
                .unix_timestamp(),
            mode: TerminalSessionMode::Native,
            metadata: RouteMetadata::default(),
        };

        let (route, _) =
            validate_terminal_session_request(request).expect("request should validate");
        assert_eq!(
            route.authorized_client_public_keys_openssh,
            vec![client_key_openssh]
        );
    }

    #[test]
    fn terminal_session_request_accepts_security_key_ed25519_client_keys() {
        let (target_host_key_openssh, target_private_key_openssh) = ed25519_target_credentials();
        let (route, _) = validate_terminal_session_request(terminal_request(
            target_host_key_openssh,
            target_private_key_openssh,
            vec![SK_ED25519_CLIENT_KEY.to_owned()],
            TerminalSessionMode::Native,
        ))
        .expect("security-key Ed25519 client key should validate");

        assert_eq!(route.authorized_client_public_keys_openssh.len(), 1);
        let key = PublicKey::from_openssh(&route.authorized_client_public_keys_openssh[0])
            .expect("stored security-key Ed25519 key should parse");
        assert_eq!(key.algorithm(), Algorithm::SkEd25519);
    }

    #[test]
    fn terminal_session_request_rejects_non_ed25519_target_and_client_keys() {
        let mut rng = russh::keys::key::safe_rng();
        let legacy_key = russh::keys::PrivateKey::random(
            &mut rng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        )
        .expect("legacy key");
        let legacy_public_key = legacy_key
            .public_key()
            .to_openssh()
            .expect("legacy public key");
        let legacy_private_key = private_key_openssh(&legacy_key);

        let (_, valid_private_key) = ed25519_target_credentials();
        let error = validate_terminal_session_request(terminal_request(
            legacy_public_key.clone(),
            valid_private_key,
            Vec::new(),
            TerminalSessionMode::Browser,
        ))
        .expect_err("non-Ed25519 target host keys must be rejected");
        assert!(
            error
                .to_string()
                .contains("target_host_key_openssh must use ssh-ed25519")
        );

        let (valid_host_key, _) = ed25519_target_credentials();
        let error = validate_terminal_session_request(terminal_request(
            valid_host_key,
            legacy_private_key,
            Vec::new(),
            TerminalSessionMode::Browser,
        ))
        .expect_err("non-Ed25519 target private keys must be rejected");
        assert!(
            error
                .to_string()
                .contains("target_private_key_openssh must use ssh-ed25519")
        );

        let (valid_host_key, valid_private_key) = ed25519_target_credentials();
        let error = validate_terminal_session_request(terminal_request(
            valid_host_key,
            valid_private_key,
            vec![legacy_public_key],
            TerminalSessionMode::Native,
        ))
        .expect_err("non-Ed25519 native client keys must be rejected");
        assert!(
            error
                .to_string()
                .contains("must use ssh-ed25519 or sk-ssh-ed25519")
        );
    }

    #[test]
    fn workspace_app_session_request_rejects_non_ed25519_target_keys() {
        let mut rng = russh::keys::key::safe_rng();
        let legacy_key = russh::keys::PrivateKey::random(
            &mut rng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        )
        .expect("legacy key");
        let legacy_public_key = legacy_key
            .public_key()
            .to_openssh()
            .expect("legacy public key");
        let legacy_private_key = private_key_openssh(&legacy_key);

        let (_, valid_private_key) = ed25519_target_credentials();
        let error = validate_workspace_app_session_request(workspace_app_request(
            legacy_public_key,
            valid_private_key,
        ))
        .expect_err("non-Ed25519 workspace-app host keys must be rejected");
        assert!(
            error
                .to_string()
                .contains("target_host_key_openssh must use ssh-ed25519")
        );

        let (valid_host_key, _) = ed25519_target_credentials();
        let error = validate_workspace_app_session_request(workspace_app_request(
            valid_host_key,
            legacy_private_key,
        ))
        .expect_err("non-Ed25519 workspace-app private keys must be rejected");
        assert!(
            error
                .to_string()
                .contains("target_private_key_openssh must use ssh-ed25519")
        );
    }

    #[test]
    fn persisted_route_rejects_legacy_client_keys() {
        let route = super::RouteRecord {
            route_username: "run-01-worker".to_owned(),
            target_username: "ubuntu".to_owned(),
            target_ip: "127.0.0.1".to_owned(),
            target_port: 22,
            authorized_client_public_keys_openssh: vec![ECDSA_CLIENT_KEY.to_owned()],
            target_host_key_openssh: String::new(),
            target_private_key_openssh: String::new(),
            expires_at: OffsetDateTime::now_utc() + time::Duration::hours(1),
            metadata: RouteMetadata::default(),
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
        };
        let legacy_key = PublicKey::from_openssh(ECDSA_CLIENT_KEY).expect("legacy public key");

        assert!(route.authorized_client_public_keys().is_err());
        assert!(
            !route
                .allows_client_public_key(&legacy_key)
                .expect("legacy presented key must fail closed")
        );
    }

    #[test]
    fn browser_terminal_request_rejects_native_client_keys() {
        let mut rng = russh::keys::key::safe_rng();
        let target_host_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("host key");
        let target_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("target key");
        let client_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("client key");

        let request = IssueTerminalSessionRequest {
            route_username: "workspace-helper-browser".to_owned(),
            target_username: "ubuntu".to_owned(),
            target_ip: "127.0.0.1".to_owned(),
            target_port: 22,
            target_host_key_openssh: target_host_key.public_key().to_openssh().expect("host"),
            target_private_key_openssh: private_key_openssh(&target_key),
            authorized_client_public_keys_openssh: vec![
                client_key.public_key().to_openssh().expect("client"),
            ],
            route_expires_at: (OffsetDateTime::now_utc() + time::Duration::hours(1))
                .unix_timestamp(),
            mode: TerminalSessionMode::Browser,
            metadata: RouteMetadata::default(),
        };

        let error = validate_terminal_session_request(request)
            .expect_err("browser routes must never authorize native SSH keys");
        assert!(
            error
                .to_string()
                .contains("must be empty for browser sessions")
        );
    }

    fn private_key_openssh(key: &russh::keys::PrivateKey) -> String {
        key.to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .expect("private key")
            .to_string()
    }

    fn ed25519_target_credentials() -> (String, String) {
        let mut rng = russh::keys::key::safe_rng();
        let target_host_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("host key");
        let target_private_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("target key");
        (
            target_host_key.public_key().to_openssh().expect("host key"),
            private_key_openssh(&target_private_key),
        )
    }

    fn terminal_request(
        target_host_key_openssh: String,
        target_private_key_openssh: String,
        authorized_client_public_keys_openssh: Vec<String>,
        mode: TerminalSessionMode,
    ) -> IssueTerminalSessionRequest {
        IssueTerminalSessionRequest {
            route_username: "run-01-worker".to_owned(),
            target_username: "ubuntu".to_owned(),
            target_ip: "127.0.0.1".to_owned(),
            target_port: 22,
            target_host_key_openssh,
            target_private_key_openssh,
            authorized_client_public_keys_openssh,
            route_expires_at: (OffsetDateTime::now_utc() + time::Duration::hours(1))
                .unix_timestamp(),
            mode,
            metadata: RouteMetadata::default(),
        }
    }

    fn workspace_app_request(
        target_host_key_openssh: String,
        target_private_key_openssh: String,
    ) -> IssueWorkspaceAppSessionRequest {
        IssueWorkspaceAppSessionRequest {
            route_id: "wa-key-policy".to_owned(),
            create_only: true,
            target_username: "ubuntu".to_owned(),
            target_ip: "127.0.0.1".to_owned(),
            target_ssh_port: 22,
            target_host_key_openssh,
            target_private_key_openssh,
            target_app_port: 8080,
            protocol: WorkspaceAppProtocol::Http,
            upstream_host: None,
            route_expires_at: (OffsetDateTime::now_utc() + time::Duration::hours(1))
                .unix_timestamp(),
            metadata: RouteMetadata::default(),
        }
    }
}
