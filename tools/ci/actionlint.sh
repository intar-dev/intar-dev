#!/usr/bin/env bash
# Lint the workflows with a pinned, checksum-verified actionlint.
#
# actionlint runs shellcheck on every run block when shellcheck is on PATH and
# silently skips it when it is not. The shell parse is what caught the quoting
# defect in the deploy workflow, so require the binary instead of quietly
# losing that coverage.
set -euo pipefail

readonly VERSION='1.7.10'

case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)
        platform='linux_amd64'
        digest='f4c76b71db5755a713e6055cbb0857ed07e103e028bda117817660ebadb4386f'
        ;;
    Darwin-arm64)
        platform='darwin_arm64'
        digest='004ca87b367b37f4d75c55ab6cf80f9b8c043adbfbd440f31c604d417939c442'
        ;;
    *)
        echo "No pinned actionlint ${VERSION} for $(uname -s)-$(uname -m)." >&2
        exit 1
        ;;
esac

command -v shellcheck >/dev/null 2>&1 || {
    echo 'shellcheck is required for the workflow lint.' >&2
    exit 1
}

dir="target/actionlint/${VERSION}"
if [ ! -x "${dir}/actionlint" ]; then
    mkdir -p "${dir}"
    archive="${dir}/actionlint.tar.gz"
    curl -fsSL --retry 3 -o "${archive}" \
        "https://github.com/rhysd/actionlint/releases/download/v${VERSION}/actionlint_${VERSION}_${platform}.tar.gz"
    echo "${digest}  ${archive}" | shasum -a 256 -c - >/dev/null
    tar -xzf "${archive}" -C "${dir}" actionlint
    rm "${archive}"
fi

"${dir}/actionlint" .github/workflows/*.yml
