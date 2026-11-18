//! The client against a stand-in for intar's provider and channel routes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use subspace::{Error, SignIn, Subspace, Tokens};
use url::Url;

#[derive(Default)]
struct Server {
    /// code → (challenge, redirect_uri)
    codes: HashMap<String, (String, String)>,
    access: u32,
    refreshes: u32,
    closed: bool,
    idempotency_keys: Vec<String>,
}
type Shared = Arc<Mutex<Server>>;

fn run(active: bool) -> Value {
    json!({ "runId": "run-1", "scenarioId": "intar/web", "state": if active { "provisioning" } else { "completed" },
        "active": active, "executionId": "run-1", "generation": 1,
        "machines": [{ "name": "web", "image": "sha256:a", "spec": "sha256:b", "kino": "sha256:c", "mode": "learn",
            "cpuMillis": 1000, "memoryMib": 512, "diskMib": 4096, "egress": false, "terminal": true, "peers": [] }] })
}

fn bearer_ok(server: &Server, headers: &HeaderMap) -> bool {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        == Some(&format!("Bearer access-{}", server.access))
}

async fn token(State(shared): State<Shared>, body: String) -> (StatusCode, Json<Value>) {
    let fields: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect();
    let mut server = shared.lock().expect("lock");
    let field = |name: &str| fields.get(name).cloned().unwrap_or_default();
    let granted = match field("grant_type").as_str() {
        "authorization_code" => {
            server
                .codes
                .remove(&field("code"))
                .is_some_and(|(challenge, redirect_uri)| {
                    URL_SAFE_NO_PAD.encode(Sha256::digest(field("code_verifier").as_bytes()))
                        == challenge
                        && redirect_uri == field("redirect_uri")
                })
        }
        "refresh_token" => {
            let current = format!("refresh-{}", server.access);
            server.refreshes += 1;
            field("refresh_token") == current
        }
        _ => false,
    };
    if !granted || field("client_id") != "intar-jumper" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_grant" })),
        );
    }
    server.access += 1;
    (
        StatusCode::OK,
        Json(json!({ "access_token": format!("access-{}", server.access),
        "refresh_token": format!("refresh-{}", server.access), "expires_in": 3600 })),
    )
}

async fn start(
    State(shared): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let mut server = shared.lock().expect("lock");
    if !bearer_ok(&server, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized", "code": "signed_out" })),
        );
    }
    assert_eq!(body["protocol"], 1);
    assert_eq!(body["scenarioId"], "intar/web");
    assert_eq!(body["guestContracts"], json!([3]));
    assert_eq!(body["arch"], std::env::consts::ARCH);
    let key = headers["idempotency-key"].to_str().expect("key").to_owned();
    let reused = server.idempotency_keys.contains(&key);
    server.idempotency_keys.push(key);
    (
        if reused {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Json(json!({ "protocol": 1, "run": run(true), "reused": reused })),
    )
}

async fn act(
    State(shared): State<Shared>,
    headers: HeaderMap,
    Path((_, action)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let mut server = shared.lock().expect("lock");
    if !bearer_ok(&server, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized", "code": "signed_out" })),
        );
    }
    if action == "end" {
        assert_eq!(body, json!({}));
        server.closed = true;
        return (
            StatusCode::OK,
            Json(json!({ "protocol": 1, "run": run(false) })),
        );
    }
    if server.closed {
        return (
            StatusCode::CONFLICT,
            Json(
                json!({ "error": "the run has ended", "code": "run_closed", "protocol": 1, "run": run(false) }),
            ),
        );
    }
    assert_eq!(body["vms"], json!([]));
    (
        StatusCode::OK,
        Json(json!({ "protocol": 1, "run": run(true) })),
    )
}

