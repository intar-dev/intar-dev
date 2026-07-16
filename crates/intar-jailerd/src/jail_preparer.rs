use super::*;

impl JailPreparer for FileSystemJailPreparer {
    fn fast_template_store(&mut self, config: &JailerdConfig) -> bool {
        let prepared = probe_fast_template_store(config).and_then(|attestation| {
            prepare_or_validate_host_template(config).map(|metadata| (metadata, attestation))
        });
        match prepared {
            Ok((metadata, attestation)) => {
                self.host_template = Some(metadata);
                self.fast_store_attestation = Some(attestation);
                true
            }
            Err(error) => {
                tracing::error!(
                    error = %format!("{error:#}"),
                    "fast template-store readiness preparation failed"
                );
                self.host_template = None;
                self.fast_store_attestation = None;
                false
            }
        }
    }

    fn fast_template_store_ready(&self, config: &JailerdConfig) -> bool {
        self.host_template.as_ref().is_some_and(|metadata| {
            validate_host_template(config, metadata).is_ok()
                && self
                    .fast_store_attestation
                    .as_ref()
                    .is_some_and(|attestation| {
                        validate_fast_template_store_attestation(config, attestation).is_ok()
                    })
        })
    }

    fn prepare_image_v2(
        &mut self,
        config: &JailerdConfig,
        request: &PrepareImageV2Request,
    ) -> Result<PreparedImageV2Result> {
        prepare_image_template(config, request)
    }

    fn validate_prepared_launch(
        &mut self,
        config: &JailerdConfig,
        request: &LaunchVmV2Request,
    ) -> Result<()> {
        validate_prepared_launch_template(config, request)
    }

