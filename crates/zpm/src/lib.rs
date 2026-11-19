//! Runs a lab's machines under QEMU on the learner's own computer (#391, #398).
//!
//! This first part starts and stops one machine: it picks the hardware
//! acceleration, builds QEMU's command line for a contract-3 machine image
//! (direct kernel boot, virtio disks, user-mode networking with an SSH
//! forward) and owns the process. The lifecycle is ported from intar-cli's
//! `intar-vm`; the command line is the one the boot spike (#392) measured.
//!
//! It also writes the run disk Kino boots from and reads Kino's reports.
//! Pulling images is not here yet.

pub mod accel;
pub mod broker;
pub mod machine;
pub mod preflight;
pub mod qemu;
pub mod reports;
pub mod rundisk;

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
    /// The computer has too little of something for the lab. The text names
    /// what and how much; the caller shows it as it is.
    #[error("{0}")]
    Preflight(String),
    /// Something the machine boots from is not on this computer.
    #[error("{0}")]
    NotCached(String),
    /// The run disk could not be written, or what should go on it is unusable.
    #[error("{0}")]
    RunDisk(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
