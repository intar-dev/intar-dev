//! The suspended guest of a machine image, prepared into its template.
//!
//! A base's RAM file is assembled once per host from its chunk blobs into
//! the root-owned store `ram/<sha256>.ram`, and the template's `ram` is a
//! clone of it. A pack's `ram` is its base's store file with the pack's
//! delta applied; the delta is registry content, so the apply runs in the
//! sandbox of [`crate::wake_apply`], and its output counts for nothing until
//! its SHA-256 is the one the pack names.

use super::*;

use std::os::unix::fs::{FileExt as _, MetadataExt as _};

use intar_contracts::catalog::IMAGE_CHUNK_SIZE_BYTES;
use intar_jailer_protocol::{WAKE_CPU_PROFILE_FILE, WAKE_RAM_FILE, WAKE_STUB_FILE, WakeArtifacts};

/// A pack's apply rewrites at most 64 GiB of mostly sparse RAM.
const WAKE_APPLY_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// The helper's buffers (two threads, two at most 256 MiB each) and zstd.
const WAKE_APPLY_MEMORY_MAX_BYTES: u64 = 1536 * 1024 * 1024;

/// Prepare `ram`, `stub` and `cpu-profile.json` into `template`, the
/// unpublished template directory.
pub(super) fn prepare_wake_files(
    config: &JailerdConfig,
    wake: &VerifiedWake,
    chunk_cache: &OwnedFd,
    template: &Path,
    lane: &PrepareLane,
) -> Result<ImageTemplateWakeV1> {
    let stub = copy_wake_layer(
        config,
        chunk_cache,
        &wake.stub,
        &template.join(WAKE_STUB_FILE),
        lane,
    )?;
    let cpu_profile = copy_wake_layer(
        config,
        chunk_cache,
        &wake.cpu_profile,
        &template.join(WAKE_CPU_PROFILE_FILE),
        lane,
    )?;
    let store = ensure_ram_store(config, chunk_cache, wake, lane)?;
    let ram_path = template.join(WAKE_RAM_FILE);
    let ram_sha256 = match &wake.pack {
        None => {
            stage_prepared_template_source_file(store, &ram_path, 0o400)?;
            wake.ram_sha256.clone()
        }
        Some((deltas, ram_sha256)) => {
            drop(store);
            apply_pack(
                config,
                chunk_cache,
                wake,
                deltas,
                ram_sha256,
                template,
                lane,
            )?;
            ram_sha256.clone()
        }
    };
    let ram = File::open(&ram_path)?;
    Ok(ImageTemplateWakeV1 {
        ram_store_sha256: Sha256Digest::parse(wake.ram_sha256.clone())?,
        ram: root_template_artifact(&ram, &ram_sha256, wake.ram_size_bytes)?,
        stub,
        cpu_profile,
    })
}

/// The wake files of a published template are the ones its metadata names.
pub(super) fn validate_wake_template(
    image_directory: &OwnedFd,
    wake: &ImageTemplateWakeV1,
) -> Result<()> {
    for (name, expected) in [
        (c"ram" as &CStr, &wake.ram),
        (c"stub", &wake.stub),
        (c"cpu-profile.json", &wake.cpu_profile),
    ] {
        let file = open_lifecycle_entry_at(image_directory, name, OFlags::RDONLY)?;
        validate_template_artifact_stat(
            &rustix::fs::fstat(&file)?,
            expected,
            "wake template file",
        )?;
    }
    Ok(())
}

pub(super) fn wake_artifacts(image_id: &Sha256Digest, wake: &ImageTemplateWakeV1) -> WakeArtifacts {
    WakeArtifacts {
        ram: template_artifact_source(
            image_id,
            WAKE_RAM_FILE,
            &wake.ram.sha256,
            ArtifactAccess::ReadWrite,
        ),
        stub: template_artifact_source(
            image_id,
            WAKE_STUB_FILE,
            &wake.stub.sha256,
            ArtifactAccess::ReadOnly,
        ),
        cpu_profile: template_artifact_source(
            image_id,
            WAKE_CPU_PROFILE_FILE,
            &wake.cpu_profile.sha256,
            ArtifactAccess::ReadOnly,
        ),
    }
}

