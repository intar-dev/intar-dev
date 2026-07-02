packer {
  target_arch = "amd64"
  binary      = "packer"
  qemu_binary = "qemu-system-x86_64"
  accelerator = "kvm"
  qemuargs    = []
  build_cpus  = 4
  build_memory_mb = 4096
  output_root = "dist"
  work_root   = ".work"
}

upload {
  enabled = true
  url     = "https://intar.dev/registry/v1/publish"
}
