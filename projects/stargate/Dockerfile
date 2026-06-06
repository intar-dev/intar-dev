FROM docker.io/library/debian:bookworm-slim

ARG STARGATE_BIN=target/release/stargate

LABEL org.opencontainers.image.source="https://github.com/intar-dev/stargate" \
      org.opencontainers.image.licenses="MIT OR Apache-2.0" \
      org.opencontainers.image.description="Stargate SSH proxy"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system stargate \
    && useradd --system --gid stargate --home-dir /var/lib/stargate --shell /usr/sbin/nologin stargate \
    && install -d -m 0700 -o stargate -g stargate /var/lib/stargate /var/lib/stargate/tmp \
    && install -d -m 0750 -o root -g stargate /etc/stargate

COPY --chmod=0755 ${STARGATE_BIN} /usr/local/bin/stargate

ENV TMPDIR=/var/lib/stargate/tmp

USER stargate:stargate
WORKDIR /var/lib/stargate

EXPOSE 2222 8080 8081

ENTRYPOINT ["/usr/local/bin/stargate"]
CMD ["--config", "/etc/stargate/stargate.toml"]
