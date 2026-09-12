#!/bin/sh
# Set the local OTLP destination for the next normal service start.
# This does not restart runtime services or expose the Grafana credential.
set -eu
host_id=${1:?Usage: enable-service-tracing.sh HOST_ID}
case "$host_id" in ''|*[!a-zA-Z0-9._-]*) exit 1 ;; esac
test "$(id -u)" = 0
test -f /etc/alloy/config.alloy
for unit in intar-agent intar-builder intar-jailerd stargate; do
    if [ "$(systemctl show "$unit.service" -p LoadState --value)" != loaded ]; then
        continue
    fi
    install -d -m 0755 "/etc/systemd/system/$unit.service.d"
    cat > "/etc/systemd/system/$unit.service.d/observability.conf" <<EOF
[Service]
Environment=OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
Environment="OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,host.name=$host_id"
EOF
    printf '%s: local trace export configured for next start\n' "$unit"
done
systemctl daemon-reload
