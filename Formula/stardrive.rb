class Stardrive < Formula
  desc "Manage Hetzner-hosted Talos clusters with Infisical-backed GitOps"
  homepage "https://github.com/intar-dev/intar-dev/tree/main/projects/stardrive"
  version "0.1.6"

  on_macos do
    on_arm do
      url "https://github.com/intar-dev/intar-dev/releases/download/v0.1.6/stardrive_0.1.6_darwin_arm64.tar.gz"
      sha256 "0ed9f82f7c20238b87364b9b33a34a61c1b3e59f504f7657b23480a1acb6291d"
    end

    on_intel do
      url "https://github.com/intar-dev/intar-dev/releases/download/v0.1.6/stardrive_0.1.6_darwin_amd64.tar.gz"
      sha256 "c1a7a4136f4cc74a83fc74a4dfb88c53d39d6788abdbe9943a653dbae39a1d61"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/intar-dev/intar-dev/releases/download/v0.1.6/stardrive_0.1.6_linux_arm64.tar.gz"
      sha256 "5fa33b1ba4af2c5ab5d14ed6a9078834463f10673b4ca6a92c28ad9510656bc3"
    end

    on_intel do
      url "https://github.com/intar-dev/intar-dev/releases/download/v0.1.6/stardrive_0.1.6_linux_amd64.tar.gz"
      sha256 "f0e5a6123ea89daecb395860bfc6a112e2385a94c3fea95b6aa597df02b0c76e"
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
