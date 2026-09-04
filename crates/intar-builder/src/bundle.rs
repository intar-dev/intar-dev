#![allow(clippy::missing_errors_doc)]
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use flate2::read::GzDecoder;
use intar_contracts::bridge::DesiredBuildV1;
use intar_contracts::catalog::{
    CourseCatalogLectureV2, CourseCatalogSnapshotV2, ImageArchitecture,
};
use intar_image_build::{ScenarioContentHashInput, scenario_content_hash};
use intar_image_scenario::{BaseImageCatalog, Scenario};

const MAX_BUNDLE_TAR_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct BundleBuildInput {
    pub build: DesiredBuildV1,
    pub scenario_path: PathBuf,
    pub scenario_dir: PathBuf,
    pub scenario: Scenario,
    pub lecture: CourseCatalogLectureV2,
    pub base_catalog: BaseImageCatalog,
    pub target_arch: String,
}

pub async fn download_bundle_archive(
    base_url: &str,
    bearer_token: &str,
    rev: &str,
    cache_root: &Path,
) -> Result<PathBuf> {
    let archive_path = bundle_archive_path(cache_root, rev)?;
    if archive_path.is_file() {
        if let Err(error) = validate_bundle_archive(&archive_path) {
            tokio::fs::remove_file(&archive_path)
                .await
                .with_context(|| {
                    format!(
                        "cached bundle '{}' is invalid and could not be removed: {error:#}",
                        archive_path.display()
                    )
                })?;
        } else {
            return Ok(archive_path);
        }
    }

    let url = bundle_download_url(base_url, rev)?;
    let response = reqwest::Client::new()
        .get(&url)
        .bearer_auth(bearer_token.trim())
        .send()
        .await
        .with_context(|| format!("failed to download bundle {rev} from {url}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .context("failed to read bundle body")?;
    if !status.is_success() {
        let body = String::from_utf8_lossy(&bytes);
        bail!("bundle download failed with status {status}: {body}");
    }

    let parent = archive_path
        .parent()
        .ok_or_else(|| anyhow!("bundle archive path has no parent"))?;
    tokio::fs::create_dir_all(parent)
        .await
        .with_context(|| format!("failed to create bundle cache '{}'", parent.display()))?;
    let temp_path = archive_path.with_extension("tar.gz.tmp");
    tokio::fs::write(&temp_path, &bytes)
        .await
        .with_context(|| format!("failed to write '{}'", temp_path.display()))?;
    if let Err(error) = validate_bundle_archive(&temp_path) {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(error).with_context(|| {
            format!("downloaded bundle {rev} from {url} is not a valid bundle archive")
        });
    }
    tokio::fs::rename(&temp_path, &archive_path)
        .await
        .with_context(|| {
            format!(
                "failed to move '{}' to '{}'",
                temp_path.display(),
                archive_path.display()
            )
        })?;
    Ok(archive_path)
}

pub fn validate_bundle_archive(archive_path: &Path) -> Result<()> {
    validate_bundle_archive_with_limit(archive_path, MAX_BUNDLE_TAR_BYTES)
}

fn validate_bundle_archive_with_limit(archive_path: &Path, max_tar_bytes: u64) -> Result<()> {
    let archive_file = fs::File::open(archive_path)
        .with_context(|| format!("failed to open bundle '{}'", archive_path.display()))?;
    let decoder = LimitedBundleReader::new(GzDecoder::new(archive_file), max_tar_bytes);
    let mut archive = tar::Archive::new(decoder);
    let mut expanded_file_bytes = 0;

    for entry in archive.entries().context("failed to read bundle archive")? {
        let mut entry = entry.context("failed to read bundle entry")?;
        let relative_path = safe_archive_entry_path(entry.path()?.as_ref())?;
        let entry_type = entry.header().entry_type();
        if entry_type.is_file() {
            add_bundle_entry_size(
                &mut expanded_file_bytes,
                entry
                    .header()
                    .size()
                    .context("failed to read bundle entry size")?,
                &relative_path,
            )?;
            io::copy(&mut entry, &mut io::sink()).with_context(|| {
                format!("failed to read bundle entry '{}'", relative_path.display())
            })?;
        } else if !entry_type.is_dir() {
            bail!(
                "bundle archive contains unsupported entry type at {:?}",
                entry.path()?
            );
        }
    }
    Ok(())
}

struct LimitedBundleReader<R> {
    inner: R,
    limit: u64,
    read_bytes: u64,
}

impl<R> LimitedBundleReader<R> {
    fn new(inner: R, limit: u64) -> Self {
        Self {
            inner,
            limit,
            read_bytes: 0,
        }
    }
}

impl<R: Read> Read for LimitedBundleReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return self.inner.read(buf);
        }

        let remaining = self.limit.saturating_sub(self.read_bytes);
        if remaining == 0 {
            let mut probe = [0; 1];
            return match self.inner.read(&mut probe)? {
                0 => Ok(0),
                _ => Err(bundle_size_error(self.limit)),
            };
        }

        let max_len = usize::try_from(remaining.min(buf.len() as u64)).unwrap_or(buf.len());
        let read = self.inner.read(&mut buf[..max_len])?;
        self.read_bytes += read as u64;
        Ok(read)
    }
}

