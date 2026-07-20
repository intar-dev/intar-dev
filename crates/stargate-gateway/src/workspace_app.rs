use axum::{
    body::Body,
    extract::{Path, State},
    http::{
        HeaderMap, HeaderValue, Method, Request, Response, StatusCode, Uri,
        header::{self, HeaderName},
        uri::Authority,
    },
    response::IntoResponse,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hyper::client::conn::http1;
use hyper_util::rt::TokioIo;
use sha2::{Digest as _, Sha256};
use stargate_core::{SessionKind, StargateError, WorkspaceAppRouteRecord};
use time::OffsetDateTime;

use crate::{GatewayHttpError, GatewayState, outbound::open_workspace_app_tunnel};

const FORWARDED_HOST: HeaderName = HeaderName::from_static("x-forwarded-host");
const FORWARDED_PROTO: HeaderName = HeaderName::from_static("x-forwarded-proto");
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
    let mut url = if let Some(domain) = state.public_web.workspace_app_base_domain.as_deref() {
        let scheme = state.public_web.public_base_url.scheme();
        if !matches!(scheme, "http" | "https") {
            return Err(StargateError::Internal(
                "public_base_url must use http or https".to_owned(),
            ));
        }
        format!("{scheme}://{route_id}.{domain}/")
            .parse::<url::Url>()
            .map_err(|error| StargateError::Internal(error.to_string()))?
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
            "workspace app wildcard origin is not configured".to_owned(),
        ))
    }
}

fn workspace_app_origin_is_safe(scheme: &str, has_wildcard_domain: bool) -> bool {
    has_wildcard_domain || scheme == "http"
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

pub async fn proxy_workspace_app_host(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Result<Response<Body>, GatewayHttpError> {
    let Some(route_id) = route_id_from_host(&headers, &state) else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    proxy_workspace_app(state, route_id, request, None).await
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
    if request.method() == Method::CONNECT {
        return Ok(StatusCode::METHOD_NOT_ALLOWED.into_response());
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
        &route,
        upstream_path,
        state.public_web.public_base_url.scheme(),
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
    remove_reserved_set_cookies(response.headers_mut());

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

fn remove_reserved_set_cookies(headers: &mut HeaderMap) {
    let remaining = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter(|value| {
            value
                .to_str()
                .ok()
                .and_then(|cookie| cookie.split_once('='))
                .is_none_or(|(name, _)| !reserved_cookie_name(name.trim()))
        })
        .cloned()
        .collect::<Vec<_>>();
    headers.remove(header::SET_COOKIE);
    for value in remaining {
        headers.append(header::SET_COOKIE, value);
    }
}

fn reserved_cookie_name(name: &str) -> bool {
    name.starts_with(SECURE_COOKIE_PREFIX) || name.starts_with(DEVELOPMENT_COOKIE_PREFIX)
}

fn rewrite_request(
    request: &mut Request<Body>,
    route: &WorkspaceAppRouteRecord,
    upstream_path: Option<&str>,
    forwarded_proto: &str,
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

    let original_host = request.headers().get(header::HOST).cloned();
    let preserve_upgrade = is_websocket_upgrade_request(request.method(), request.headers());
    remove_hop_by_hop_headers(request.headers_mut(), preserve_upgrade);

    if let Some(host) = original_host {
        request.headers_mut().insert(FORWARDED_HOST, host);
    }
    request.headers_mut().insert(
        FORWARDED_PROTO,
        HeaderValue::from_str(forwarded_proto)
            .map_err(|error| StargateError::Internal(error.to_string()))?,
    );
    request.headers_mut().insert(
        header::HOST,
        HeaderValue::from_str(&format!("127.0.0.1:{}", route.target_app_port))
            .map_err(|error| StargateError::Internal(error.to_string()))?,
    );
    Ok(())
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

fn route_id_from_host(headers: &HeaderMap, state: &GatewayState) -> Option<String> {
    let domain = state.public_web.workspace_app_base_domain.as_deref()?;
    route_id_from_authority(headers.get(header::HOST)?.to_str().ok()?, domain)
}

fn route_id_from_authority(authority: &str, domain: &str) -> Option<String> {
    let authority = authority.parse::<Authority>().ok()?;
    let hostname = authority.host().trim_end_matches('.').to_ascii_lowercase();
    let suffix = format!(".{domain}");
    let route_id = hostname.strip_suffix(&suffix)?;
    if !valid_route_id(route_id) {
        return None;
    }
    Some(route_id.to_owned())
}

fn valid_route_id(route_id: &str) -> bool {
    if route_id.is_empty() || route_id.len() > 63 {
        return false;
    }
    let bytes = route_id.as_bytes();
    let valid_edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    valid_edge(bytes[0])
        && valid_edge(bytes[bytes.len() - 1])
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
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
        bootstrap_token, is_websocket_upgrade_request, remove_hop_by_hop_headers,
        remove_reserved_set_cookies, remove_workspace_app_cookies, route_id_from_authority,
        uri_without_bootstrap, valid_opaque_token, workspace_app_origin_is_safe,
    };
    use axum::http::{HeaderMap, HeaderValue, Method, Uri, header};
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
    fn secure_workspace_apps_fail_closed_without_a_wildcard_origin() {
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
    fn accepts_only_one_canonical_route_label_on_the_wildcard_host() {
        let domain = "workshop-apps.example.test";
        assert_eq!(
            route_id_from_authority("WA-123.workshop-apps.example.test:443", domain).as_deref(),
            Some("wa-123")
        );
        assert_eq!(
            route_id_from_authority("wa-123.workshop-apps.example.test.", domain).as_deref(),
            Some("wa-123")
        );
        assert!(
            route_id_from_authority("nested.wa-123.workshop-apps.example.test", domain).is_none()
        );
        assert!(route_id_from_authority("-bad.workshop-apps.example.test", domain).is_none());
        assert!(
            route_id_from_authority("wa-123.workshop-apps.example.test.evil", domain).is_none()
        );
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
    fn prevents_upstream_apps_from_overwriting_reserved_session_cookies() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static("application_session=kept; Path=/"),
        );
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static("__Host-intar-wapp-route=clobber; Path=/; Secure"),
        );
        remove_reserved_set_cookies(&mut headers);
        let values = headers
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .collect::<Vec<_>>();
        assert_eq!(values, vec!["application_session=kept; Path=/"]);
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