async fn serve() -> (Url, Shared) {
    let shared = Shared::default();
    let app = Router::new()
        .route("/api/auth/oauth2/token", post(token))
        .route(
            "/api/local/catalog",
            // The website's answer, with fields this client does not read.
            get(|| async {
                Json(json!({ "protocol": 1, "courses": [{ "courseId": "c1", "organizationId": null,
                    "organizationName": null, "title": "Web", "summary": "s", "bodyMarkdown": "b", "sequential": true,
                    "lectures": [{ "lectureId": "l1", "title": "Serve", "summary": "s", "category": "web", "tags": ["nginx"],
                        "difficulty": "easy", "estimatedMinutes": 10, "scenarioId": "intar/web", "state": "available",
                        "blockedBy": null, "activeRunId": null, "scenarioReady": true }] }] }))
            }),
        )
        .route("/api/local/runs", post(start))
        .route("/api/local/runs/{id}/{action}", post(act))
        .route(
            "/api/local/runs/{id}",
            get(|| async { Json(json!({ "protocol": 1, "run": run(true) })) }),
        )
        .with_state(shared.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind");
    let base =
        Url::parse(&format!("http://{}", listener.local_addr().expect("addr"))).expect("url");
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
    (base, shared)
}

/// What the browser does: consent, then back to the app's loopback port.
async fn browser(shared: &Shared, authorize: &Url, state_override: Option<&str>) {
    let query: HashMap<String, String> = authorize.query_pairs().into_owned().collect();
    assert_eq!(query["client_id"], "intar-jumper");
    assert_eq!(query["scope"], "offline_access local-runs");
    assert_eq!(query["code_challenge_method"], "S256");
    shared.lock().expect("lock").codes.insert(
        "code-1".into(),
        (
            query["code_challenge"].clone(),
            query["redirect_uri"].clone(),
        ),
    );
    let http = reqwest::Client::new();
    // A stray request first: the listener must keep waiting.
    let stray = query["redirect_uri"].replace("/callback", "/favicon.ico");
    assert_eq!(http.get(stray).send().await.expect("stray").status(), 404);
    let mut back = Url::parse(&query["redirect_uri"]).expect("redirect");
    back.query_pairs_mut()
        .append_pair("code", "code-1")
        .append_pair("state", state_override.unwrap_or(&query["state"]));
    http.get(back).send().await.expect("callback");
}

#[tokio::test]
async fn signs_in_and_drives_a_run() {
    let (base, shared) = serve().await;
    let http = reqwest::Client::new();

    let sign_in = SignIn::begin(&base).await.expect("begin");
    let authorize = sign_in.authorize_url().clone();
    let (tokens, ()) = tokio::join!(sign_in.finish(&http), browser(&shared, &authorize, None));
    let tokens = tokens.expect("tokens");
    assert_eq!(tokens.access_token, "access-1");

    let channel = Subspace::new(http.clone(), base.clone(), tokens);
    let catalog = channel.catalog().await.expect("catalog");
    let lecture = &catalog.courses[0].lectures[0];
    assert_eq!(
        (lecture.scenario_id.as_deref(), lecture.state.as_str()),
        (Some("intar/web"), "available")
    );

    let started = channel
        .start_run("intar/web", None, &[3], "key-1")
        .await
        .expect("start");
    assert_eq!(
        (started.run.run_id.as_str(), started.reused),
        ("run-1", Some(false))
    );
    assert_eq!(started.run.machines[0].cpu_millis, 1000);
    assert_eq!(
        channel
            .start_run("intar/web", None, &[3], "key-1")
            .await
            .expect("replay")
            .reused,
        Some(true)
    );
    assert!(channel.run("run-1").await.expect("read").run.active);

    // The server stops honouring the access token: one refresh, then the call goes through.
    shared.lock().expect("lock").access = 7;
    let stale = Subspace::new(
        http.clone(),
        base.clone(),
        Tokens {
            access_token: "access-1".into(),
            refresh_token: Some("refresh-7".into()),
            expires_at: 0,
        },
    );
    assert!(
        stale
            .report("run-1", vec![])
            .await
            .expect("report")
            .run
            .active
    );
    assert_eq!(stale.tokens().await.access_token, "access-8");
    assert_eq!(shared.lock().expect("lock").refreshes, 1);

    // A closed run comes back with the refusal, so the caller can stop its VMs.
    assert!(!stale.end_run("run-1").await.expect("end").run.active);
    match stale.report("run-1", vec![]).await {
        Err(Error::Refused {
            status: 409,
            code,
            run: Some(run),
            ..
        }) => {
            assert_eq!(code, "run_closed");
            assert!(!run.active);
        }
        other => panic!("expected run_closed, got {other:?}"),
    }

    // No refresh token, or one the provider refuses: signed out, with no retry loop.
    let gone = Subspace::new(
        http.clone(),
        base.clone(),
        Tokens {
            access_token: "old".into(),
            refresh_token: Some("spent".into()),
            expires_at: 0,
        },
    );
    assert!(matches!(gone.end_run("run-1").await, Err(Error::SignedOut)));
    let none = Subspace::new(
        http,
        base,
        Tokens {
            access_token: "old".into(),
            refresh_token: None,
            expires_at: 0,
        },
    );
    assert!(matches!(none.end_run("run-1").await, Err(Error::SignedOut)));
}

#[tokio::test]
async fn refuses_a_callback_from_another_sign_in() {
    let (base, shared) = serve().await;
    let http = reqwest::Client::new();
    let sign_in = SignIn::begin(&base).await.expect("begin");
    let authorize = sign_in.authorize_url().clone();
    let (tokens, ()) = tokio::join!(
        sign_in.finish(&http),
        browser(&shared, &authorize, Some("someone-elses-state"))
    );
    assert!(matches!(tokens, Err(Error::SignIn(_))));
    // The code was never exchanged.
    assert_eq!(shared.lock().expect("lock").access, 0);
}
