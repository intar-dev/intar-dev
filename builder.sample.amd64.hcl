qemu {
  target_arch       = "amd64"
  qemu_binary       = "qemu-system-x86_64"
  mmdebstrap_binary = "mmdebstrap"
  mke2fs_binary     = "mke2fs"
  e2fsck_binary     = "e2fsck"
  resize2fs_binary  = "resize2fs"
  ssh_wait_timeout_seconds = 1200
  provision_timeout_seconds = 2400
  qemu_exit_timeout_seconds = 300
  accelerator       = "kvm"
  qemuargs          = []
  build_cpus        = 4
  build_memory_mb = 4096
  output_root     = "dist"
  work_root       = ".work"
}

upload {
  enabled = false
  url     = "https://intar.dev/registry/v1/publish"
}
