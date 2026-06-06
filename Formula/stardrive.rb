class Stardrive < Formula
  desc "Manage Hetzner-hosted Talos clusters with Infisical-backed GitOps"
  homepage "https://github.com/intar-dev/intar-dev/tree/main/projects/stardrive"
  version "0.1.11"

  on_macos do
    on_arm do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.11/stardrive_0.1.11_darwin_arm64.tar.gz"
      sha256 "68cbd68f6380143cc1e28a4f67e1866b7a1545d7ec7d2e3df01dd2cd07848f09"
    end

    on_intel do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.11/stardrive_0.1.11_darwin_amd64.tar.gz"
      sha256 "a085a2004064c1b747f837b5082602705dd4bf6cbb84e0d3af4999c82403be01"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.11/stardrive_0.1.11_linux_arm64.tar.gz"
      sha256 "bca632cd3496a151df042bd170bb69c1df2707e9eb256d247584c3f5e6de3200"
    end

    on_intel do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.11/stardrive_0.1.11_linux_amd64.tar.gz"
      sha256 "30feed298ffcc696e490f64c9cf105532887f500596f1bc16bdc5f7414621c27"
    end
  end

  def install
    bin.install "stardrive"
  end

  test do
    output = shell_output("#{bin}/stardrive version")
    assert_match "stardrive", output
  end
end
