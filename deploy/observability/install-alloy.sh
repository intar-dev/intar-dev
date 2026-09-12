#!/bin/sh
# Run as root on a fresh Debian/Ubuntu amd64 host. The config and raw token
# must already be in the supplied private directory. No runtime service restarts.
set -eu

input_dir=${1:?Usage: install-alloy.sh PRIVATE_INPUT_DIRECTORY HOST_ID}
host_id=${2:?A stable host ID is required}
case "$host_id" in
  ''|*[!a-zA-Z0-9._-]*) echo 'Invalid host ID' >&2; exit 1 ;;
esac
test "$(id -u)" = 0
test "$(dpkg --print-architecture)" = amd64
test -s "$input_dir/config.alloy"
test -s "$input_dir/grafana-cloud-token"
if dpkg-query -W -f='${Status}' alloy 2>/dev/null | grep -q 'install ok installed'; then
  echo 'Alloy is already installed. Review and update its configuration separately.' >&2
  exit 1
fi
test ! -e /etc/alloy/config.alloy
test ! -e /etc/default/alloy

package="$input_dir/alloy.deb"
curl --fail --silent --show-error --location --retry 3 \
  'https://github.com/grafana/alloy/releases/download/v1.19.2/alloy-1.19.2-1.amd64.deb' \
  --output "$package"
printf '%s  %s\n' '9872732d43c6d14996e1ad5a075086a93381ea6375c8c756820da68b85422eea' "$package" | sha256sum --check
dpkg --install "$package"
usermod --append --groups adm,systemd-journal alloy
install -o root -g alloy -m 0640 "$input_dir/grafana-cloud-token" /etc/alloy/grafana-cloud-token
install -o root -g root -m 0644 "$input_dir/config.alloy" /etc/alloy/config.alloy
cat > /etc/default/alloy <<EOF
CONFIG_FILE=/etc/alloy/config.alloy
CUSTOM_ARGS="--stability.level=public-preview --server.http.listen-addr=127.0.0.1:12345 --disable-reporting"
INTAR_HOST_ID=$host_id
GOMEMLIMIT=384MiB
EOF
install -d -m 0755 /etc/systemd/system/alloy.service.d
cat > /etc/systemd/system/alloy.service.d/resources.conf <<'EOF'
[Service]
MemoryHigh=384M
MemoryMax=512M
CPUQuota=50%
EOF
cd /
runuser -u alloy -- env INTAR_HOST_ID="$host_id" alloy validate \
  --stability.level=public-preview /etc/alloy/config.alloy
systemctl daemon-reload
systemctl enable alloy
systemctl restart alloy
systemctl is-active alloy
