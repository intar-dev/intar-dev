//! Which hardware acceleration QEMU uses. Without one a lab is unusable
//! (the boot spike: k3s did not come up under emulation), so emulation is
//! never chosen silently: it has to be asked for.

use crate::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Arch {
    X86_64,
    Aarch64,
}

impl Arch {
    /// The architecture of this computer, if machine images can exist for it.
    pub fn host() -> Option<Self> {
        Self::parse(std::env::consts::ARCH)
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "x86_64" | "amd64" => Some(Self::X86_64),
            "aarch64" | "arm64" => Some(Self::Aarch64),
            _ => None,
        }
    }

    /// The guest's serial console, as its kernel names it: a 16550 on a PC,
    /// the PL011 of QEMU's `virt` machine on Arm.
    pub fn console(self) -> &'static str {
        match self {
            Self::X86_64 => "ttyS0",
            Self::Aarch64 => "ttyAMA0",
        }
    }

    pub fn qemu_binary(self) -> &'static str {
        match self {
            Self::X86_64 => "qemu-system-x86_64",
            Self::Aarch64 => "qemu-system-aarch64",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Accel {
    /// Linux.
    Kvm,
    /// macOS.
    Hvf,
    /// Windows.
    Whpx,
    /// Emulation: slow, and only when the caller asked for it.
    Tcg,
}

impl Accel {
    /// QEMU's `-accel` value.
    pub fn qemu_name(self) -> &'static str {
        match self {
            Self::Kvm => "kvm",
            Self::Hvf => "hvf",
            Self::Whpx => "whpx",
            Self::Tcg => "tcg,thread=multi",
        }
    }

    /// The acceleration for a `guest` machine on this computer, or why there
    /// is none.
    pub fn detect(guest: Arch) -> Result<Self, Error> {
        match Arch::host() {
            Some(host) if host == guest => Self::of_this_system(),
            _ => Err(Error::NoAcceleration(format!(
                "This machine image is built for {guest:?} processors and this computer has a different one, so it would have to be emulated, which is too slow for a lab.",
            ))),
        }
    }

    #[cfg(target_os = "linux")]
    fn of_this_system() -> Result<Self, Error> {
        use std::io::ErrorKind;
        match std::fs::OpenOptions::new().read(true).write(true).open("/dev/kvm") {
            Ok(_) => Ok(Self::Kvm),
            Err(error) if error.kind() == ErrorKind::PermissionDenied => Err(Error::NoAcceleration(
                "This account may not use KVM. Add it to the `kvm` group, then sign out and in again.".into(),
            )),
            Err(_) => Err(Error::NoAcceleration(
                "KVM is not available. Turn on virtualization (VT-x or AMD-V) in the computer's firmware settings.".into(),
            )),
        }
    }

    #[cfg(target_os = "macos")]
    fn of_this_system() -> Result<Self, Error> {
        let supported = std::process::Command::new("sysctl")
            .args(["-n", "kern.hv_support"])
            .output()
            .is_ok_and(|output| output.stdout.trim_ascii() == b"1");
        if supported {
            Ok(Self::Hvf)
        } else {
            Err(Error::NoAcceleration(
                "This Mac does not support the Hypervisor framework.".into(),
            ))
        }
    }

    // ponytail: assumed present on Windows; QEMU's own error shows if the
    // Windows Hypervisor Platform is off. Detect and guide in #405.
    #[cfg(target_os = "windows")]
    fn of_this_system() -> Result<Self, Error> {
        Ok(Self::Whpx)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    fn of_this_system() -> Result<Self, Error> {
        Err(Error::NoAcceleration(
            "This system has no hardware acceleration QEMU can use.".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn another_architecture_is_refused_with_a_reason_instead_of_emulated() {
        let other = match Arch::host() {
            Some(Arch::X86_64) => Arch::Aarch64,
            _ => Arch::X86_64,
        };
        let refusal = Accel::detect(other).expect_err("no silent emulation");
        assert!(
            matches!(&refusal, Error::NoAcceleration(reason) if reason.contains("too slow")),
            "{refusal}"
        );
        assert_eq!(Arch::parse("arm64"), Some(Arch::Aarch64));
        assert_eq!(Arch::parse("riscv64"), None);
    }
}
