class Stardrive < Formula
  desc "Manage Hetzner-hosted Talos clusters with Infisical-backed GitOps"
  homepage "https://github.com/intar-dev/intar-dev/tree/main/projects/stardrive"
  version "0.1.5"

  on_macos do
    on_arm do
      url "https://github.com/intar-dev/stardrive/releases/download/v0.1.5/stardrive_0.1.5_darwin_arm64.tar.gz"
      sha256 "297c7fee394f0af2b5e837b35163f701cfd0189c56348dd6fcf10d2731f771ea"
    end

    on_intel do
      url "https://github.com/intar-dev/stardrive/releases/download/v0.1.5/stardrive_0.1.5_darwin_amd64.tar.gz"
      sha256 "4e5790ded8e38728fa3c8d802034359affd853a83dd35428c4cdb6dcccf937f6"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/intar-dev/stardrive/releases/download/v0.1.5/stardrive_0.1.5_linux_arm64.tar.gz"
      sha256 "928ae1d4dcc3c124251c4a4c2c737c12413af3de16832556396a4dad0d673208"
    end

    on_intel do
      url "https://github.com/intar-dev/stardrive/releases/download/v0.1.5/stardrive_0.1.5_linux_amd64.tar.gz"
      sha256 "3fe1e4f08537f55966443c282a02fb8df6ad7e6e5f2ddf20eb2a16cbe5083218"
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
