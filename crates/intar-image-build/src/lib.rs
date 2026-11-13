//! Machine and repository-image builds of image format 3 from a
//! `SourceBundleV2`: the platform base, the build VM with its checkpoints,
//! and the OCI image output.

mod checkpoint;
mod chunked;
mod compute;
mod config;
mod disk;
mod kernel;
#[cfg(unix)]
mod machine;
mod oci;
mod platform;
mod qemu;
mod rootfs;
mod seed;
mod sha256;
mod ssh;
pub mod wake;

pub use chunked::{
    ChunkedImageArtifact, EncodedImageChunkArtifact, ReusedEncodedImageChunk, ScannedChunkedImage,
    ScannedImageChunk, reconstruct_chunked_image, scan_raw_image_chunks,
    write_chunked_image_artifact, write_scanned_chunked_image_artifact,
};
pub use config::{LayeredBuildConfig, QemuBuildConfig};
pub use kernel::{
    KERNEL_APT_SNAPSHOT, KERNEL_APT_SNAPSHOT_URL, KERNEL_BUILD_HOST, KERNEL_BUILD_SCRIPT_SOURCE,
    KERNEL_BUILD_USER, KERNEL_BUSYBOX_STATIC_VERSION, KERNEL_CONFIG_FRAGMENT,
    KERNEL_E2FSCK_STATIC_VERSION, KERNEL_INITRAMFS_INIT_SCRIPT, KERNEL_LOCALVERSION,
    KERNEL_PROVENANCE_PATH, KERNEL_REQUIRED_BUILTINS, KERNEL_SOURCE_BASE_URL,
    KERNEL_SOURCE_DATE_EPOCH, KERNEL_SOURCE_FILES, KERNEL_SOURCE_VERSION, KERNEL_UPSTREAM_VERSION,
    KernelSourceFile, kernel_build_script_tokens, kernel_image_file_name, kernel_initrd_file_name,
    kernel_profile_digest, kernel_release, missing_required_builtins, render_kernel_build_script,
};
#[cfg(unix)]
pub use machine::{
    BuildPlan, BuildTarget, MachineBuildOutput, MachineBuildRequest, MachineImage, PlannedNode,
    PlannedStage, VerifiedMachineImage, build_machine_image, machine_build_log_path, plan_build,
    reconstruct_machine_disk, verify_machine_image, write_machine_image,
};
pub use platform::{PLATFORM_BASE_DISK_BYTES, ensure_platform_base, render_platform_rootfs_plan};
pub use rootfs::{BaseRootfsArtifact, RootfsBuildPaths, RootfsBuildPlan};
pub use sha256::sha256_file_hex;
