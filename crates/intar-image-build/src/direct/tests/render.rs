use super::*;
use crate::{RawDirectBuild, ReusedEncodedImageChunk, finish_direct_build_from_scan};

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
fn direct_render_blocks_colliding_work_and_output_paths() {
    let directory = tempdir().unwrap();
    let config = QemuBuildConfig::default();
    let request = test_direct_build_request(
        config.clone(),
        directory.path().join("work-a"),
        directory.path().join("dist"),
        "broken-nginx",
        "web",
    );
    let rendered = render_direct_build(&request).unwrap();
    let stage_path = rendered.paths.work_root.join("stage-packages.sh");
    std::fs::write(&stage_path, "held by first render\n").unwrap();

    let work_error = render_direct_build(&request).unwrap_err();
    assert!(format!("{work_error:#}").contains("direct build is busy: work directory"));
    assert_eq!(
        std::fs::read_to_string(&stage_path).unwrap(),
        "held by first render\n"
    );

    let same_output_different_work = test_direct_build_request(
        config,
        directory.path().join("work-b"),
        directory.path().join("dist"),
        "broken-nginx",
        "web",
    );
    let output_error = render_direct_build(&same_output_different_work).unwrap_err();
    assert!(format!("{output_error:#}").contains("direct build is busy: output stem"));
}

#[test]
fn direct_render_allows_distinct_vm_paths() {
    let directory = tempdir().unwrap();
    let config = QemuBuildConfig::default();
    let web = test_direct_build_request(
        config.clone(),
        directory.path().join("work"),
        directory.path().join("dist"),
        "broken-nginx",
        "web",
    );
    let worker = test_direct_build_request(
        config,
        directory.path().join("work"),
        directory.path().join("dist"),
        "broken-nginx",
        "worker",
    );

    let web = render_direct_build(&web).unwrap();
    let worker = render_direct_build(&worker).unwrap();
    assert_ne!(web.paths.work_root, worker.paths.work_root);
    assert_ne!(web.paths.output_chunks_dir, worker.paths.output_chunks_dir);
}

#[test]
fn direct_render_releases_locks_after_the_last_clone_drops() {
    let directory = tempdir().unwrap();
    let request = test_direct_build_request(
        QemuBuildConfig::default(),
        directory.path().join("work"),
        directory.path().join("dist"),
        "broken-nginx",
        "web",
    );
    let rendered = render_direct_build(&request).unwrap();
    let clone = rendered.clone();
    let work_lock = rendered.paths.work_root.join(WORK_LOCK_FILENAME);
    let output_lock = rendered.paths.output_chunks_dir.with_extension("lock");

    drop(rendered);
    assert!(render_direct_build(&request).is_err());
    drop(clone);

    assert!(work_lock.is_file());
    assert!(output_lock.is_file());
    render_direct_build(&request).unwrap();
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

#[cfg(unix)]
#[test]
fn finalization_rejects_a_timed_out_raw_view_after_reuse_only_encoding() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
    let source = rendered.paths.work_root.join("active.qcow2");
    let root_disk = rendered.paths.root_disk_path.clone();
    std::fs::write(&source, b"private qcow source").unwrap();
    std::fs::write(&root_disk, b"raw image bytes").unwrap();
    for path in [
        &rendered.base_rootfs.paths.kernel_path,
        &rendered.base_rootfs.paths.initrd_path,
    ] {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"boot artifact").unwrap();
    }
    let scan = crate::scan_raw_image_chunks(&root_disk).unwrap();
    let raw_build = RawDirectBuild {
        raw_view: crate::direct::raw_view::test_guard(
            source.clone(),
            rendered.paths.root_disk_path.clone(),
            true,
        ),
        rendered,
    };

    let reused = scan
        .chunks
        .iter()
        .map(|chunk| {
            (
                chunk.raw_sha256.clone(),
                ReusedEncodedImageChunk {
                    raw_sha256: chunk.raw_sha256.clone(),
                    raw_size_bytes: chunk.raw_size_bytes,
                    encoded_sha256: "a".repeat(64),
                    encoded_size_bytes: 1,
                },
            )
        })
        .collect();
    let error = finish_direct_build_from_scan(raw_build, &scan, &reused).unwrap_err();

    let error = format!("{error:#}");
    assert!(error.contains("image-read deadline expired"));
    assert!(!error.contains("must not read"));
    assert!(!source.exists());
    assert!(!root_disk.exists());
}
