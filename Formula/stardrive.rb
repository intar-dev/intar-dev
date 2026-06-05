class Stardrive < Formula
  desc "Manage Hetzner-hosted Talos clusters with Infisical-backed GitOps"
  homepage "https://github.com/intar-dev/intar-dev/tree/main/projects/stardrive"
  version "0.1.8"

  on_macos do
    on_arm do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.8/stardrive_0.1.8_darwin_arm64.tar.gz"
      sha256 "e64e56c19b4f4094b5fdff59102f3b7cbda95503f305551e5d8caa65eb4f06a1"
    end

    on_intel do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.8/stardrive_0.1.8_darwin_amd64.tar.gz"
      sha256 "55bdd1f1cfbe792c92fdcb9ce625c1f31fb5bd2e22f2f1898cc7ebe2b1313d69"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.8/stardrive_0.1.8_linux_arm64.tar.gz"
      sha256 "bd1718915e95f292a9c3b7476a25c1e40c2543bc5e5ec1ce50828a4a2d6a1708"
    end

    on_intel do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.8/stardrive_0.1.8_linux_amd64.tar.gz"
      sha256 "5ca3df0740111a7b64dcada7d1121912a8e53d9f5e7ae039d4750d6b3a358089"
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
