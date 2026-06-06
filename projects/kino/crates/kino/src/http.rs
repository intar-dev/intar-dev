use crate::state::ProbeStore;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use prost::Message;

#[derive(Clone)]
struct AppState {
    probe_store: ProbeStore,
}

pub(crate) fn build_router(probe_store: ProbeStore) -> Router {
    let state = AppState { probe_store };

    Router::new()
        .route("/version", get(get_version))
        .route("/probes", get(get_probes))
        .with_state(state)
}

async fn get_version() -> Response {
    (
        [(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("text/plain; charset=utf-8"),
        )],
        env!("CARGO_PKG_VERSION"),
    )
        .into_response()
}

async fn get_probes(State(state): State<AppState>) -> Response {
    let snapshot = state.probe_store.snapshot_proto().await;

    let mut bytes = Vec::with_capacity(snapshot.encoded_len());
    if snapshot.encode(&mut bytes).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    (
        [(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/x-protobuf"),
        )],
        bytes,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::build_router;
    use crate::state::ProbeStore;
    use axum::body::to_bytes;
    use axum::http::{Request, StatusCode, header};
    use std::sync::Arc;
    use tower::ServiceExt;

    #[tokio::test]
    async fn version_endpoint_returns_crate_version() {
        let probes = Vec::<Arc<crate::probe::ProbeDefinition>>::new();
        let app = build_router(ProbeStore::new(&probes));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/version")
                    .body(axum::body::Body::empty())
                    .unwrap_or_else(|error| panic!("failed to build request: {error}")),
            )
            .await
            .unwrap_or_else(|error| panic!("router returned error: {error}"));

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE),
            Some(&header::HeaderValue::from_static(
                "text/plain; charset=utf-8"
            ))
        );

        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap_or_else(|error| panic!("failed to read response body: {error}"));
        assert_eq!(body.as_ref(), env!("CARGO_PKG_VERSION").as_bytes());
    }
}