    fn prepare(
        &mut self,
        config: &JailerdConfig,
        request: &VmLaunchRequest,
        run_network: &RunNetworkResult,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<PreparedJail> {
        prepare_jail_files(config, request, run_network, generation, uid, gid, None)
    }

    fn prepare_v2(
        &mut self,
        config: &JailerdConfig,
        request: &VmLaunchRequest,
        run_network: &RunNetworkResult,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<PreparedJail> {
        let metadata = self
            .host_template
            .as_ref()
            .context("root-owned host runtime template is unavailable")?;
        validate_host_template(config, metadata)
            .context("validate pinned host runtime template before V2 launch")?;
        prepare_jail_files(
            config,
            request,
            run_network,
            generation,
            uid,
            gid,
            Some(metadata),
        )
    }

    fn destroy(&mut self, config: &JailerdConfig, generation: &ValidatedId) -> Result<bool> {
        remove_generation_tree(config, generation)
    }

    fn quarantine(&mut self, config: &JailerdConfig, generation: &ValidatedId) -> Result<()> {
        quarantine_generation(config, generation)
    }

    fn grant_agent_runtime_access(
        &mut self,
        config: &JailerdConfig,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<()> {
        grant_agent_api_socket_access(config, generation, uid, gid)
    }

    fn persist(&mut self, config: &JailerdConfig, record: &VmRecord) -> Result<()> {
        if record.schema_version != VM_RECORD_METADATA_VERSION {
            bail!("refusing to persist non-v2 jail metadata")
        }
        let jail_root = trusted_jail_root_fd(config)?;
        let parent = open_optional_root_directory_at(&jail_root, c"cloud-hypervisor")?
            .context("jail generation parent is missing")?;
        let generation_name =
            CString::new(record.generation.as_str()).expect("validated generation contains no NUL");
        let directory = open_lifecycle_entry_at(
            &parent,
            &generation_name,
            OFlags::RDONLY | OFlags::DIRECTORY,
        )
        .context("open jail generation for metadata persistence")?;
        validate_root_directory(&directory, "jail generation")?;

        let destination = c"metadata-v2.json";
        if lifecycle_entry_exists_at(&directory, c"metadata-v1.json")? {
            bail!("legacy jail metadata cannot be overwritten or adopted")
        }
        if let Ok(existing) = open_lifecycle_entry_at(&directory, destination, OFlags::RDONLY) {
            validate_root_regular_file(&existing, "existing jail metadata")?;
        } else {
            match rustix::fs::statat(
                &directory,
                destination,
                rustix::fs::AtFlags::SYMLINK_NOFOLLOW,
            ) {
                Err(error) if error == rustix::io::Errno::NOENT => {}
                Ok(_) => bail!("existing jail metadata is not a trusted regular file"),
                Err(error) => return Err(error).context("inspect existing jail metadata"),
            }
        }

        let temporary = CString::new(format!("metadata-v2.json.tmp-{}", Uuid::new_v4()))
            .expect("UUID temporary name has no NUL");
        let result = (|| -> Result<()> {
            let fd = rustix::fs::openat(
                &directory,
                &temporary,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::RUSR | Mode::WUSR,
            )
            .context("create fd-relative jail metadata")?;
            let mut file = File::from(fd);
            to_writer(&mut file, record).context("serialize jail metadata")?;
            file.write_all(b"\n")?;
            rustix::fs::fchmod(&file, Mode::RUSR | Mode::WUSR)?;
            file.sync_all()?;
            let temporary_stat = rustix::fs::fstat(&file)?;
            validate_root_regular_stat(&temporary_stat, "new jail metadata")?;
            rustix::fs::renameat(&directory, &temporary, &directory, destination)
                .context("publish jail metadata by dirfd")?;
            let published = open_lifecycle_entry_at(&directory, destination, OFlags::RDONLY)?;
            let published_stat = validate_root_regular_file(&published, "published jail metadata")?;
            if !same_lifecycle_object(&temporary_stat, &published_stat) {
                bail!("published jail metadata inode changed during rename")
            }
            rustix::fs::fsync(&directory)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = rustix::fs::unlinkat(&directory, &temporary, rustix::fs::AtFlags::empty());
        }
        result
    }

    fn recover(&mut self, config: &JailerdConfig) -> Result<Vec<VmRecord>> {
        let jail_root = trusted_jail_root_fd(config)?;
        let Some(root) = open_optional_root_directory_at(&jail_root, c"cloud-hypervisor")? else {
            return Ok(Vec::new());
        };
        let mut records = Vec::new();
        for name in lifecycle_directory_names(&root)? {
            let entry_stat =
                rustix::fs::statat(&root, &name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)?;
            if rustix::fs::FileType::from_raw_mode(entry_stat.st_mode)
                != rustix::fs::FileType::Directory
            {
                bail!("unexpected non-directory in jail generation root")
            }
            let generation_fd =
                open_lifecycle_entry_at(&root, &name, OFlags::RDONLY | OFlags::DIRECTORY)
                    .context("open persisted generation beneath pinned root")?;
            let opened_stat = validate_root_directory(&generation_fd, "persisted jail generation")?;
            if !same_lifecycle_object(&entry_stat, &opened_stat) {
                bail!("persisted jail generation changed while being opened")
            }
            let Ok(name_text) = name.to_str() else {
                let destination = CString::new(format!("invalid-{}", Uuid::new_v4()))
                    .expect("UUID quarantine name contains no NUL");
                quarantine_entry_at(&jail_root, &root, &name, &generation_fd, &destination)?;
                continue;
            };
            let Ok(generation) = ValidatedId::parse(name_text.to_owned()) else {
                let destination = CString::new(format!("invalid-{}", Uuid::new_v4()))
                    .expect("UUID quarantine name contains no NUL");
                quarantine_entry_at(&jail_root, &root, &name, &generation_fd, &destination)?;
                continue;
            };
            let recovered = (|| -> Result<VmRecord> {
                if lifecycle_entry_exists_at(&generation_fd, c"metadata-v1.json")? {
                    bail!("legacy v1 jail metadata is not recoverable")
                }
                let bytes = read_root_metadata_at(&generation_fd, c"metadata-v2.json")?;
                let record = decode_vm_record_v2(&bytes)?;
                if record.generation != generation {
                    bail!("persisted generation metadata does not match its directory")
                }
                let root_fd = open_lifecycle_entry_at(
                    &generation_fd,
                    c"root",
                    OFlags::RDONLY | OFlags::DIRECTORY,
                )
                .context("open persisted jail root beneath generation")?;
                let root_stat = validate_root_directory(&root_fd, "persisted jail root")?;
                if record.jail_root_inode != Some(root_stat.st_ino) {
                    bail!("persisted jail-root inode changed")
                }
                Ok(record)
            })();
            match recovered {
                Ok(record) => records.push(record),
                Err(_) => {
                    stop_orphan_generation(&generation)?;
                    if let Some((uid, gid)) = infer_generation_identity_at(&generation_fd, config) {
                        self.reserve_identity(config, &generation, uid, gid)?;
                    }
                    quarantine_entry_at(&jail_root, &root, &name, &generation_fd, &name)?;
                }
            }
        }
        Ok(records)
    }

    fn export_recording(&mut self, config: &JailerdConfig, record: &VmRecord) -> Result<()> {
        export_recording_disk(config, record)
    }

    fn reserve_identity(
        &mut self,
        config: &JailerdConfig,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<()> {
        persist_identity_reservation(config, generation, uid, gid)
    }

    fn release_identity_reservation(
        &mut self,
        config: &JailerdConfig,
        generation: &ValidatedId,
    ) -> Result<()> {
        let Some(directory) = identity_reservation_directory_fd(config, false)? else {
            return Ok(());
        };
        let name = CString::new(format!("{}.json", generation.as_str()))
            .expect("validated reservation name contains no NUL");
        let reservation = match open_lifecycle_entry_at(&directory, &name, OFlags::RDONLY) {
            Ok(fd) => fd,
            Err(error) if error == rustix::io::Errno::NOENT => return Ok(()),
            Err(error) => return Err(error).context("open identity reservation for release"),
        };
        let opened = validate_root_regular_file(&reservation, "identity reservation")?;
        let current = rustix::fs::statat(&directory, &name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)?;
        if !same_lifecycle_object(&opened, &current) || current.st_nlink != 1 {
            bail!("identity reservation changed before release")
        }
        rustix::fs::unlinkat(&directory, &name, rustix::fs::AtFlags::empty())
            .context("release identity reservation by dirfd")?;
        rustix::fs::fsync(&directory)?;
        Ok(())
    }

    fn recover_reserved_identities(&mut self, config: &JailerdConfig) -> Result<BTreeSet<u32>> {
        recover_identity_reservations(config)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct IdentityReservationV1 {
    pub(super) version: u16,
    pub(super) generation: ValidatedId,
    pub(super) uid: u32,
    pub(super) gid: u32,
}

pub(super) fn validate_root_regular_stat(stat: &rustix::fs::Stat, label: &str) -> Result<()> {
    if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::RegularFile
        || stat.st_uid != 0
        || stat.st_gid != 0
        || stat.st_nlink != 1
        || stat.st_mode & 0o177 != 0
    {
        bail!("{label} must be a root-owned private regular file with one link")
    }
    Ok(())
}

pub(super) fn validate_root_regular_file(
    file: &impl std::os::fd::AsFd,
    label: &str,
) -> Result<rustix::fs::Stat> {
    let stat = rustix::fs::fstat(file)?;
    validate_root_regular_stat(&stat, label)?;
    Ok(stat)
}

pub(super) fn read_root_metadata_at(
    parent: &impl std::os::fd::AsFd,
    name: &CStr,
) -> Result<Vec<u8>> {
    let fd = open_lifecycle_entry_at(parent, name, OFlags::RDONLY)
        .context("open root metadata beneath pinned directory")?;
    validate_root_regular_file(&fd, "persisted VM metadata")?;
    let file = File::from(fd);
    let mut bytes = Vec::new();
    file.take((intar_jailer_protocol::MAX_FRAME_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > intar_jailer_protocol::MAX_FRAME_BYTES {
        bail!("persisted root metadata exceeds frame limit")
    }
    Ok(bytes)
}

pub(super) fn lifecycle_entry_exists_at(
    parent: &impl std::os::fd::AsFd,
    name: &CStr,
) -> Result<bool> {
    match rustix::fs::statat(parent, name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW) {
        Ok(_) => Ok(true),
        Err(error) if error == rustix::io::Errno::NOENT => Ok(false),
        Err(error) => Err(error).context("inspect lifecycle metadata entry"),
    }
}

pub(super) fn infer_generation_identity_at(
    directory: &impl std::os::fd::AsFd,
    config: &JailerdConfig,
) -> Option<(u32, u32)> {
    let fd = open_lifecycle_entry_at(directory, c"root/disks/root.raw", OFlags::RDONLY).ok()?;
    let stat = rustix::fs::fstat(&fd).ok()?;
    let uid = stat.st_uid;
    let gid = stat.st_gid;
    (rustix::fs::FileType::from_raw_mode(stat.st_mode) == rustix::fs::FileType::RegularFile
        && stat.st_nlink == 1
        && uid == gid
        && (config.uid_gid_start..=config.uid_gid_end).contains(&uid))
    .then_some((uid, gid))
}

#[cfg(target_os = "linux")]
pub(super) fn stop_orphan_generation(generation: &ValidatedId) -> Result<()> {
    let unit_name = format!("intar-vm-{generation}.service");
    let connection = zbus::blocking::Connection::system()?;
    let manager = SystemdHostBackend::manager(&connection)?;
    let path: Result<zbus::zvariant::OwnedObjectPath> = manager
        .call("GetUnit", &(unit_name.as_str(),))
        .map_err(Into::into);
    let Ok(path) = path else {
        return Ok(());
    };
    let service = zbus::blocking::Proxy::new(
        &connection,
        "org.freedesktop.systemd1",
        path,
        "org.freedesktop.systemd1.Service",
    )?;
    let control_group: String = service.get_property("ControlGroup")?;
    let _: zbus::zvariant::OwnedObjectPath =
        manager.call("StopUnit", &(unit_name.as_str(), "replace"))?;
    if !wait_cgroup_drained(&control_group, Duration::from_secs(5))? {
        let _: () = manager.call("KillUnit", &(unit_name.as_str(), "all", 9_i32))?;
        if !wait_cgroup_drained(&control_group, Duration::from_secs(10))? {
            bail!("orphan transient unit did not drain")
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(super) fn stop_orphan_generation(_generation: &ValidatedId) -> Result<()> {
    Ok(())
}
