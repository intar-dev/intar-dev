use axum::{
    body::Body,
    extract::{Path, State},
    http::{
        HeaderMap, HeaderValue, Method, Request, Response, StatusCode, Uri,
        header::{self, HeaderName},
        uri::Authority,
    },
    middleware::Next,
    response::IntoResponse,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hyper::client::conn::http1;
use hyper_util::rt::TokioIo;
use sha2::{Digest as _, Sha256};
use stargate_core::{SessionKind, StargateError, validate_workspace_app_route_id};
use time::OffsetDateTime;

use crate::{GatewayHttpError, GatewayState, outbound::open_workspace_app_tunnel};

const FORWARDED_HOST: HeaderName = HeaderName::from_static("x-forwarded-host");
const FORWARDED_PROTO: HeaderName = HeaderName::from_static("x-forwarded-proto");
const FORWARDED_PORT: HeaderName = HeaderName::from_static("x-forwarded-port");
const CLOUDFLARE_CACHE_CONTROL: HeaderName =
    HeaderName::from_static("cloudflare-cdn-cache-control");
const BOOTSTRAP_QUERY_PARAMETER: &str = "__intar_bootstrap";
const SECURE_COOKIE_PREFIX: &str = "__Host-intar-wapp-";
const DEVELOPMENT_COOKIE_PREFIX: &str = "intar-wapp-";
const TOKEN_BYTES: usize = 32;
const TOKEN_ENCODED_LEN: usize = 43;

pub(crate) struct WorkspaceAppBootstrap {
    pub token: String,
    pub token_sha256: String,
    pub expires_at: OffsetDateTime,
}

pub(crate) fn new_workspace_app_bootstrap(
    route_expires_at: OffsetDateTime,
    ttl_seconds: u64,
) -> Result<WorkspaceAppBootstrap, StargateError> {
    let token = new_opaque_token()?;
    let ttl = i64::try_from(ttl_seconds).map_err(|_| {
        StargateError::Internal("workspace app bootstrap TTL overflowed".to_owned())
    })?;
    let expires_at =
        (OffsetDateTime::now_utc() + time::Duration::seconds(ttl)).min(route_expires_at);
    Ok(WorkspaceAppBootstrap {
        token_sha256: token_sha256(&token),
        token,
        expires_at,
    })
}

pub(crate) fn build_workspace_app_url(
    state: &GatewayState,
    route_id: &str,
    bootstrap_token: &str,
) -> Result<String, StargateError> {
    ensure_workspace_app_origin_configured(state)?;
    validate_workspace_app_route_id(route_id)?;
    let mut url = if let Some(domain) = state.public_web.workspace_app_base_domain.as_deref() {
        let scheme = state.public_web.public_base_url.scheme();
        if !matches!(scheme, "http" | "https") {
            return Err(StargateError::Internal(
                "public_base_url must use http or https".to_owned(),
            ));
        }
        let expected_host = format!("{route_id}.{domain}");
        let url = format!("{scheme}://{expected_host}/")
            .parse::<url::Url>()
            .map_err(|error| StargateError::Internal(error.to_string()))?;
        if url.host_str() != Some(expected_host.as_str())
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return Err(StargateError::Internal(
                "workspace app URL did not produce the configured first-level origin".to_owned(),
            ));
        }
        url
    } else {
        state
            .public_web
            .public_base_url
            .join(&format!("/v1/workspace-apps/{route_id}/"))
            .map_err(|error| StargateError::Internal(error.to_string()))?
    };
    url.query_pairs_mut()
        .append_pair(BOOTSTRAP_QUERY_PARAMETER, bootstrap_token);
    Ok(url.to_string())
}

pub(crate) fn ensure_workspace_app_origin_configured(
    state: &GatewayState,
) -> Result<(), StargateError> {
    let scheme = state.public_web.public_base_url.scheme();
    if workspace_app_origin_is_safe(scheme, state.public_web.workspace_app_base_domain.is_some()) {
        Ok(())
    } else {
        Err(StargateError::Validation(
            "isolated workspace app origin is not configured".to_owned(),
        ))
    }
}

fn workspace_app_origin_is_safe(scheme: &str, has_app_domain: bool) -> bool {
    has_app_domain || scheme == "http"
}

pub async fn proxy_workspace_app_root(
    State(state): State<GatewayState>,
    Path(route_id): Path<String>,
    request: Request<Body>,
) -> Result<Response<Body>, GatewayHttpError> {
    proxy_workspace_app(state, route_id, request, Some("/")).await
}