fn bundle_size_error(limit: u64) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("bundle archive expands beyond {limit} bytes"),
    )
}

pub fn bundle_download_url(base_url: &str, rev: &str) -> Result<String> {
    validate_bundle_rev(rev)?;
    let base_url = base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        bail!("bridge.base_url is required to download bundles");
    }
    Ok(format!("{base_url}/agent/registry/bundles/{rev}"))
}

pub fn bundle_archive_path(cache_root: &Path, rev: &str) -> Result<PathBuf> {
    validate_bundle_rev(rev)?;
    Ok(cache_root.join("bundles").join(format!("{rev}.tar.gz")))
}

pub fn unpack_bundle_archive(archive_path: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)
        .with_context(|| format!("failed to create '{}'", destination.display()))?;
    let archive_file = fs::File::open(archive_path)
        .with_context(|| format!("failed to open bundle '{}'", archive_path.display()))?;
    let decoder = LimitedBundleReader::new(GzDecoder::new(archive_file), MAX_BUNDLE_TAR_BYTES);
    let mut archive = tar::Archive::new(decoder);
    let mut expanded_file_bytes = 0;

    for entry in archive.entries().context("failed to read bundle archive")? {
        let mut entry = entry.context("failed to read bundle entry")?;
        let relative_path = safe_archive_entry_path(entry.path()?.as_ref())?;
        let output_path = destination.join(relative_path);
        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() {
            fs::create_dir_all(&output_path)
                .with_context(|| format!("failed to create '{}'", output_path.display()))?;
            continue;
        }
        if !entry_type.is_file() {
            bail!(
                "bundle archive contains unsupported entry type at {:?}",
                output_path
            );
        }
        add_bundle_entry_size(
            &mut expanded_file_bytes,
            entry
                .header()
                .size()
                .context("failed to read bundle entry size")?,
            &output_path,
        )?;
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create '{}'", parent.display()))?;
        }
        entry
            .unpack(&output_path)
            .with_context(|| format!("failed to unpack '{}'", output_path.display()))?;
    }
    Ok(())
}

fn add_bundle_entry_size(total: &mut u64, size: u64, path: &Path) -> Result<()> {
    *total = total
        .checked_add(size)
        .ok_or_else(|| anyhow!("bundle archive size overflow at '{}'", path.display()))?;
    if *total > MAX_BUNDLE_TAR_BYTES {
        bail!(
            "bundle archive expands beyond {} bytes at '{}'",
            MAX_BUNDLE_TAR_BYTES,
            path.display()
        );
    }
    Ok(())
}