/// The base's RAM file in the host store, assembling it on first use.
fn ensure_ram_store(
    config: &JailerdConfig,
    chunk_cache: &OwnedFd,
    wake: &VerifiedWake,
    lane: &PrepareLane,
) -> Result<File> {
    let jail_root = trusted_jail_root_fd(config)?;
    let store = ensure_root_directory_at(&jail_root, c"ram")?;
    let name = format!("{}.ram", wake.ram_sha256);
    let lock = rustix::fs::openat(
        &store,
        format!(".lock-{}", wake.ram_sha256),
        OFlags::RDWR | OFlags::CREATE | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::RUSR | Mode::WUSR,
    )?;
    rustix::fs::flock(&lock, rustix::fs::FlockOperation::LockExclusive)?;
    if let Ok(existing) = open_ram_store(&store, &name, wake.ram_size_bytes) {
        return Ok(existing);
    }
    let temporary = format!(".ram-{}", Uuid::new_v4());
    let file = File::from(rustix::fs::openat(
        &store,
        temporary.as_str(),
        OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::RUSR | Mode::WUSR,
    )?);
    let operation = (|| -> Result<()> {
        assemble_ram(config, chunk_cache, wake, &file, lane)?;
        rustix::fs::fchmod(&file, Mode::RUSR)?;
        rustix::fs::fchown(
            &file,
            Some(rustix::process::Uid::ROOT),
            Some(rustix::process::Gid::ROOT),
        )?;
        rustix::fs::renameat(&store, temporary.as_str(), &store, name.as_str())?;
        rustix::fs::fsync(&store)?;
        Ok(())
    })();
    if operation.is_err() {
        let _ = rustix::fs::unlinkat(&store, temporary.as_str(), rustix::fs::AtFlags::empty());
    }
    operation?;
    open_ram_store(&store, &name, wake.ram_size_bytes)
}

/// A store file is trusted by its root-owned identity; its content was
/// hashed when it was assembled.
fn open_ram_store(store: &OwnedFd, name: &str, size_bytes: u64) -> Result<File> {
    let file = File::from(rustix::fs::openat(
        store,
        name,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )?);
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.uid() == 0
            && metadata.gid() == 0
            && metadata.nlink() == 1
            && metadata.mode() & 0o777 == 0o400
            && metadata.len() == size_bytes,
        "root-owned wake RAM store file is invalid"
    );
    Ok(file)
}

/// Write the RAM file sparsely into the empty `file`: every chunk from its
/// blob, verified as a disk chunk is, at its offset; holes stay holes. The
/// whole file must then hash to the base's RAM digest.
pub(super) fn assemble_ram(
    config: &JailerdConfig,
    chunk_cache: &OwnedFd,
    wake: &VerifiedWake,
    file: &File,
    lane: &PrepareLane,
) -> Result<()> {
    ensure!(
        file.metadata()?.len() == 0,
        "wake RAM assembly needs an empty file"
    );
    file.set_len(wake.ram_size_bytes)?;
    for chunk in &wake.ram_chunks {
        let raw = read_verified_chunk(config, chunk_cache, chunk)?;
        file.write_all_at(
            &raw,
            u64::from(chunk.index) * u64::from(IMAGE_CHUNK_SIZE_BYTES),
        )?;
        lane.charge(raw.len() as u64)?;
    }
    file.sync_all()?;
    ensure!(
        file_sha256(file)? == wake.ram_sha256,
        "assembled wake RAM SHA-256 mismatch"
    );
    Ok(())
}

