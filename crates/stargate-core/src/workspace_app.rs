use intar_contracts::stargate::{
    IssueWorkspaceAppSessionRequest, WorkspaceAppMetadata, WorkspaceAppProtocol,
};
use russh::keys::ssh_key::{Algorithm, PublicKey};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{Result, StargateError};

const TARGET_USERNAME_MAX_LEN: usize = 64;
const WORKSPACE_APP_ROUTE_ID_MAX_LEN: usize = 63;
const WORKSPACE_APP_UPSTREAM_HOST_MAX_LEN: usize = 253;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RegisteredWorkspaceAppRoute {
    pub route_id: String,
    pub create_only: bool,
    pub target_username: String,
    pub transport: crate::SshTargetTransport,
    pub target_host_key_openssh: String,
    pub target_private_key_openssh: String,
    pub target_app_port: u16,
    pub protocol: WorkspaceAppProtocol,
    pub upstream_host: Option<String>,
    #[serde(with = "time::serde::timestamp")]
    pub expires_at: OffsetDateTime,
    pub metadata: WorkspaceAppMetadata,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceAppRouteRecord {
    pub route_id: String,
    pub target_username: String,
    pub transport: crate::SshTargetTransport,
    pub target_host_key_openssh: String,
    pub target_private_key_openssh: String,
    pub target_app_port: u16,
    pub protocol: WorkspaceAppProtocol,
    pub upstream_host: Option<String>,
    #[serde(with = "time::serde::timestamp")]
    pub expires_at: OffsetDateTime,
    pub metadata: WorkspaceAppMetadata,
    #[serde(with = "time::serde::timestamp")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::timestamp")]
    pub updated_at: OffsetDateTime,
}

pub fn validate_workspace_app_session_request(
    request: IssueWorkspaceAppSessionRequest,
) -> Result<RegisteredWorkspaceAppRoute> {
    validate_workspace_app_route_id(&request.route_id)?;
    validate_target_username(&request.target_username)?;
    if request.target_app_port == 0 {
        return Err(StargateError::Validation(
            "target_app_port must be between 1 and 65535".to_owned(),
        ));
    }
    if let crate::SshTargetTransport::Relay { target } = &request.transport
        && (request.metadata.host_id.as_deref() != Some(&target.host.host_id)
            || request.metadata.vm_id.as_deref() != Some(&target.vm_id)
            || request.metadata.user_id.as_deref() != Some(&target.owner_id))
    {
        return Err(StargateError::Validation(
            "relay assignment does not match workspace app".into(),
        ));
    }
    request
        .transport
        .validate()
        .map_err(|e| StargateError::Validation(e.to_string()))?;
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
        transport: request.transport,
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

pub fn validate_workspace_app_upstream_host(upstream_host: &str) -> Result<()> {
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

pub fn validate_target_username(username: &str) -> Result<()> {
    if username.is_empty() || username.len() > TARGET_USERNAME_MAX_LEN {
        return Err(StargateError::Validation(format!(
            "target_username must be 1..={TARGET_USERNAME_MAX_LEN} characters"
        )));
    }
    let valid = username
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if !valid {
        return Err(StargateError::Validation(
            "target_username may only contain ASCII letters, digits, '.', '_' and '-'".to_owned(),
        ));
    }
    Ok(())
}

impl WorkspaceAppRouteRecord {
    pub fn target_host_key(&self) -> Result<PublicKey> {
        parse_target_host_key(&self.target_host_key_openssh)
    }

    pub fn is_expired_at(&self, now: OffsetDateTime) -> bool {
        self.expires_at <= now
    }
}

#[cfg(test)]
mod tests {
    use intar_contracts::stargate::{
        IssueWorkspaceAppSessionRequest, WorkspaceAppMetadata, WorkspaceAppProtocol,
    };
    use russh::keys::ssh_key::Algorithm;
    use time::OffsetDateTime;

    use super::{
        validate_workspace_app_route_id, validate_workspace_app_session_request,
        validate_workspace_app_upstream_host,
    };

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
    fn workspace_app_request_accepts_absent_metadata() {
        let mut rng = russh::keys::key::safe_rng();
        let target_host_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("host key");
        let target_key =
            russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("target key");
        let request = IssueWorkspaceAppSessionRequest {
            route_id: "wa-key-policy".to_owned(),
            create_only: true,
            target_username: "ubuntu".to_owned(),
            transport: crate::SshTargetTransport::Direct {
                host: "127.0.0.1".to_owned(),
                port: 22,
            },
            target_host_key_openssh: target_host_key.public_key().to_openssh().expect("host"),
            target_private_key_openssh: target_key
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .expect("private")
                .to_string(),
            target_app_port: 8080,
            protocol: WorkspaceAppProtocol::Http,
            upstream_host: None,
            route_expires_at: (OffsetDateTime::now_utc() + time::Duration::hours(1))
                .unix_timestamp(),
            metadata: WorkspaceAppMetadata::default(),
        };

        assert!(validate_workspace_app_session_request(request).is_ok());
    }
}