pub async fn proxy_workspace_app_path(
    State(state): State<GatewayState>,
    Path((route_id, path)): Path<(String, String)>,
    request: Request<Body>,
) -> Result<Response<Body>, GatewayHttpError> {
    let upstream_path = format!("/{path}");
    proxy_workspace_app(state, route_id, request, Some(&upstream_path)).await
}

pub async fn dispatch_public_request(
    State(state): State<GatewayState>,
    request: Request<Body>,
    next: Next,
) -> Response<Body> {
    match classify_public_request(request.headers(), &state) {
        Ok(PublicRequestTarget::Gateway) => next.run(request).await,
        Ok(PublicRequestTarget::WorkspaceApp(route_id)) => {
            match proxy_workspace_app(state, route_id, request, None).await {
                Ok(response) => response,
                Err(error) => error.into_response(),
            }
        }
        Ok(PublicRequestTarget::Unknown) => StatusCode::NOT_FOUND.into_response(),
        Err(()) => StatusCode::BAD_REQUEST.into_response(),
    }
}

async fn proxy_workspace_app(
    state: GatewayState,
    route_id: String,
    mut request: Request<Body>,
    upstream_path: Option<&str>,
) -> Result<Response<Body>, GatewayHttpError> {
    if !valid_route_id(&route_id) {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    if request.method() == Method::CONNECT {
        return Ok(StatusCode::METHOD_NOT_ALLOWED.into_response());
    }
    if let Some(bootstrap_token) = bootstrap_token(request.uri()) {
        return exchange_workspace_app_bootstrap(
            &state,
            &route_id,
            &bootstrap_token,
            request.method(),
            request.uri(),
        )
        .await;
    }
    let session_cookie_name = workspace_app_cookie_name(&state, &route_id);
    let session_token = cookie_value(request.headers(), &session_cookie_name)
        .filter(|token| valid_opaque_token(token))
        .ok_or_else(|| GatewayHttpError(StargateError::Unauthorized))?;
    // Register admission before consulting SQLite or opening SSH. Route
    // deletion/rotation can then cancel a request even when it is between the
    // authorization lookup and the first proxied byte. A second early lease
    // covers a possible WebSocket after the HTTP/1 driver hands it off.
    let connection_lease =
        state
            .sessions
            .register(route_id.clone(), SessionKind::WorkspaceApp, None);
    let connection_cancel = connection_lease.token();
    let upgrade_lease = state
        .sessions
        .register(route_id.clone(), SessionKind::WorkspaceApp, None);
    let upgrade_cancel = upgrade_lease.token();
    let session_token_sha256 = token_sha256(&session_token);
    let authorization = tokio::select! {
        _ = connection_cancel.cancelled() => None,
        route = state.store.get_authorized_workspace_app_route(
            &route_id,
            &session_token_sha256,
        ) => route?,
    };
    let (route, browser_session_expires_at) =
        authorization.ok_or_else(|| GatewayHttpError(StargateError::Unauthorized))?;
    let authorization_expires_at = route.expires_at.min(browser_session_expires_at);
    if connection_cancel.is_cancelled() || upgrade_cancel.is_cancelled() {
        return Err(GatewayHttpError(StargateError::Unauthorized));
    }

    remove_workspace_app_cookies(request.headers_mut());
    rewrite_request(
        &mut request,
        upstream_path,
        state.public_web.public_base_url.scheme(),
        route.upstream_host.as_deref(),
    )?;
    let wants_upgrade = is_websocket_upgrade_request(request.method(), request.headers());
    let downstream_upgrade = wants_upgrade.then(|| hyper::upgrade::on(&mut request));

    let tunnel = tokio::select! {
        _ = connection_cancel.cancelled() => {
            return Err(GatewayHttpError(StargateError::Unauthorized));
        }
        _ = wait_until(authorization_expires_at) => {
            return Err(GatewayHttpError(StargateError::Unauthorized));
        }
        tunnel = open_workspace_app_tunnel(&route) => tunnel?,
    };
    let (mut sender, connection) = tokio::select! {
        _ = connection_cancel.cancelled() => {
            return Err(GatewayHttpError(StargateError::Unauthorized));
        }
        _ = wait_until(authorization_expires_at) => {
            return Err(GatewayHttpError(StargateError::Unauthorized));
        }
        handshake = http1::handshake(TokioIo::new(tunnel)) => {
            handshake.map_err(|error| StargateError::Internal(error.to_string()))?
        }
    };

    let driver_cancel = connection_cancel.clone();
    tokio::spawn(async move {
        let result = tokio::select! {
            _ = driver_cancel.cancelled() => Ok(()),
            _ = wait_until(authorization_expires_at) => Ok(()),
            result = connection.with_upgrades() => result,
        };
        if let Err(error) = result {
            tracing::debug!(%error, "workspace app upstream connection ended with an error");
        }
        drop(connection_lease);
    });

    let mut response = tokio::select! {
        _ = connection_cancel.cancelled() => {
            return Err(GatewayHttpError(StargateError::Unauthorized));
        }
        _ = wait_until(authorization_expires_at) => {
            return Err(GatewayHttpError(StargateError::Unauthorized));
        }
        response = sender.send_request(request) => {
            response.map_err(|error| StargateError::Internal(error.to_string()))?
        }
    };

    let switched_protocols = response.status() == StatusCode::SWITCHING_PROTOCOLS;
    let valid_websocket_upgrade =
        wants_upgrade && switched_protocols && is_websocket_upgrade_headers(response.headers());
    if switched_protocols && !valid_websocket_upgrade {
        return Ok(StatusCode::BAD_GATEWAY.into_response());
    }
    remove_hop_by_hop_headers(response.headers_mut(), valid_websocket_upgrade);
    sanitize_upstream_set_cookies(response.headers_mut());
    apply_private_no_store(response.headers_mut());

    if let Some(downstream_upgrade) = downstream_upgrade
        && valid_websocket_upgrade
    {
        let upstream_upgrade = hyper::upgrade::on(&mut response);
        tokio::spawn(async move {
            let result = tokio::select! {
                _ = upgrade_cancel.cancelled() => Ok::<(), anyhow::Error>(()),
                _ = wait_until(authorization_expires_at) => Ok::<(), anyhow::Error>(()),
                result = async {
                let (downstream, upstream) =
                    tokio::try_join!(downstream_upgrade, upstream_upgrade)?;
                let mut downstream = TokioIo::new(downstream);
                let mut upstream = TokioIo::new(upstream);
                tokio::select! {
                    _ = upgrade_cancel.cancelled() => Ok::<(), anyhow::Error>(()),
                    result = tokio::io::copy_bidirectional(&mut downstream, &mut upstream) => {
                        result?;
                        Ok(())
                    }
                }
                } => result,
            };
            if let Err(error) = result {
                tracing::debug!(%error, "workspace app websocket tunnel ended with an error");
            }
            drop(upgrade_lease);
        });
    }

    Ok(response.map(Body::new))
}

async fn exchange_workspace_app_bootstrap(
    state: &GatewayState,
    route_id: &str,
    bootstrap_token: &str,
    method: &Method,
    uri: &Uri,
) -> Result<Response<Body>, GatewayHttpError> {
    if method != Method::GET && method != Method::HEAD {
        return Err(GatewayHttpError(StargateError::Unauthorized));
    }
    if !valid_opaque_token(bootstrap_token) {
        return sanitized_bootstrap_redirect(uri, None);
    }
    let browser_session_token = new_opaque_token()?;
    let ttl = i64::try_from(state.public_web.workspace_app_session_ttl_seconds)
        .map_err(|_| StargateError::Internal("workspace app session TTL overflowed".to_owned()))?;
    let requested_expires_at = OffsetDateTime::now_utc() + time::Duration::seconds(ttl);
    let expires_at = state
        .store
        .exchange_workspace_app_bootstrap(
            route_id,
            &token_sha256(bootstrap_token),
            &token_sha256(&browser_session_token),
            requested_expires_at,
        )
        .await?;
    let Some(expires_at) = expires_at else {
        // Even expired or replayed capability URLs are scrubbed from the
        // address bar. No cookie is set, so the redirected request still
        // fails closed.
        return sanitized_bootstrap_redirect(uri, None);
    };
    let max_age = (expires_at - OffsetDateTime::now_utc())
        .whole_seconds()
        .max(1);
    let cookie = workspace_app_session_cookie(state, route_id, &browser_session_token, max_age);
    sanitized_bootstrap_redirect(uri, Some(cookie))
}

fn sanitized_bootstrap_redirect(
    uri: &Uri,
    cookie: Option<String>,
) -> Result<Response<Body>, GatewayHttpError> {
    let location = uri_without_bootstrap(uri)?;
    let mut response = Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header(header::LOCATION, location)
        .header(header::CACHE_CONTROL, "no-store")
        .header(CLOUDFLARE_CACHE_CONTROL, "no-store")
        .header("pragma", "no-cache")
        .header("referrer-policy", "no-referrer");
    if let Some(cookie) = cookie {
        response = response.header(header::SET_COOKIE, cookie);
    }
    response
        .body(Body::empty())
        .map_err(|error| GatewayHttpError(StargateError::Internal(error.to_string())))
}

fn new_opaque_token() -> Result<String, StargateError> {
    let mut bytes = [0_u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes)
        .map_err(|error| StargateError::Internal(format!("secure randomness failed: {error}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn token_sha256(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

fn valid_opaque_token(token: &str) -> bool {
    token.len() == TOKEN_ENCODED_LEN
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn bootstrap_token(uri: &Uri) -> Option<String> {
    let mut values = uri
        .query()
        .into_iter()
        .flat_map(|query| url::form_urlencoded::parse(query.as_bytes()))
        .filter(|(name, _)| name == BOOTSTRAP_QUERY_PARAMETER)
        .map(|(_, value)| value.into_owned());
    let value = values.next();
    if values.next().is_some() {
        // Treat ambiguous input as an invalid capability. The normal exchange
        // path will scrub every bootstrap parameter without setting a cookie.
        return Some(String::new());
    }
    value
}

fn uri_without_bootstrap(uri: &Uri) -> Result<String, GatewayHttpError> {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    if let Some(raw_query) = uri.query() {
        for (name, value) in url::form_urlencoded::parse(raw_query.as_bytes()) {
            if name != BOOTSTRAP_QUERY_PARAMETER {
                query.append_pair(&name, &value);
            }
        }
    }
    let query = query.finish();
    if query.is_empty() {
        Ok(uri.path().to_owned())
    } else {
        Ok(format!("{}?{query}", uri.path()))
    }
}

fn workspace_app_cookie_name(state: &GatewayState, route_id: &str) -> String {
    let prefix = if state.public_web.public_base_url.scheme() == "https" {
        SECURE_COOKIE_PREFIX
    } else {
        DEVELOPMENT_COOKIE_PREFIX
    };
    format!("{prefix}{route_id}")
}

fn workspace_app_session_cookie(
    state: &GatewayState,
    route_id: &str,
    token: &str,
    max_age_seconds: i64,
) -> String {
    let secure = if state.public_web.public_base_url.scheme() == "https" {
        "; Secure"
    } else {
        ""
    };
    format!(
        "{}={token}; Path=/; Max-Age={max_age_seconds}; HttpOnly; SameSite=Lax{secure}",
        workspace_app_cookie_name(state, route_id)
    )
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|cookie| cookie.trim().split_once('='))
        .find_map(|(candidate, value)| (candidate == name).then(|| value.to_owned()))
}

fn remove_workspace_app_cookies(headers: &mut HeaderMap) {
    let remaining = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .map(str::trim)
        .filter(|cookie| {
            cookie
                .split_once('=')
                .is_none_or(|(candidate, _)| !reserved_cookie_name(candidate))
        })
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    headers.remove(header::COOKIE);
    if !remaining.is_empty()
        && let Ok(value) = HeaderValue::from_str(&remaining.join("; "))
    {
        headers.insert(header::COOKIE, value);
    }
}

fn sanitize_upstream_set_cookies(headers: &mut HeaderMap) {
    let sanitized = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(sanitize_set_cookie)
        .collect::<Vec<_>>();
    headers.remove(header::SET_COOKIE);
    for value in sanitized {
        headers.append(header::SET_COOKIE, value);
    }
}

fn sanitize_set_cookie(cookie: &str) -> Option<HeaderValue> {
    if cookie.bytes().any(|byte| byte.is_ascii_control()) {
        return None;
    }
    let mut segments = cookie.split(';');
    let cookie_pair = segments.next()?.trim();
    let (name, value) = cookie_pair.split_once('=')?;
    if !valid_cookie_token(name) || !valid_cookie_value(value) || reserved_cookie_name(name) {
        return None;
    }

    let mut attributes = Vec::new();
    let mut has_secure = false;
    for raw_attribute in segments {
        let attribute = raw_attribute.trim();
        if attribute.is_empty() {
            return None;
        }
        let attribute_name = attribute
            .split_once('=')
            .map_or(attribute, |(name, _)| name)
            .trim();
        if !valid_cookie_token(attribute_name) {
            return None;
        }
        if attribute_name.eq_ignore_ascii_case("domain") {
            continue;
        }
        if attribute_name.eq_ignore_ascii_case("secure") {
            if attribute.contains('=') {
                return None;
            }
            has_secure = true;
        }
        attributes.push(attribute);
    }
    if !has_secure {
        attributes.push("Secure");
    }

    let mut value = cookie_pair.to_owned();
    for attribute in attributes {
        value.push_str("; ");
        value.push_str(attribute);
    }
    HeaderValue::from_str(&value).ok()
}

fn valid_cookie_value(value: &str) -> bool {
    let value = if value.starts_with('"') || value.ends_with('"') {
        value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .filter(|value| !value.contains('"'))
            .unwrap_or("\0")
    } else {
        value
    };
    value.bytes().all(|byte| {
        matches!(
            byte,
            0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e
        )
    })
}

fn valid_cookie_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii()
                && !byte.is_ascii_control()
                && !matches!(
                    byte,
                    b'(' | b')'
                        | b'<'
                        | b'>'
                        | b'@'
                        | b','
                        | b';'
                        | b':'
                        | b'\\'
                        | b'"'
                        | b'/'
                        | b'['
                        | b']'
                        | b'?'
                        | b'='
                        | b'{'
                        | b'}'
                        | b' '
                        | b'\t'
                )
        })
}

fn reserved_cookie_name(name: &str) -> bool {
    name.starts_with(SECURE_COOKIE_PREFIX) || name.starts_with(DEVELOPMENT_COOKIE_PREFIX)
}

fn rewrite_request(
    request: &mut Request<Body>,
    upstream_path: Option<&str>,
    forwarded_proto: &str,
    upstream_host: Option<&str>,
) -> Result<(), GatewayHttpError> {
    if let Some(path) = upstream_path {
        let path_and_query = match request.uri().query() {
            Some(query) => format!("{path}?{query}"),
            None => path.to_owned(),
        };
        *request.uri_mut() = Uri::builder()
            .path_and_query(path_and_query)
            .build()
            .map_err(|error| StargateError::Internal(error.to_string()))?;
    }

    let original_host = request
        .headers()
        .get(header::HOST)
        .cloned()
        .ok_or_else(|| StargateError::Internal("validated Host header disappeared".to_owned()))?;
    let original_authority = original_host
        .to_str()
        .map_err(|error| StargateError::Internal(error.to_string()))?
        .parse::<Authority>()
        .map_err(|error| StargateError::Internal(error.to_string()))?;
    let forwarded_port = original_authority
        .port_u16()
        .unwrap_or_else(|| if forwarded_proto == "https" { 443 } else { 80 });
    let default_port = if forwarded_proto == "https" { 443 } else { 80 };
    let public_host = if original_authority.port_u16() == Some(default_port) {
        HeaderValue::from_str(original_authority.host())
            .map_err(|error| StargateError::Internal(error.to_string()))?
    } else {
        original_host
    };
    let preserve_upgrade = is_websocket_upgrade_request(request.method(), request.headers());
    remove_hop_by_hop_headers(request.headers_mut(), preserve_upgrade);
    remove_forwarding_headers(request.headers_mut());

    request
        .headers_mut()
        .insert(FORWARDED_HOST, public_host.clone());
    request.headers_mut().insert(
        FORWARDED_PROTO,
        HeaderValue::from_str(forwarded_proto)
            .map_err(|error| StargateError::Internal(error.to_string()))?,
    );
    request.headers_mut().insert(
        FORWARDED_PORT,
        HeaderValue::from_str(&forwarded_port.to_string())
            .map_err(|error| StargateError::Internal(error.to_string()))?,
    );
    let upstream_host = upstream_host
        .map(HeaderValue::from_str)
        .transpose()
        .map_err(|error| StargateError::Internal(error.to_string()))?
        .unwrap_or(public_host);
    request.headers_mut().insert(header::HOST, upstream_host);
    Ok(())
}

fn remove_forwarding_headers(headers: &mut HeaderMap) {
    let names = headers
        .keys()
        .filter(|name| name.as_str() == "forwarded" || name.as_str().starts_with("x-forwarded-"))
        .cloned()
        .collect::<Vec<_>>();
    for name in names {
        headers.remove(name);
    }
}

fn apply_private_no_store(headers: &mut HeaderMap) {
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        CLOUDFLARE_CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
}

fn remove_hop_by_hop_headers(headers: &mut HeaderMap, preserve_upgrade: bool) {
    let connection_headers = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|value| HeaderName::from_bytes(value.trim().as_bytes()).ok())
        .collect::<Vec<_>>();
    for name in connection_headers {
        if !preserve_upgrade || name != header::UPGRADE {
            headers.remove(name);
        }
    }
    for name in [
        "keep-alive",
        "proxy-connection",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
    ] {
        headers.remove(name);
    }
    if !preserve_upgrade {
        headers.remove(header::CONNECTION);
        headers.remove(header::UPGRADE);
    } else {
        headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
    }
}

fn is_websocket_upgrade_request(method: &Method, headers: &HeaderMap) -> bool {
    method == Method::GET && is_websocket_upgrade_headers(headers)
}

fn is_websocket_upgrade_headers(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
        && headers
            .get(header::CONNECTION)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
            })
}

