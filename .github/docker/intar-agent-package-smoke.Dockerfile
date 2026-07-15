FROM ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90

ENV DEBIAN_FRONTEND=noninteractive

# Keep the pinned base while taking current Noble security updates whenever a
# release proof is built; pinning apt versions would make that proof stale.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        acl \
        binutils \
        ca-certificates \
        curl \
        dbus \
        dosfstools \
        e2fsprogs \
        file \
        iproute2 \
        libcap2-bin \
        nftables \
        passwd \
        procps \
        python3 \
        shellcheck \
        systemd \
        systemd-sysv \
        util-linux \
        xfsprogs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

STOPSIGNAL SIGRTMIN+3

CMD ["/sbin/init"]
