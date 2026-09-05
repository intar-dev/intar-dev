use super::*;

#[test]
fn direct_render_writes_build_inputs() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());

    assert!(
        rendered
            .paths
            .output_chunk_manifest_path
            .ends_with("dist/broken-nginx-web-amd64.chunks.json")
    );
    assert!(
        rendered
            .paths
            .output_metadata_path
            .ends_with("dist/broken-nginx-web-amd64.manifest.json")
    );
    assert!(
        rendered
            .paths
            .root_disk_path
            .ends_with(".work/qemu/broken-nginx/web/root.raw")
    );
    assert!(
        rendered
            .paths
            .build_log_path
            .ends_with(".work/qemu/broken-nginx/web/build.log")
    );
    assert!(
        rendered
            .paths
            .seed_disk_path
            .ends_with(".work/qemu/broken-nginx/web/intarbuild.img")
    );
    assert!(rendered.paths.work_root.join("stage-packages.sh").is_file());
    assert!(rendered.paths.disk_commands_path.is_file());
    assert_eq!(rendered.disk.root_disk_path, rendered.paths.root_disk_path);
    assert_eq!(
        rendered.disk.base_ext4_path,
        rendered.base_rootfs.paths.base_ext4_path
    );
    assert_eq!(rendered.disk.virtual_size_bytes, 10 * 1024 * 1024 * 1024);
    assert!(rendered.ssh_host_port > 0);
    assert!(!rendered.paths.work_root.join("build.pkr.hcl").exists());
}

#[test]
fn direct_prepare_writes_root_disk_and_intarbuild_seed() {
    let directory = tempdir().unwrap();
    let true_binary = std::path::PathBuf::from("/usr/bin/true");
    let scenario = intar_image_scenario::Scenario::parse_course(
        r#"
scenario "broken-nginx" {
  solution { body = "Start nginx." }

  image "debian-13-minimal" {
base = "trixie"
  }

  kino {
probe "svc" {
  kind = "service"
  service = "nginx"
  state = "running"
  description = "Nginx"
}
  }

  vm "web" {
image = "debian-13-minimal"
probes = ["svc"]
disk = 1
  }
}
"#,
    )
    .unwrap();
    let catalog = intar_image_scenario::BaseImageCatalog::parse(
        r#"
base_image "trixie" {
  suite          = "trixie"
  mirror         = "https://deb.debian.org/debian"
  arch           = "amd64"
  kernel_package = "linux-image-cloud-amd64"
  packages       = ["openssh-server", "ca-certificates", "sudo", "zstd"]
}
"#,
    )
    .unwrap();
    let rendered = render_direct_build(&DirectBuildRequest {
        scenario,
        lecture: test_lecture(),
        vm_name: "web".to_string(),
        config: QemuBuildConfig {
            output_root: directory.path().join("dist"),
            work_root: directory.path().join(".work"),
            e2fsck_binary: true_binary.clone(),
            resize2fs_binary: true_binary,
            ..QemuBuildConfig::default()
        },
        base_image: catalog.base_image_by_name("trixie").unwrap().clone(),
    })
    .unwrap();
    std::fs::create_dir_all(rendered.disk.base_ext4_path.parent().unwrap()).unwrap();
    std::fs::write(&rendered.disk.base_ext4_path, "base").unwrap();

    prepare_direct_build_inputs(&DirectBuildPrepareInput {
        rendered: &rendered,
        build_public_key_openssh: "ssh-ed25519 AAAATEST intar-build",
    })
    .unwrap();

    assert!(rendered.paths.root_disk_path.is_file());
    assert_eq!(
        std::fs::metadata(&rendered.paths.root_disk_path)
            .unwrap()
            .len(),
        1024 * 1024 * 1024
    );
    assert!(rendered.paths.seed_disk_path.is_file());
}