/// Rebuild a pack's RAM file into `template/ram` from the base's store file
/// and the delta parts, applied by the sandboxed helper.
fn apply_pack(
    config: &JailerdConfig,
    chunk_cache: &OwnedFd,
    wake: &VerifiedWake,
    deltas: &[WakeLayer],
    ram_sha256: &str,
    template: &Path,
    lane: &PrepareLane,
) -> Result<()> {
    let delta_path = template.join(".delta");
    let ram_path = template.join(WAKE_RAM_FILE);
    let store_path = config
        .jail_root
        .join("ram")
        .join(format!("{}.ram", wake.ram_sha256));
    let operation = (|| -> Result<File> {
        let mut delta = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o400)
            .open(&delta_path)?;
        for part in deltas {
            append_verified_blob(config, chunk_cache, part, &mut delta, lane)?;
        }
        drop(delta);
        let out = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&ram_path)?;
        crate::wake_apply::apply_snapdelta_sandboxed(
            &config.jailer_binary,
            &store_path,
            &delta_path,
            &ram_path,
            WAKE_APPLY_TIMEOUT,
            WAKE_APPLY_MEMORY_MAX_BYTES,
        )
        .context("apply the wake pack's RAM delta in the sandbox")?;
        Ok(out)
    })();
    let _ = std::fs::remove_file(&delta_path);
    let out = operation?;
    // The helper's output is untrusted until its digest matches.
    let metadata = out.metadata()?;
    ensure!(
        metadata.is_file() && metadata.nlink() == 1 && metadata.len() == wake.ram_size_bytes,
        "wake pack RAM has the wrong shape"
    );
    ensure!(
        file_sha256(&out)? == ram_sha256,
        "wake pack RAM SHA-256 mismatch"
    );
    out.sync_all()?;
    rustix::fs::fchmod(&out, Mode::RUSR)?;
    rustix::fs::fchown(
        &out,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    Ok(())
}

/// Copy a whole layer from the blob cache into a new root-owned template
/// file.
fn copy_wake_layer(
    config: &JailerdConfig,
    chunk_cache: &OwnedFd,
    layer: &WakeLayer,
    destination: &Path,
    lane: &PrepareLane,
) -> Result<ImageTemplateArtifactV2> {
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(destination)?;
    append_verified_blob(config, chunk_cache, layer, &mut output, lane)?;
    output.sync_all()?;
    rustix::fs::fchmod(&output, Mode::RUSR)?;
    rustix::fs::fchown(
        &output,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    root_template_artifact(&output, &layer.sha256, layer.size_bytes)
}

/// Append a trusted blob to `output`, checking its size and digest over
/// exactly the bytes written.
fn append_verified_blob(
    config: &JailerdConfig,
    chunk_cache: &OwnedFd,
    layer: &WakeLayer,
    output: &mut File,
    lane: &PrepareLane,
) -> Result<()> {
    let mut input = trusted_blob(config, chunk_cache, &layer.sha256, layer.size_bytes)?.0;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; IMAGE_CHUNK_SIZE_BYTES as usize];
    let mut bytes = 0_u64;
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        bytes = bytes.saturating_add(read as u64);
        ensure!(
            bytes <= layer.size_bytes,
            "wake layer grew while being read"
        );
        hasher.update(&buffer[..read]);
        output.write_all(&buffer[..read])?;
        lane.charge(read as u64)?;
    }
    ensure!(
        bytes == layer.size_bytes && hex_digest(hasher) == layer.sha256,
        "wake layer hash or size mismatch"
    );
    Ok(())
}

fn root_template_artifact(
    file: &File,
    sha256: &str,
    bytes: u64,
) -> Result<ImageTemplateArtifactV2> {
    let stat = rustix::fs::fstat(file)?;
    let artifact = ImageTemplateArtifactV2 {
        sha256: Sha256Digest::parse(sha256.to_owned())?,
        bytes,
        device: stat_device_u64(&stat).context("template file device")?,
        inode: stat.st_ino,
    };
    validate_template_artifact_stat(&stat, &artifact, "prepared wake file")?;
    Ok(artifact)
}

fn file_sha256(file: &File) -> Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; IMAGE_CHUNK_SIZE_BYTES as usize];
    let mut offset = 0_u64;
    loop {
        let read = file.read_at(&mut buffer, offset)?;
        if read == 0 {
            return Ok(hex_digest(hasher));
        }
        hasher.update(&buffer[..read]);
        offset += read as u64;
    }
}