#[derive(Debug, Eq, PartialEq)]
enum PublicRequestTarget {
    Gateway,
    WorkspaceApp(String),
    Unknown,
}

fn classify_public_request(
    headers: &HeaderMap,
    state: &GatewayState,
) -> Result<PublicRequestTarget, ()> {
    let authority = single_host_authority(headers)?;
    classify_authority(
        authority,
        &state.public_web.public_base_url,
        state.public_web.workspace_app_base_domain.as_deref(),
    )
}

fn single_host_authority(headers: &HeaderMap) -> Result<&str, ()> {
    let mut values = headers.get_all(header::HOST).iter();
    let authority = values.next().ok_or(())?.to_str().map_err(|_| ())?;
    if values.next().is_some() {
        return Err(());
    }
    Ok(authority)
}

fn classify_authority(
    raw_authority: &str,
    public_base_url: &url::Url,
    workspace_app_base_domain: Option<&str>,
) -> Result<PublicRequestTarget, ()> {
    if raw_authority.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(());
    }
    let authority = raw_authority.parse::<Authority>().map_err(|_| ())?;
    let hostname = authority.host();
    let remainder = raw_authority.strip_prefix(hostname).ok_or(())?;
    if !remainder.is_empty()
        && authority
            .port()
            .is_none_or(|port| remainder != format!(":{}", port.as_str()))
    {
        return Err(());
    }
    if hostname.ends_with('.') {
        return Err(());
    }

    let public_hostname = public_base_url.host_str().ok_or(())?;
    if hostnames_equal(hostname, public_hostname) {
        return gateway_port_is_valid(&authority, public_base_url)
            .then_some(PublicRequestTarget::Gateway)
            .ok_or(());
    }

    if !valid_dns_hostname(hostname) {
        return Err(());
    }
    if public_base_url.scheme() == "https" && authority.port_u16().is_some_and(|port| port != 443) {
        return Err(());
    }
    let Some(domain) = workspace_app_base_domain else {
        return Ok(PublicRequestTarget::Unknown);
    };
    let suffix = format!(".{domain}");
    let Some(route_id) = hostname.strip_suffix(&suffix) else {
        return Ok(PublicRequestTarget::Unknown);
    };
    if validate_workspace_app_route_id(route_id).is_err() {
        if !route_id.contains('.') && route_id.starts_with("wa-") {
            return Err(());
        }
        return Ok(PublicRequestTarget::Unknown);
    }
    Ok(PublicRequestTarget::WorkspaceApp(route_id.to_owned()))
}

