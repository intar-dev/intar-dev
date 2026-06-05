class Stardrive < Formula
  desc "Manage Hetzner-hosted Talos clusters with Infisical-backed GitOps"
  homepage "https://github.com/intar-dev/intar-dev/tree/main/projects/stardrive"
  version "0.1.7"

  on_macos do
    on_arm do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.7/stardrive_0.1.7_darwin_arm64.tar.gz"
      sha256 "d880ca91ef811da7e23ce5040ef4a5c1818dc98e4e13e949b6b7d1f427fbbf2f"
    end

    on_intel do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.7/stardrive_0.1.7_darwin_amd64.tar.gz"
      sha256 "816c5fc612e613d158ad10f3c57f63050e937a5b3fc6aa9a0e8abfff7407f028"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.7/stardrive_0.1.7_linux_arm64.tar.gz"
      sha256 "db52984537aa470c0947fc43cbc0f0e6523f3996e70c128bfe623a437fa11756"
    end

    on_intel do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.7/stardrive_0.1.7_linux_amd64.tar.gz"
      sha256 "0589fc6afdce4c9cddbb14593b2b2576c6f6f2c202915d3861e1f4f128648c79"
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
