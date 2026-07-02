packer {
  required_plugins {
    qemu = {
      source  = "github.com/hashicorp/qemu"
      version = ">= 1.1.4"
    }
  }
}

variable "source_url" {
  type = string
}

variable "source_checksum" {
  type = string
}

variable "output_directory" {
  type = string
}

variable "ssh_username" {
  type = string
}

variable "ssh_private_key_file" {
  type = string
}

variable "kino_binary" {
  type = string
}

variable "qemu_binary" {
  type = string
}

variable "accelerator" {
  type = string
}

variable "qemuargs" {
  type    = list(list(string))
  default = []
}

variable "cpus" {
  type = number
}

variable "memory" {
  type = number
}

variable "disk_size" {
  type = number
}

variable "skip_compaction" {
  type = bool
}

variable "disk_compression" {
  type = bool
}

variable "provision_script" {
  type = string
}

variable "cd_files" {
  type = list(string)
}

source "qemu" "scenario" {
  accelerator          = var.accelerator
  cd_files             = var.cd_files
  cd_label             = "cidata"
  cpus                 = var.cpus
  disk_image           = true
  disk_size            = var.disk_size
  format               = "qcow2"
  headless             = true
  iso_checksum         = var.source_checksum
  iso_url              = var.source_url
  memory               = var.memory
  output_directory     = var.output_directory
  qemu_binary          = var.qemu_binary
  qemuargs             = var.qemuargs
  shutdown_command     = "sudo shutdown -P now"
  skip_compaction      = var.skip_compaction
  disk_compression     = var.disk_compression
  ssh_private_key_file = var.ssh_private_key_file
  ssh_timeout          = "20m"
  ssh_username         = var.ssh_username
}

build {
  sources = ["source.qemu.scenario"]

  provisioner "file" {
    destination = "/tmp/intar-image-provision.sh"
    source      = var.provision_script
  }

  provisioner "file" {
    destination = "/tmp/kino"
    source      = var.kino_binary
  }

  provisioner "shell" {
    inline = [
      "chmod 0755 /tmp/intar-image-provision.sh",
      "sudo -E /tmp/intar-image-provision.sh",
    ]
  }
}