fn gateway_port_is_valid(authority: &Authority, public_base_url: &url::Url) -> bool {
    if let Some(configured_port) = public_base_url.port() {
        return authority.port_u16() == Some(configured_port);
    }
    let default_port = match public_base_url.scheme() {
        "http" => 80,
        "https" => 443,
        _ => return false,
    };
    authority
        .port_u16()
        .is_none_or(|request_port| request_port == default_port)
}

fn hostnames_equal(authority_host: &str, url_host: &str) -> bool {
    authority_host == url_host
        || authority_host
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .is_some_and(|host| host == url_host)
}

fn valid_dns_hostname(hostname: &str) -> bool {
    !hostname.is_empty()
        && hostname.len() <= 253
        && hostname.split('.').all(|label| {
            let bytes = label.as_bytes();
            let valid_edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
            !bytes.is_empty()
                && bytes.len() <= 63
                && valid_edge(bytes[0])
                && valid_edge(bytes[bytes.len() - 1])
                && bytes.iter().all(|byte| valid_edge(*byte) || *byte == b'-')
        })
}

fn valid_route_id(route_id: &str) -> bool {
    validate_workspace_app_route_id(route_id).is_ok()
}

async fn wait_until(expires_at: OffsetDateTime) {
    let remaining = expires_at - OffsetDateTime::now_utc();
    let Ok(remaining) = std::time::Duration::try_from(remaining) else {
        return;
    };
    tokio::time::sleep(remaining).await;
}

