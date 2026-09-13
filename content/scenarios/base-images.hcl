base_image "trixie" {
  suite          = "trixie"
  mirror         = "https://deb.debian.org/debian"
  arch           = "amd64"
  packages = [
    "acpid",
    "openssh-server",
    "ca-certificates",
    "curl",
    "iproute2",
    "e2fsprogs",
    "kmod",
    "systemd-sysv",
    "udev",
    "sudo",
  ]
}