pub fn verify_bundle_for_build(
    bundle_root: &Path,
    build: &DesiredBuildV1,
) -> Result<BundleBuildInput> {
    validate_desired_build_identity(build)?;
    let mut input = inspect_bundle_build_input(
        bundle_root,
        &build.scenario_id,
        build.arch.clone(),
        &build.rev,
    )?;
    if !input
        .build
        .content_hash
        .eq_ignore_ascii_case(&build.content_hash)
    {
        bail!(
            "desired build content hash mismatch for {}: expected {}, computed {}",
            build.scenario_id,
            build.content_hash,
            input.build.content_hash
        );
    }
    input.build = build.clone();
    Ok(input)
}

pub fn inspect_bundle_build_input(
    bundle_root: &Path,
    scenario_id: &str,
    arch: ImageArchitecture,
    rev: &str,
) -> Result<BundleBuildInput> {
    validate_safe_slug(scenario_id, "scenario id")?;
    validate_bundle_rev(rev)?;
    let target_arch = builder_arch(&arch);
    let base_catalog_path = bundle_root.join("base-images.hcl");
    let scenario_path = bundle_root
        .join("scenarios")
        .join(scenario_id)
        .join("scenario.hcl");
    let scenario_dir = scenario_path
        .parent()
        .ok_or_else(|| anyhow!("scenario path has no parent"))?
        .to_path_buf();
    let lecture = course_lecture_for_scenario(bundle_root, scenario_id)?;

    let base_catalog = BaseImageCatalog::from_file(&base_catalog_path).with_context(|| {
        format!(
            "failed to load base image catalog from '{}'",
            base_catalog_path.display()
        )
    })?;
    let scenario = Scenario::from_course_file(&scenario_path)
        .with_context(|| format!("failed to load scenario '{}'", scenario_path.display()))?;
    if scenario.name != scenario_id {
        bail!(
            "desired scenario id '{}' does not match scenario file '{}'",
            scenario_id,
            scenario.name
        );
    }
    scenario
        .validate_technical_for_builder_arch(target_arch)
        .with_context(|| format!("scenario '{}' failed validation", scenario.name))?;
    base_catalog
        .validate_for_builder_arch(target_arch)
        .with_context(|| format!("base image catalog failed validation for '{target_arch}'"))?;
    base_catalog
        .validate_scenario_for_builder_arch(&scenario, target_arch)
        .with_context(|| format!("scenario '{}' base images failed validation", scenario.name))?;

    let base_definition = scenario_base_definition_identity(&scenario, &base_catalog, target_arch)?;
    let content_hash = scenario_content_hash(&ScenarioContentHashInput {
        scenario_id: &scenario.name,
        scenario_dir: &scenario_dir,
        base_definition: &base_definition,
        target_arch,
    })?;
    let build_id = format!("{}-{target_arch}-{}", scenario.name, &content_hash[..12]);
    let build = DesiredBuildV1 {
        build_id,
        scenario_id: scenario.name.clone(),
        arch,
        rev: rev.to_owned(),
        content_hash,
        bundle_ref: format!("builds/bundles/{rev}.tar.gz"),
    };

    Ok(BundleBuildInput {
        build,
        scenario_path,
        scenario_dir,
        scenario,
        lecture,
        base_catalog,
        target_arch: target_arch.to_owned(),
    })
}