#[cfg(test)]
mod tests {
    use super::{
        PublicRequestTarget, bootstrap_token, classify_authority, is_websocket_upgrade_request,
        remove_hop_by_hop_headers, remove_workspace_app_cookies, rewrite_request,
        sanitize_upstream_set_cookies, single_host_authority, uri_without_bootstrap,
        valid_opaque_token, workspace_app_origin_is_safe,
    };
    use axum::{
        body::Body,
        http::{HeaderMap, HeaderValue, Method, Request, Uri, header},
    };
    use stargate_core::SessionKind;

    use crate::SessionRegistry;

    #[tokio::test]
    async fn route_teardown_cancels_pre_proxy_http_and_upgrade_admissions() {
        let registry = SessionRegistry::default();
        let http = registry.register("wa-race-safe".to_owned(), SessionKind::WorkspaceApp, None);
        let upgrade = registry.register("wa-race-safe".to_owned(), SessionKind::WorkspaceApp, None);
        let http_cancelled = http.token();
        let upgrade_cancelled = upgrade.token();

        registry.terminate_username("wa-race-safe").await;

        assert!(http_cancelled.is_cancelled());
        assert!(upgrade_cancelled.is_cancelled());
    }

    #[test]
    fn secure_workspace_apps_fail_closed_without_an_isolated_origin() {
        assert!(workspace_app_origin_is_safe("https", true));
        assert!(workspace_app_origin_is_safe("http", false));
        assert!(!workspace_app_origin_is_safe("https", false));
    }

