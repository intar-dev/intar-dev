class Stardrive < Formula
  desc "Manage Hetzner-hosted Talos clusters with Infisical-backed GitOps"
  homepage "https://github.com/intar-dev/intar-dev/tree/main/projects/stardrive"
  version "0.1.9"

  on_macos do
    on_arm do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.9/stardrive_0.1.9_darwin_arm64.tar.gz"
      sha256 "d467b516e8a6e055588d499f3013ecd79ef0ba15e5529bbb169274e93cfa1d5c"
    end

    on_intel do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.9/stardrive_0.1.9_darwin_amd64.tar.gz"
      sha256 "4931e3cad62f4f4cd0c5cd660da333a0cb419c76ca0ef229573734576229ec43"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.9/stardrive_0.1.9_linux_arm64.tar.gz"
      sha256 "d7f47349842772d9d0e46e4107aa3444934df1c3ed58b08973b227b7f5afe5ab"
    end

    on_intel do
      url "https://github.com/intar-dev/intar-dev/releases/download/stardrive%2Fv0.1.9/stardrive_0.1.9_linux_amd64.tar.gz"
      sha256 "847aa452179487c8a1a89e7ca990bb16cdc2fe5a3626f55a4dd6735c8dce17cd"
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
