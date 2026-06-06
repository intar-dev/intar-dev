FROM rust:1.93-alpine AS builder
WORKDIR /app

RUN apk add --no-cache build-base musl-dev pkgconfig

COPY Cargo.toml Cargo.lock ./
COPY crates/kino/Cargo.toml crates/kino/Cargo.toml
COPY crates/kino/build.rs crates/kino/build.rs
COPY crates/kino/src crates/kino/src
COPY proto proto

RUN cargo build --release -p kino

FROM alpine:3.22

RUN apk add --no-cache openssh-server

COPY --from=builder /app/target/release/kino /usr/local/bin/kino
COPY docker/smoke/ssh-recording-entrypoint.sh /usr/local/bin/start-kino-ssh-smoke.sh
COPY docker/smoke/kino-shell.sh /usr/local/bin/kino-shell

RUN set -eu; \
    chmod +x /usr/local/bin/kino /usr/local/bin/start-kino-ssh-smoke.sh /usr/local/bin/kino-shell; \
    mkdir -p /etc/kino /run/sshd /recordings; \
    adduser -D -h /home/user -s /usr/local/bin/kino-shell user; \
    passwd -u user; \
    grep -qxF /usr/local/bin/kino-shell /etc/shells || echo /usr/local/bin/kino-shell >> /etc/shells; \
    install -d -m 0700 -o user -g user /home/user/.ssh; \
    { \
      echo 'Port 22'; \
      echo 'ListenAddress 0.0.0.0'; \
      echo 'Protocol 2'; \
      echo 'HostKey /etc/ssh/ssh_host_ed25519_key'; \
      echo 'PasswordAuthentication no'; \
      echo 'KbdInteractiveAuthentication no'; \
      echo 'ChallengeResponseAuthentication no'; \
      echo 'PermitRootLogin no'; \
      echo 'AuthorizedKeysFile .ssh/authorized_keys'; \
      echo 'PidFile /run/sshd.pid'; \
      echo 'Subsystem sftp internal-sftp'; \
    } >/etc/ssh/sshd_config; \
    { \
      echo 'server {'; \
      echo '  bind = "tcp://127.0.0.1:8080"'; \
      echo '}'; \
      echo; \
      echo 'recording {'; \
      echo '  output_dir = "/recordings"'; \
      echo '  real_shell = "/bin/sh"'; \
      echo '}'; \
    } >/etc/kino/ssh-recording.hcl

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/start-kino-ssh-smoke.sh"]