    #[test]
    fn detects_and_preserves_websocket_upgrade_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONNECTION,
            HeaderValue::from_static("keep-alive, Upgrade"),
        );
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        assert!(is_websocket_upgrade_request(&Method::GET, &headers));

        remove_hop_by_hop_headers(&mut headers, true);
        assert!(headers.contains_key(header::CONNECTION));
        assert!(headers.contains_key(header::UPGRADE));
    }

    #[test]
    fn rejects_non_websocket_and_non_get_protocol_upgrades() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
        headers.insert(header::UPGRADE, HeaderValue::from_static("raw-tcp"));
        assert!(!is_websocket_upgrade_request(&Method::GET, &headers));

        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        assert!(!is_websocket_upgrade_request(&Method::POST, &headers));
    }

    #[test]
    fn classifies_only_canonical_first_level_workspace_app_hosts() {
        let public_base_url = "https://ws.example.test".parse().expect("URL");
        assert_eq!(
            classify_authority("ws.example.test", &public_base_url, Some("example.test")),
            Ok(PublicRequestTarget::Gateway)
        );
        assert_eq!(
            classify_authority("wa-123.example.test", &public_base_url, None),
            Ok(PublicRequestTarget::Unknown),
            "HTTPS rollout without the app domain must fail closed"
        );
        assert_eq!(
            classify_authority(
                "wa-123.example.test:443",
                &public_base_url,
                Some("example.test")
            ),
            Ok(PublicRequestTarget::WorkspaceApp("wa-123".to_owned()))
        );
        assert_eq!(
            classify_authority(
                "nested.wa-123.example.test",
                &public_base_url,
                Some("example.test")
            ),
            Ok(PublicRequestTarget::Unknown)
        );
        assert_eq!(
            classify_authority(
                "garbage.example.test",
                &public_base_url,
                Some("example.test")
            ),
            Ok(PublicRequestTarget::Unknown)
        );
        assert!(
            classify_authority(
                "WA-123.example.test",
                &public_base_url,
                Some("example.test")
            )
            .is_err()
        );
        assert!(
            classify_authority(
                "wa-123.example.test.",
                &public_base_url,
                Some("example.test")
            )
            .is_err()
        );
        assert!(
            classify_authority(
                "wa-123.example.test:8443",
                &public_base_url,
                Some("example.test")
            )
            .is_err()
        );
        assert!(
            classify_authority(
                "wa--opaque.example.test",
                &public_base_url,
                Some("example.test")
            )
            .is_err()
        );
        assert!(
            classify_authority(
                "wa-123.example.test:not-a-port",
                &public_base_url,
                Some("example.test")
            )
            .is_err()
        );
        assert!(
            classify_authority(
                "wa-123.example.test:99999",
                &public_base_url,
                Some("example.test")
            )
            .is_err()
        );
        assert!(
            classify_authority(
                "user@wa-123.example.test",
                &public_base_url,
                Some("example.test")
            )
            .is_err()
        );
        assert_eq!(
            classify_authority(
                "wa-123.example.test.evil",
                &public_base_url,
                Some("example.test")
            ),
            Ok(PublicRequestTarget::Unknown)
        );
        assert!(
            classify_authority(
                "unknown.other.test:8443",
                &public_base_url,
                Some("example.test")
            )
            .is_err()
        );
    }

    #[test]
    fn requires_exactly_one_host_header() {
        let missing = HeaderMap::new();
        assert!(single_host_authority(&missing).is_err());

        let mut duplicate = HeaderMap::new();
        duplicate.append(header::HOST, HeaderValue::from_static("ws.example.test"));
        duplicate.append(header::HOST, HeaderValue::from_static("wa-a.example.test"));
        assert!(single_host_authority(&duplicate).is_err());
    }

    #[test]
    fn removes_connection_headers_for_plain_http() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
        headers.insert("keep-alive", HeaderValue::from_static("timeout=5"));
        remove_hop_by_hop_headers(&mut headers, false);
        assert!(!headers.contains_key(header::CONNECTION));
        assert!(!headers.contains_key("keep-alive"));
    }

    #[test]
    fn removes_every_reserved_stargate_cookie_before_proxying() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static(
                "theme=dark; intar-wapp-route=secret; __Host-intar-wapp-other=also-secret; application_session=kept",
            ),
        );
        remove_workspace_app_cookies(&mut headers);
        assert_eq!(
            headers
                .get(header::COOKIE)
                .and_then(|value| value.to_str().ok()),
            Some("theme=dark; application_session=kept")
        );
    }

    #[test]
    fn sanitizes_upstream_application_cookies_and_drops_malformed_or_reserved_values() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static(
                "application_session=kept; Domain=example.test; Path=/; HttpOnly",
            ),
        );
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static("__Host-intar-wapp-route=clobber; Path=/; Secure"),
        );
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static("malformed-cookie-without-value"),
        );
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static("insecure_session=drop; Secure=true"),
        );
        sanitize_upstream_set_cookies(&mut headers);
        let values = headers
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .collect::<Vec<_>>();
        assert_eq!(
            values,
            vec!["application_session=kept; Path=/; HttpOnly; Secure"]
        );
    }

    #[test]
    fn rewrites_spoofed_forwarding_headers_and_preserves_the_public_host() {
        let mut request = Request::builder()
            .uri("/hello")
            .header(header::HOST, "wa-123.example.test")
            .header("forwarded", "host=attacker.test")
            .header("x-forwarded-host", "attacker.test")
            .header("x-forwarded-proto", "http")
            .header("x-forwarded-port", "80")
            .body(Body::empty())
            .expect("request");

        rewrite_request(&mut request, None, "https", None).expect("rewrite");

        assert_eq!(request.headers()[header::HOST], "wa-123.example.test");
        assert_eq!(request.headers()["x-forwarded-host"], "wa-123.example.test");
        assert_eq!(request.headers()["x-forwarded-proto"], "https");
        assert_eq!(request.headers()["x-forwarded-port"], "443");
        assert!(!request.headers().contains_key("forwarded"));

        let mut explicit_default_port = Request::builder()
            .uri("/hello")
            .header(header::HOST, "wa-123.example.test:443")
            .body(Body::empty())
            .expect("request");
        rewrite_request(&mut explicit_default_port, None, "https", None).expect("rewrite");
        assert_eq!(
            explicit_default_port.headers()[header::HOST],
            "wa-123.example.test"
        );
        assert_eq!(
            explicit_default_port.headers()["x-forwarded-host"],
            "wa-123.example.test"
        );
        assert_eq!(explicit_default_port.headers()["x-forwarded-port"], "443");

        let mut virtual_host = Request::builder()
            .uri("/hello")
            .header(header::HOST, "wa-123.example.test")
            .body(Body::empty())
            .expect("request");
        rewrite_request(
            &mut virtual_host,
            None,
            "https",
            Some("hello.demo.127.0.0.1.sslip.io"),
        )
        .expect("rewrite");
        assert_eq!(
            virtual_host.headers()[header::HOST],
            "hello.demo.127.0.0.1.sslip.io"
        );
        assert_eq!(
            virtual_host.headers()["x-forwarded-host"],
            "wa-123.example.test"
        );
        assert_eq!(virtual_host.headers()["x-forwarded-proto"], "https");
        assert_eq!(virtual_host.headers()["x-forwarded-port"], "443");
    }

    #[test]
    fn extracts_one_bootstrap_and_builds_a_sanitized_location() {
        let uri = Uri::from_static("/path?before=1&__intar_bootstrap=token&after=2");
        assert_eq!(bootstrap_token(&uri), Some("token".to_owned()));
        assert_eq!(
            uri_without_bootstrap(&uri).expect("location"),
            "/path?before=1&after=2"
        );
        let duplicate = Uri::from_static("/path?__intar_bootstrap=first&__intar_bootstrap=second");
        assert_eq!(bootstrap_token(&duplicate), Some(String::new()));
    }

    #[test]
    fn accepts_only_canonical_256_bit_base64url_tokens() {
        assert!(valid_opaque_token(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
        assert!(!valid_opaque_token("short"));
        assert!(!valid_opaque_token(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa="
        ));
    }
}
