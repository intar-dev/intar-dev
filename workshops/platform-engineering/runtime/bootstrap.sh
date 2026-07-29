#!/usr/bin/env bash
set -euo pipefail

readonly root="${INTAR_WORKSHOP_INSTALL_ROOT:?missing install root}"
readonly image_lock="${INTAR_WORKSHOP_IMAGE_LOCK:?missing image lock}"
readonly mise_version=v2026.7.3
readonly mise_sha256=06088e84e4514b59fd2b6b17927bcc37aa0ab10020a270868871fb010b92069b

[[ "$(id -u)" == 0 ]] || { echo "runtime bootstrap requires root" >&2; exit 1; }
[[ "$(uname -m)" == x86_64 ]] || { echo "runtime requires x86_64" >&2; exit 1; }
. /etc/os-release
[[ "${ID}" == debian && "${VERSION_ID}" == 13 ]] || {
  echo "runtime requires Debian 13" >&2
  exit 1
}

preflight_https() {
  local host="$1" status
  # Docker Hub's canonical image host redirects /v2/ to the marketing site.
  # Probe the registry endpoint that containerd and Docker actually use.
  if [[ "${host}" == docker.io ]]; then
    host=registry-1.docker.io
  fi
  getent ahosts "${host}" >/dev/null || { echo "DNS failed for ${host}" >&2; return 1; }
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}'     --connect-timeout 10 --max-time 20 --proto '=https' --proto-redir '=https'     --tlsv1.2 "https://${host}/v2/")" || return 1
  case "${status}" in 200|401|403) ;; *) echo "HTTPS registry preflight for ${host} returned ${status}" >&2; return 1;; esac
}

mapfile -t registries < <(sed 's/#.*//' "${image_lock}" | awk 'NF {sub(/\/.*/, "", $1); print $1}' | sort -u)
for registry in "${registries[@]}"; do
  preflight_https "${registry}"
done
for host in deb.debian.org security.debian.org github.com; do
  getent ahosts "${host}" >/dev/null
  curl --fail --silent --show-error --head --max-time 20 --proto '=https'     --proto-redir '=https' --tlsv1.2 "https://${host}/" >/dev/null
done

export DEBIAN_FRONTEND=noninteractive
sed -i -e 's|http://deb.debian.org|https://deb.debian.org|g'   -e 's|http://security.debian.org|https://security.debian.org|g'   /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true
apt-get update
apt-get install --yes --no-install-recommends ca-certificates curl docker-cli docker.io git jq xz-utils
systemctl enable --now docker

mise_tmp="$(mktemp)"
trap 'rm -f "${mise_tmp}"' EXIT
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https'   --tlsv1.2 "https://github.com/jdx/mise/releases/download/${mise_version}/mise-${mise_version}-linux-x64"   --output "${mise_tmp}"
printf '%s  %s
' "${mise_sha256}" "${mise_tmp}" | sha256sum --check --status
install --owner=root --group=root --mode=0755 "${mise_tmp}" /usr/local/bin/mise

export MISE_DATA_DIR=/opt/intar-mise
export MISE_CACHE_DIR=/var/cache/intar-mise
export MISE_YES=1
cd "${root}"
mise trust "${root}/mise.toml"
mise install
for tool in talosctl kubectl helm crane cilium jq; do
  target="$(mise which "${tool}")"
  ln -sfn "${target}" "/usr/local/bin/${tool}"
done

# Validate every immutable manifest before any checkpoint catch-up starts.
while IFS= read -r image; do
  image="${image%%#*}"
  image="${image//[[:space:]]/}"
  [[ -z "${image}" ]] && continue
  [[ "${image}" =~ @sha256:[a-f0-9]{64}$ ]] || { echo "tag-only image: ${image}" >&2; exit 1; }
  crane manifest "${image}" >/dev/null
done < "${image_lock}"

# Only the Talos node container lives in the host Docker content store. Talos'
# inner containerd pulls the remaining digest-pinned workloads from upstream.
docker pull ghcr.io/siderolabs/talos@sha256:f2e2b7e5812b2b59c1acfe6af7516231aeeef79fb1ffff6b57ad987f8dd47a6e

if [[ ! -d .git ]]; then
  git init --initial-branch=main --quiet
  printf '.intar-runtime-owner
' >> .git/info/exclude
  git add -A
  git -c user.name=Intar -c user.email=workshop@intar.dev     commit --quiet -m 'Pinned learner source 1b6fad43551a720b143d7a52799f81c4c89455cb'
fi
mkdir -p /var/lib/intar-workshop
printf '%s
' "$(date -u +%FT%TZ)" > /var/lib/intar-workshop/registry-preflight.ok
