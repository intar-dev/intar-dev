//! Runs a lab's machines under QEMU on the learner's own computer (#391, #398).
//!
//! This first part starts and stops one machine: it picks the hardware
//! acceleration, builds QEMU's command line for a contract-3 machine image
//! (direct kernel boot, virtio disks, user-mode networking with an SSH
//! forward) and owns the process. The lifecycle is ported from intar-cli's
//! `intar-vm`; the command line is the one the boot spike (#392) measured.
//!
//! Pulling images, writing the run disk and reading Kino's reports are not
//! here yet.

pub mod accel;
pub mod qemu;

pub use accel::{Accel, Arch};
pub use qemu::{Disk, DiskFormat, Machine, UserNetwork, Vm, create_overlay, qemu_args};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The computer cannot run this machine at usable speed. The text says
    /// what to do about it; the caller shows it as it is.
    #[error("{0}")]
    NoAcceleration(String),
    /// QEMU or qemu-img could not be started, or stopped right away.
    #[error("{0}")]
    Qemu(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
