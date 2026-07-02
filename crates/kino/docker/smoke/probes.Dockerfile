FROM rust:1.96-alpine AS builder
WORKDIR /app

RUN apk add --no-cache build-base musl-dev pkgconfig

COPY Cargo.toml Cargo.lock ./
COPY crates/intar-kino-proto/Cargo.toml crates/intar-kino-proto/Cargo.toml
COPY crates/intar-kino-proto/build.rs crates/intar-kino-proto/build.rs
COPY crates/intar-kino-proto/proto crates/intar-kino-proto/proto
COPY crates/intar-kino-proto/src crates/intar-kino-proto/src
COPY crates/kino/Cargo.toml crates/kino/Cargo.toml
COPY crates/kino/src crates/kino/src

RUN cargo build --release -p kino

FROM k0sproject/k0s:v1.34.3-k0s.0

COPY --from=builder /app/target/release/kino /usr/local/bin/kino
COPY crates/kino/docker/smoke/probes-entrypoint.sh /usr/local/bin/start-kino-k0s.sh

RUN set -eu; \
    chmod +x /usr/local/bin/kino /usr/local/bin/start-kino-k0s.sh; \
    mkdir -p /etc/kino; \
    { \
      echo 'server {'; \
      echo '  bind = "tcp://0.0.0.0:8080"'; \
      echo '}'; \
      echo; \
      echo 'defaults {'; \
      echo '  every_seconds = 5'; \
      echo '  timeout_seconds = 2'; \
      echo '  kubeconfig = "/etc/kino/kubeconfig"'; \
      echo '}'; \
      echo; \
      echo 'probe "kino_config_exists" {'; \
      echo '  kind = "file_exists"'; \
      echo '  path = "/etc/kino/kino.hcl"'; \
      echo '}'; \
      echo; \
      echo 'probe "kino_config_has_server_block" {'; \
      echo '  kind = "file_regex_capture"'; \
      echo '  path = "/etc/kino/kino.hcl"'; \
      echo '  pattern = "server\\s*\\{"'; \
      echo '}'; \
      echo; \
      echo 'probe "kube_api_port_open" {'; \
      echo '  kind = "port_open"'; \
      echo '  host = "127.0.0.1"'; \
      echo '  port = 6443'; \
      echo '  protocol = "tcp"'; \
      echo '}'; \
      echo; \
      echo 'probe "kino_check_pod_running" {'; \
      echo '  kind = "k8s_pod_state"'; \
      echo '  namespace = "default"'; \
      echo '  selector = "app=kino-check"'; \
      echo '  desired_state = "phase:Running"'; \
      echo '  every_seconds = 10'; \
      echo '}'; \
    } >/etc/kino/kino.hcl

EXPOSE 8080 6443

ENTRYPOINT ["/usr/local/bin/start-kino-k0s.sh"]