fn hex_digest(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHUNK: usize = IMAGE_CHUNK_SIZE_BYTES as usize;

    fn sha(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hex_digest(hasher)
    }

    struct Cache {
        _directory: tempfile::TempDir,
        fd: OwnedFd,
        config: JailerdConfig,
    }

    /// A blob cache owned by the test's user, who stands in for the agent.
    fn cache(blobs: &[&[u8]]) -> Result<Cache> {
        let directory = tempfile::tempdir()?;
        for blob in blobs {
            std::fs::write(directory.path().join(sha(blob)), blob)?;
        }
        let fd = open(
            directory.path(),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        let config = JailerdConfig {
            agent_uid: rustix::process::getuid().as_raw(),
            agent_gid: rustix::process::getgid().as_raw(),
            ..JailerdConfig::default()
        };
        Ok(Cache {
            _directory: directory,
            fd,
            config,
        })
    }

    fn chunk(index: u32, raw: &[u8], encoded: &[u8]) -> ImageChunk {
        ImageChunk {
            index,
            raw_size_bytes: raw.len() as u32,
            raw_sha256: sha(raw),
            encoded_size_bytes: encoded.len() as u64,
            encoded_sha256: sha(encoded),
        }
    }

    /// A 9 MiB RAM file: chunk 0 full, chunk 1 a zero hole, chunk 2 a 1 MiB
    /// tail.
    fn ram() -> Result<(Vec<u8>, Vec<Vec<u8>>, VerifiedWake)> {
        let first = vec![7_u8; CHUNK];
        let tail = vec![9_u8; CHUNK / 4];
        let mut file = first.clone();
        file.resize(2 * CHUNK, 0);
        file.extend_from_slice(&tail);
        let encoded = vec![
            zstd::encode_all(&first[..], 3)?,
            zstd::encode_all(&tail[..], 3)?,
        ];
        let layer = WakeLayer {
            sha256: "a".repeat(64),
            size_bytes: 1,
        };
        let wake = VerifiedWake {
            ram_size_bytes: file.len() as u64,
            ram_sha256: sha(&file),
            ram_chunks: vec![chunk(0, &first, &encoded[0]), chunk(2, &tail, &encoded[1])],
            stub: layer,
            cpu_profile: WakeLayer {
                sha256: "b".repeat(64),
                size_bytes: 1,
            },
            pack: None,
        };
        Ok((file, encoded, wake))
    }

    fn assemble(cache: &Cache, wake: &VerifiedWake) -> Result<Vec<u8>> {
        let mut output = tempfile::tempfile()?;
        let lane = PrepareLane::claim(RequestClass::Foreground)?;
        assemble_ram(&cache.config, &cache.fd, wake, &output, &lane)?;
        let mut bytes = Vec::new();
        output.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    #[test]
    fn ram_is_assembled_from_its_chunks_with_a_hole_and_a_short_tail() -> Result<()> {
        let (expected, encoded, wake) = ram()?;
        let cache = cache(&[&encoded[0], &encoded[1]])?;
        assert_eq!(assemble(&cache, &wake)?, expected);
        Ok(())
    }

    #[test]
    fn ram_assembly_refuses_a_wrong_chunk_or_whole_file_hash() -> Result<()> {
        let (_, encoded, wake) = ram()?;
        let cache = cache(&[&encoded[0], &encoded[1]])?;

        let mut wrong_chunk = ram()?.2;
        wrong_chunk.ram_chunks[1].raw_sha256 = "c".repeat(64);
        let error = assemble(&cache, &wrong_chunk).expect_err("a wrong chunk hash");
        assert!(format!("{error:#}").contains("decoded image chunk hash"));

        let mut wrong_file = wake;
        wrong_file.ram_sha256 = "c".repeat(64);
        let error = assemble(&cache, &wrong_file).expect_err("a wrong file hash");
        assert!(format!("{error:#}").contains("assembled wake RAM SHA-256 mismatch"));

        // A blob missing from the cache fails too.
        let (_, _, wake) = ram()?;
        let empty = self::cache(&[&encoded[0]])?;
        assert!(assemble(&empty, &wake).is_err());
        Ok(())
    }

    #[test]
    fn a_launch_wakes_only_its_own_image() -> Result<()> {
        let image = Sha256Digest::parse("a".repeat(64))?;
        let other = Sha256Digest::parse("b".repeat(64))?;
        let file = |name, access| template_artifact_source(&image, name, &image, access);
        let agent = ArtifactSource {
            source_root: 0,
            relative_path: PathBuf::from("runtime.raw"),
            sha256: None,
            access: ArtifactAccess::ReadOnly,
        };
        let template = ImageTemplateArtifactV2 {
            sha256: image.clone(),
            bytes: 1,
            device: 1,
            inode: 1,
        };
        let wake = ImageTemplateWakeV1 {
            ram_store_sha256: image.clone(),
            ram: template.clone(),
            stub: template.clone(),
            cpu_profile: template,
        };
        let mut artifacts = SourceArtifacts {
            kernel: file("kernel", ArtifactAccess::ReadOnly),
            initrd: None,
            root_disk: file("root.raw", ArtifactAccess::ReadWrite),
            runtime_disk: agent.clone(),
            recording_disk: agent,
            wake: Some(wake_artifacts(&image, &wake)),
        };
        validate_template_launch_sources(&artifacts)?;
        if let Some(wake) = artifacts.wake.as_mut() {
            wake.stub = template_artifact_source(&other, "stub", &other, ArtifactAccess::ReadOnly);
        }
        assert!(validate_template_launch_sources(&artifacts).is_err());
        Ok(())
    }

    /// The whole pack path on a real host: the base's RAM store assembled,
    /// the two delta parts joined, the apply run in the sandbox, its output
    /// checked. Needs root, systemd >= 253, Landlock ABI 3 and an
    /// `intar-jailer` the dynamic user can execute, at
    /// `INTAR_SNAPDELTA_TEST_JAILER`.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "needs root, systemd and a reachable intar-jailer"]
    fn a_pack_is_prepared_through_the_sandbox() -> Result<()> {
        let page = |byte: u8| vec![byte; 4096];
        let base = [page(1), page(2), page(3), page(4)].concat();
        let fork = [page(1), page(0), page(7), page(8)].concat();
        let delta = crate::wake_apply::tests::delta_for(&base, &fork)?;
        let (first, second) = delta.split_at(delta.len() / 2);
        let encoded = zstd::encode_all(&base[..], 3)?;
        let (stub, profile) = (b"stub".as_slice(), b"{}".as_slice());
        let cache = cache(&[&encoded, first, second, stub, profile])?;
        let jail_root = tempfile::tempdir()?;
        let config = JailerdConfig {
            jail_root: jail_root.path().to_owned(),
            jailer_binary: PathBuf::from(std::env::var("INTAR_SNAPDELTA_TEST_JAILER")?),
            ..cache.config.clone()
        };
        let layer = |bytes: &[u8]| WakeLayer {
            sha256: sha(bytes),
            size_bytes: bytes.len() as u64,
        };
        let wake = |ram_sha256: String| VerifiedWake {
            ram_size_bytes: base.len() as u64,
            ram_sha256: sha(&base),
            ram_chunks: vec![chunk(0, &base, &encoded)],
            stub: layer(stub),
            cpu_profile: layer(profile),
            pack: Some((vec![layer(first), layer(second)], ram_sha256)),
        };
        let lane = PrepareLane::claim(RequestClass::Foreground)?;
        let template = jail_root.path().join("templates/.prepare-test");
        std::fs::create_dir_all(&template)?;

        let prepared = prepare_wake_files(&config, &wake(sha(&fork)), &cache.fd, &template, &lane)?;
        assert_eq!(std::fs::read(template.join("ram"))?, fork);
        assert_eq!(prepared.ram.sha256.as_str(), sha(&fork));
        assert_eq!(prepared.ram_store_sha256.as_str(), sha(&base));
        assert!(!template.join(".delta").exists());
        let store = jail_root.path().join(format!("ram/{}.ram", sha(&base)));
        assert_eq!(std::fs::read(&store)?, base);
        for path in [store, template.join("ram"), template.join("stub")] {
            let metadata = std::fs::metadata(&path)?;
            assert_eq!((metadata.uid(), metadata.mode() & 0o777), (0, 0o400));
        }

        // An output that is not the pack's RAM is refused.
        let other = jail_root.path().join("templates/.prepare-other");
        std::fs::create_dir_all(&other)?;
        let error = prepare_wake_files(&config, &wake(sha(&base)), &cache.fd, &other, &lane)
            .expect_err("a wrong pack digest");
        assert!(format!("{error:#}").contains("wake pack RAM SHA-256 mismatch"));
        Ok(())
    }

    /// A published template gains its wake files on a `prepare_wake`
    /// request, keeping its root disk and kernel; a cold prepare needs no
    /// wake layer; an image without `wake` cannot be prepared with it. The
    /// disk has no chunks, so no reflink is needed. Needs what
    /// [`a_pack_is_prepared_through_the_sandbox`] needs.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "needs root, systemd and a reachable intar-jailer"]
    fn a_template_gains_its_wake_files_under_its_lock() -> Result<()> {
        use intar_jailer_protocol::TrustedDirectorySource;

        let page = |byte: u8| vec![byte; 4096];
        let base = [page(1), page(2), page(3), page(4)].concat();
        let fork = [page(1), page(0), page(7), page(8)].concat();
        let delta = crate::wake_apply::tests::delta_for(&base, &fork)?;
        let (first, second) = delta.split_at(delta.len() / 2);
        let ram_chunk = zstd::encode_all(&base[..], 3)?;
        let (kernel, stub, profile) = (b"kernel".as_slice(), b"stub".as_slice(), b"{}".as_slice());

        let sources = tempfile::tempdir()?;
        std::fs::create_dir(sources.path().join("blobs"))?;
        let put =
            |bytes: &[u8]| std::fs::write(sources.path().join("blobs").join(sha(bytes)), bytes);
        put(kernel)?;
        let descriptor = |media: &str, bytes: &[u8]| serde_json::json!({"mediaType": media, "digest": format!("sha256:{}", sha(bytes)), "size": bytes.len()});
        // Writes the config and manifest; returns the request for them.
        let image = |wake: bool| -> Result<PrepareChunkedImageV3Request> {
            let mut machine = serde_json::json!({
                "guest_contract": 3, "image_format": "intar-image-3",
                "build_key": format!("sha256:{}", "b".repeat(64)),
                "boot": {"cmdline": "console=ttyS0"},
                "disk": {"size_bytes": 4 << 20, "chunk_size": 4 << 20, "chunks": []},
            });
            let mut layers = vec![descriptor("application/vnd.intar.kernel.v1", kernel)];
            if wake {
                machine["wake"] = serde_json::json!({
                    "ram": {"size_bytes": base.len(), "chunk_size": 4 << 20,
                            "chunks": [[0, 1, sha(&base)]], "sha256": sha(&base)},
                    "pack": {"base": format!("sha256:{}", "9".repeat(64)), "ram_sha256": sha(&fork)},
                    "shape": {"memory_bytes": base.len(), "boot_vcpus": 1, "max_vcpus": 2, "balloon": true},
                    "cpu_profile": format!("sha256:{}", sha(profile)),
                    "vmm": {"min_version": "v50.0", "built_with": "v50.0"},
                    "booted_at_unix_ms": 1,
                });
                layers.extend([
                    descriptor("application/vnd.intar.wake.ram.chunk.v1+zstd", &ram_chunk),
                    descriptor("application/vnd.intar.wake.stub.v1", stub),
                    descriptor("application/vnd.intar.wake.cpu-profile.v1+json", profile),
                    descriptor("application/vnd.intar.wake.delta.v1", first),
                    descriptor("application/vnd.intar.wake.delta.v1", second),
                ]);
            }
            let config = serde_json::to_vec(&machine)?;
            let manifest = serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "artifactType": "application/vnd.intar.machine.v1",
                "config": descriptor("application/vnd.intar.machine.config.v1+json", &config),
                "layers": layers,
            }))?;
            let source = |name: &str, bytes: &[u8]| -> Result<ArtifactSource> {
                std::fs::write(sources.path().join(name), bytes)?;
                Ok(ArtifactSource {
                    source_root: 0,
                    relative_path: PathBuf::from(name),
                    sha256: Some(Sha256Digest::parse(sha(bytes))?),
                    access: ArtifactAccess::ReadOnly,
                })
            };
            let tag = if wake { "wake" } else { "cold" };
            Ok(PrepareChunkedImageV3Request {
                image_id: Sha256Digest::parse(sha(&manifest))?,
                chunk_manifest_sha256: Sha256Digest::parse(sha(&config))?,
                virtual_size_bytes: 4 << 20,
                image_manifest: source(&format!("{tag}-manifest.json"), &manifest)?,
                manifest: source(&format!("{tag}-config.json"), &config)?,
                chunk_cache_root: TrustedDirectorySource {
                    source_root: 0,
                    relative_path: PathBuf::from("blobs"),
                },
                kernel: ArtifactSource {
                    source_root: 0,
                    relative_path: PathBuf::from("blobs").join(sha(kernel)),
                    sha256: Some(Sha256Digest::parse(sha(kernel))?),
                    access: ArtifactAccess::ReadOnly,
                },
                initrd: None,
                request_class: RequestClass::Foreground,
                prepare_wake: false,
            })
        };
        let jail_root = tempfile::tempdir()?;
        let config = JailerdConfig {
            jail_root: jail_root.path().to_owned(),
            jailer_binary: PathBuf::from(std::env::var("INTAR_SNAPDELTA_TEST_JAILER")?),
            allowed_source_roots: vec![sources.path().to_owned()],
            ..JailerdConfig::default()
        };
        let lane = PrepareLane::claim(RequestClass::Foreground)?;
        let template = |request: &PrepareChunkedImageV3Request| {
            jail_root
                .path()
                .join("templates")
                .join(request.image_id.as_str())
        };
        let identity = |path: PathBuf| std::fs::metadata(path).map(|m| (m.dev(), m.ino()));

        // Cold: no wake layer is in the cache yet.
        let mut request = image(true)?;
        let cold = crate::prepare_chunked_image_template(&config, &request, &lane)?;
        assert!(cold.wake.is_none());
        let before = (
            identity(template(&request).join("root.raw"))?,
            identity(template(&request).join("kernel"))?,
        );

        for blob in [&ram_chunk[..], stub, profile, first, second] {
            put(blob)?;
        }
        request.prepare_wake = true;
        let warm = crate::prepare_chunked_image_template(&config, &request, &lane)?;
        assert!(warm.wake.is_some());
        assert_eq!(
            (warm.root_disk.clone(), warm.kernel.clone()),
            (cold.root_disk, cold.kernel)
        );
        assert_eq!(std::fs::read(template(&request).join("ram"))?, fork);
        assert_eq!(
            before,
            (
                identity(template(&request).join("root.raw"))?,
                identity(template(&request).join("kernel"))?,
            )
        );
        // A template with its wake files satisfies a cold request too.
        request.prepare_wake = false;
        assert_eq!(
            crate::prepare_chunked_image_template(&config, &request, &lane)?,
            warm
        );

        let mut plain = image(false)?;
        plain.prepare_wake = true;
        let error = crate::prepare_chunked_image_template(&config, &plain, &lane)
            .expect_err("no wake to prepare");
        assert!(format!("{error:#}").contains("carries no suspended guest"));
        assert!(!template(&plain).exists());
        Ok(())
    }

    #[test]
    fn layers_are_copied_only_with_their_size_and_digest() -> Result<()> {
        let blob = b"stub bytes".as_slice();
        let cache = cache(&[blob])?;
        let lane = PrepareLane::claim(RequestClass::Foreground)?;
        let good = WakeLayer {
            sha256: sha(blob),
            size_bytes: blob.len() as u64,
        };
        let mut output = tempfile::tempfile()?;
        append_verified_blob(&cache.config, &cache.fd, &good, &mut output, &lane)?;
        assert_eq!(file_sha256(&output)?, sha(blob));

        let short = WakeLayer {
            size_bytes: blob.len() as u64 - 1,
            ..good
        };
        let mut output = tempfile::tempfile()?;
        assert!(
            append_verified_blob(&cache.config, &cache.fd, &short, &mut output, &lane).is_err()
        );
        Ok(())
    }
}
