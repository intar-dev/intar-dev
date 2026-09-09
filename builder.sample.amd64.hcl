qemu {
  target_arch       = "amd64"
  qemu_binary       = "qemu-system-x86_64"
  qemu_storage_daemon_binary = "qemu-storage-daemon"
  umount_binary = "umount"
  mke2fs_binary     = "mke2fs"
  e2fsck_binary     = "e2fsck"
  resize2fs_binary  = "resize2fs"
  ssh_wait_timeout_seconds = 1200
  provision_timeout_seconds = 2400
  qemu_exit_timeout_seconds = 300
  raw_view_read_timeout_seconds = 1200
  accelerator       = "kvm"
  build_cpus        = 4
  build_memory_mb = 4096
  output_root     = "dist"
  work_root       = ".work"

  layered {
    qemu_img_binary = "qemu-img"
    buildctl_binary = "buildctl"
    umoci_binary = "umoci"
    debian_image = "docker.io/library/debian@sha256:abc9cb88a5587630d7f915f47b23b0668fe250fbfc6457aa4d52b534c1bbf73f"
    oci_cache_root = ".cache/oci"
    checkpoint_cache_root = ".cache/checkpoints"
    use_cache = true
    oci_cache_bytes = 8589934592
    checkpoint_cache_bytes = 42949672960
    minimum_free_bytes = 21474836480
  }
}

upload {
  enabled = false
  url     = "https://intar.dev/registry/v1/publish"
}