fn course_lecture_for_scenario(
    bundle_root: &Path,
    scenario_id: &str,
) -> Result<CourseCatalogLectureV2> {
    let catalog_path = bundle_root.join("curriculum/catalog.json");
    let catalog_bytes = fs::read(&catalog_path)
        .with_context(|| format!("failed to read course catalog '{}'", catalog_path.display()))?;
    let catalog: CourseCatalogSnapshotV2 =
        serde_json::from_slice(&catalog_bytes).with_context(|| {
            format!(
                "failed to parse course catalog '{}'",
                catalog_path.display()
            )
        })?;
    if catalog.version != 2 {
        bail!("unsupported course catalog version {}", catalog.version);
    }

    let mut course_ids = std::collections::HashSet::new();
    let mut scenario_ids = std::collections::HashSet::new();
    let mut result = None;
    for course in &catalog.courses {
        validate_safe_slug(&course.course_id, "course id")?;
        if !course_ids.insert(&course.course_id)
            || course.title.trim().is_empty()
            || course.summary.trim().is_empty()
            || course.body_markdown.trim().is_empty()
            || course.lectures.is_empty()
        {
            bail!("course '{}' has invalid catalog metadata", course.course_id);
        }
        let mut lecture_ids = std::collections::HashSet::new();
        for lecture in &course.lectures {
            validate_safe_slug(&lecture.lecture_id, "lecture id")?;
            if !lecture_ids.insert(&lecture.lecture_id)
                || lecture.title.trim().is_empty()
                || lecture.summary.trim().is_empty()
                || lecture.body_markdown.trim().is_empty()
                || lecture.category.trim().is_empty()
                || lecture.estimated_minutes == 0
            {
                bail!(
                    "course '{}', lecture '{}' has invalid catalog metadata",
                    course.course_id,
                    lecture.lecture_id
                );
            }
            let Some(linked_scenario_id) = lecture.scenario_id.as_deref() else {
                continue;
            };
            validate_safe_slug(linked_scenario_id, "scenario id")?;
            if !scenario_ids.insert(linked_scenario_id) {
                bail!(
                    "scenario '{}' belongs to multiple lectures",
                    linked_scenario_id
                );
            }
            if lecture.difficulty.is_none() {
                bail!(
                    "course '{}', lecture '{}' links a scenario but has no difficulty",
                    course.course_id,
                    lecture.lecture_id
                );
            }
            if linked_scenario_id == scenario_id {
                result = Some(lecture.clone());
            }
        }
    }
    result.with_context(|| format!("scenario '{scenario_id}' has no curriculum lecture"))
}

pub fn validate_desired_build_identity(build: &DesiredBuildV1) -> Result<()> {
    validate_build_id(&build.build_id)?;
    validate_safe_slug(&build.scenario_id, "scenario id")?;
    validate_bundle_rev(&build.rev)?;
    validate_sha256_hex(&build.content_hash, "content hash")?;
    let expected_bundle_ref = bundle_ref_for_rev(&build.rev);
    if build.bundle_ref != expected_bundle_ref {
        bail!(
            "desired build bundle ref mismatch for {}: expected {}, got {}",
            build.scenario_id,
            expected_bundle_ref,
            build.bundle_ref
        );
    }
    Ok(())
}

pub(crate) fn validate_build_id(value: &str) -> Result<()> {
    validate_safe_slug(value, "build id")
}

fn bundle_ref_for_rev(rev: &str) -> String {
    format!("builds/bundles/{rev}.tar.gz")
}

fn scenario_base_definition_identity(
    scenario: &Scenario,
    base_catalog: &BaseImageCatalog,
    target_arch: &str,
) -> Result<String> {
    let mut definitions = BTreeMap::new();
    for image in scenario.images.values() {
        let base_image = base_catalog
            .base_image_by_name(&image.base)
            .with_context(|| format!("base image '{}' not found in catalog", image.base))?;
        let definition = base_image
            .definition_for_arch(target_arch)
            .with_context(|| {
                format!(
                    "base image '{}' has no {target_arch} mmdebstrap definition",
                    image.base
                )
            })?;
        definitions.insert(image.base.clone(), definition.content_identity());
    }

    Ok(definitions
        .iter()
        .map(|(name, definition)| format!("{name}\n{definition}"))
        .collect::<Vec<_>>()
        .join("\n---\n"))
}

fn safe_archive_entry_path(path: &Path) -> Result<PathBuf> {
    let mut safe = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| anyhow!("bundle path is not valid UTF-8"))?;
                validate_safe_path_component(value)?;
                safe.push(value);
            }
            Component::CurDir => {}
            _ => bail!(
                "bundle archive entry escapes destination: {}",
                path.display()
            ),
        }
    }
    if safe.as_os_str().is_empty() {
        bail!("bundle archive entry path is empty");
    }
    Ok(safe)
}

fn builder_arch(arch: &ImageArchitecture) -> &'static str {
    match arch {
        ImageArchitecture::X86_64 => "amd64",
        ImageArchitecture::Aarch64 => "arm64",
    }
}

