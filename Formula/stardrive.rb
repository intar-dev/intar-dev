class Stardrive < Formula
  desc "Manage Hetzner-hosted Talos clusters with Infisical-backed GitOps"
  homepage "https://github.com/intar-dev/intar-dev/tree/main/projects/stardrive"
  version "0.1.10"

  on_macos do
    on_arm do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.10/stardrive_0.1.10_darwin_arm64.tar.gz"
      sha256 "26a5735dec8feb08cedc2dfdcc6bc12ab74e094d790f67f54816bd78151a40d7"
    end

    on_intel do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.10/stardrive_0.1.10_darwin_amd64.tar.gz"
      sha256 "6e73dea9a21208e106ad864a1bbf2594ac3bf6c4fc88714f6296c0bff6f224b6"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.10/stardrive_0.1.10_linux_arm64.tar.gz"
      sha256 "a315251d0f4f85d1a773a5288c69ae123ee1cd2e13ad50ccd06a8728bf930cc5"
    end

    on_intel do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.10/stardrive_0.1.10_linux_amd64.tar.gz"
      sha256 "42b0f7ed69c2b8f9c0637c6c36c956d707beab751aadc96145160e7468b82938"
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