fn validate_safe_slug(value: &str, label: &str) -> Result<()> {
    if (1..=128).contains(&value.len())
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Ok(());
    }
    bail!("invalid {label} '{value}'");
}

pub fn validate_bundle_rev(value: &str) -> Result<()> {
    validate_safe_slug(value, "bundle rev")
}

fn validate_sha256_hex(value: &str, label: &str) -> Result<()> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(());
    }
    bail!("invalid {label} '{value}'");
}

fn validate_safe_path_component(value: &str) -> Result<()> {
    if value.is_empty() || value == "." || value == ".." || value.contains('/') {
        bail!("invalid bundle archive path component '{value}'");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::io::Write;
    use std::path::Path;

    use flate2::Compression;
    use flate2::write::GzEncoder;
    use intar_contracts::catalog::ImageArchitecture;
    use intar_image_build::{ScenarioContentHashInput, scenario_content_hash};

    use super::{
        bundle_archive_path, bundle_download_url, inspect_bundle_build_input,
        safe_archive_entry_path, unpack_bundle_archive, validate_bundle_archive,
        validate_bundle_archive_with_limit, validate_desired_build_identity,
        verify_bundle_for_build,
    };

    #[test]
    fn builds_bundle_download_url() {
        assert_eq!(
            bundle_download_url("https://intar.dev/", "abc123").unwrap(),
            "https://intar.dev/agent/registry/bundles/abc123"
        );
        assert!(bundle_download_url("https://intar.dev", "../escape").is_err());
    }

    #[test]
    fn bundle_archive_path_rejects_unsafe_rev() {
        assert_eq!(
            bundle_archive_path(Path::new("/cache"), "abc123")
                .unwrap()
                .to_string_lossy(),
            "/cache/bundles/abc123.tar.gz"
        );
        assert!(bundle_archive_path(Path::new("/cache"), "bad/rev").is_err());
        assert!(bundle_archive_path(Path::new("/cache"), "..").is_err());
    }

    #[test]
    fn archive_path_guard_rejects_parent_paths() {
        let error = safe_archive_entry_path(Path::new("../escape")).unwrap_err();
        assert!(format!("{error:#}").contains("escapes destination"));
    }

    #[test]
    fn validates_readable_bundle_archive() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("bundle.tar.gz");
        write_archive(&archive_path, &[("base-images.hcl", b"base".as_slice())]);

        validate_bundle_archive(&archive_path).unwrap();
    }

    #[test]
    fn rejects_bundle_archive_when_tar_overhead_exceeds_limit() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("bundle.tar.gz");
        write_archive(
            &archive_path,
            &[
                ("base-images.hcl", b"base".as_slice()),
                ("scenarios/demo/scenario.hcl", b"scenario {}".as_slice()),
            ],
        );

        let error = validate_bundle_archive_with_limit(&archive_path, 1024).unwrap_err();
        assert!(format!("{error:#}").contains("expands beyond 1024 bytes"));
    }

    #[test]
    fn rejects_corrupt_bundle_archive() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("bundle.tar.gz");
        std::fs::write(&archive_path, b"not gzip").unwrap();

        let error = validate_bundle_archive(&archive_path).unwrap_err();
        assert!(!format!("{error:#}").is_empty());
    }

    #[test]
    fn rejects_truncated_bundle_file_payload() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("bundle.tar.gz");
        write_truncated_file_archive(&archive_path);

        let error = validate_bundle_archive(&archive_path).unwrap_err();
        assert!(format!("{error:#}").contains("failed to read bundle entry"));
    }

    #[test]
    fn rejects_unsupported_bundle_archive_entry() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("bundle.tar.gz");
        write_symlink_archive(&archive_path);

        let error = validate_bundle_archive(&archive_path).unwrap_err();
        assert!(format!("{error:#}").contains("unsupported entry type"));
    }

    #[test]
    fn rejects_oversized_bundle_archive() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("bundle.tar.gz");
        write_oversized_archive(&archive_path);

        let error = validate_bundle_archive(&archive_path).unwrap_err();
        assert!(format!("{error:#}").contains("expands beyond"));

        let error =
            unpack_bundle_archive(&archive_path, &temp.path().join("unpacked")).unwrap_err();
        assert!(format!("{error:#}").contains("expands beyond"));
        assert!(!temp.path().join("unpacked/huge").exists());
    }

    #[test]
    fn verifies_bundle_content_hash() {
        let temp = tempfile::tempdir().unwrap();
        write_bundle_fixture(temp.path());
        let scenario_dir = temp.path().join("scenarios/broken-nginx");
        let expected_hash = scenario_content_hash(&ScenarioContentHashInput {
            scenario_id: "broken-nginx",
            scenario_dir: &scenario_dir,
            base_definition: "trixie\nsuite=trixie\nmirror=https://deb.debian.org/debian\narch=amd64\nkernel_package=linux-image-cloud-amd64\npackages=openssh-server,ca-certificates,sudo,zstd",
            target_arch: "amd64",
        })
        .unwrap();

        let build = desired_build(&expected_hash);
        let verified = verify_bundle_for_build(temp.path(), &build).unwrap();

        assert_eq!(verified.build, build);
        assert_eq!(verified.scenario.name, "broken-nginx");
        assert_eq!(verified.build.content_hash, expected_hash);
        assert_eq!(verified.lecture.title, "Broken Nginx");

        let wrong_hash = desired_build(&"f".repeat(64));
        let error = verify_bundle_for_build(temp.path(), &wrong_hash).unwrap_err();
        assert!(format!("{error:#}").contains("content hash mismatch"));
    }

    #[test]
    fn verifies_desired_build_bundle_identity() {
        let temp = tempfile::tempdir().unwrap();
        write_bundle_fixture(temp.path());

        let mut unsafe_rev = desired_build(&"f".repeat(64));
        unsafe_rev.rev = "../escape".to_owned();
        let error = verify_bundle_for_build(temp.path(), &unsafe_rev).unwrap_err();
        assert!(format!("{error:#}").contains("invalid bundle rev"));

        let mut dot_scenario = desired_build(&"f".repeat(64));
        dot_scenario.scenario_id = "..".to_owned();
        let error = verify_bundle_for_build(temp.path(), &dot_scenario).unwrap_err();
        assert!(format!("{error:#}").contains("invalid scenario id"));

        let mut wrong_ref = desired_build(&"f".repeat(64));
        wrong_ref.bundle_ref = "builds/bundles/other.tar.gz".to_owned();
        let error = verify_bundle_for_build(temp.path(), &wrong_ref).unwrap_err();
        assert!(format!("{error:#}").contains("bundle ref mismatch"));
    }

    #[test]
    fn rejects_invalid_desired_build_identity_before_unpack_use() {
        let mut build = desired_build(&"f".repeat(64));
        build.build_id = "../escape".to_owned();
        let error = validate_desired_build_identity(&build).unwrap_err();
        assert!(format!("{error:#}").contains("invalid build id"));

        let build = desired_build("not-a-sha");
        let error = validate_desired_build_identity(&build).unwrap_err();
        assert!(format!("{error:#}").contains("invalid content hash"));
    }

    #[test]
    fn inspects_bundle_build_input_for_run_once() {
        let temp = tempfile::tempdir().unwrap();
        write_bundle_fixture(temp.path());

        let input = inspect_bundle_build_input(
            temp.path(),
            "broken-nginx",
            ImageArchitecture::X86_64,
            "abc123",
        )
        .unwrap();

        assert_eq!(input.scenario.name, "broken-nginx");
        assert_eq!(input.build.scenario_id, "broken-nginx");
        assert_eq!(input.build.rev, "abc123");
        assert_eq!(input.build.bundle_ref, "builds/bundles/abc123.tar.gz");
        assert_eq!(input.build.content_hash.len(), 64);
        assert!(input.build.build_id.starts_with("broken-nginx-amd64-"));
        assert_eq!(input.target_arch, "amd64");
        assert_eq!(input.lecture.title, "Broken Nginx");
        assert_eq!(
            input.lecture.body_markdown,
            "Nginx should be serving the default site."
        );
    }

    fn desired_build(content_hash: &str) -> intar_contracts::bridge::DesiredBuildV1 {
        intar_contracts::bridge::DesiredBuildV1 {
            build_id: "build-1".to_owned(),
            scenario_id: "broken-nginx".to_owned(),
            arch: ImageArchitecture::X86_64,
            rev: "abc123".to_owned(),
            content_hash: content_hash.to_owned(),
            bundle_ref: "builds/bundles/abc123.tar.gz".to_owned(),
        }
    }

    fn write_bundle_fixture(root: &Path) {
        std::fs::create_dir_all(root.join("scenarios/broken-nginx")).unwrap();
        std::fs::create_dir_all(root.join("curriculum")).unwrap();
        std::fs::write(
            root.join("base-images.hcl"),
            r#"
base_image "trixie" {
  suite = "trixie"
  mirror = "https://deb.debian.org/debian"
  arch = "amd64"
  kernel_package = "linux-image-cloud-amd64"
  packages = ["openssh-server", "ca-certificates", "sudo", "zstd"]
}
"#,
        )
        .unwrap();
        std::fs::write(
            root.join("curriculum/catalog.json"),
            r#"{
  "version": 2,
  "courses": [{
    "course_id": "linux",
    "title": "Linux",
    "summary": "Learn Linux.",
    "body_markdown": "Course theory.",
    "sequential": true,
    "lectures": [{
      "lecture_id": "01-nginx",
      "title": "Broken Nginx",
      "summary": "Fix a misconfigured nginx server.",
      "body_markdown": "Nginx should be serving the default site.",
      "category": "web",
      "tags": ["nginx"],
      "difficulty": "easy",
      "estimated_minutes": 15,
      "scenario_id": "broken-nginx"
    }]
  }]
}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("scenarios/broken-nginx/scenario.hcl"),
            r#"
scenario "broken-nginx" {
  solution {
    body = "Start nginx."
  }

  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    defaults {
      every_seconds = 2
      timeout_seconds = 3
    }

    probe "nginx-running" {
      kind        = "service"
      service     = "nginx"
      state       = "running"
      description = "Nginx should be running"
    }
  }

  vm "webserver" {
    cpu      = 1
    memory   = 512
    disk     = 2
    image    = "debian-12-minimal"
    packages = ["nginx"]
    probes   = ["nginx-running"]
  }
}
"#,
        )
        .unwrap();
    }

    fn write_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let output = std::fs::File::create(path).unwrap();
        let encoder = GzEncoder::new(output, Compression::default());
        let mut builder = tar::Builder::new(encoder);
        for (archive_path, bytes) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, Path::new(archive_path), *bytes)
                .unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
    }

    fn write_symlink_archive(path: &Path) {
        let output = std::fs::File::create(path).unwrap();
        let encoder = GzEncoder::new(output, Compression::default());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        builder.append_link(&mut header, "link", "target").unwrap();
        builder.into_inner().unwrap().finish().unwrap();
    }

    fn write_truncated_file_archive(path: &Path) {
        let output = std::fs::File::create(path).unwrap();
        let mut encoder = GzEncoder::new(output, Compression::default());
        let mut header = tar::Header::new_gnu();
        header.set_path("base-images.hcl").unwrap();
        header.set_size(8);
        header.set_mode(0o644);
        header.set_cksum();
        encoder.write_all(header.as_bytes()).unwrap();
        encoder.finish().unwrap();
    }

    fn write_oversized_archive(path: &Path) {
        let output = std::fs::File::create(path).unwrap();
        let mut encoder = GzEncoder::new(output, Compression::default());
        let mut header = tar::Header::new_gnu();
        header.set_path("huge").unwrap();
        header.set_size(super::MAX_BUNDLE_TAR_BYTES + 1);
        header.set_mode(0o644);
        header.set_cksum();
        encoder.write_all(header.as_bytes()).unwrap();
        encoder.write_all(&[0; 1024]).unwrap();
        encoder.finish().unwrap();
    }
}
