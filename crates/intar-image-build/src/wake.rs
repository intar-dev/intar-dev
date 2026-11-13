//! The pieces of a wake image that are pure bytes (#348 §3): the `\_S3_`
//! table in front of the initrd, the command line of a wake image, the wake
//! stub patched from its template, the wake vector and the ACPI save in a
//! RAM file, and the files a step copies and trims.

use std::fs;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::Path;

use anyhow::{Context as _, Result, bail, ensure};

use crate::qemu::PUBLISHED_BOOT_CMDLINE;

/// One fixed shape for every base: what the guest is suspended with.
pub const WAKE_MEMORY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub const WAKE_BOOT_VCPUS: u32 = 2;
pub const WAKE_MAX_VCPUS: u32 = 4;
pub const WAKE_BALLOON: bool = true;
/// The guest physical address width at build and wake.
pub const WAKE_MAX_PHYS_BITS: u8 = 36;

/// The early unit of a wake image: takes every PCI device with a 64-bit
/// BAR 0 off the bus and rescans it, so Linux places them itself, not the
/// VMM. Runs only with [`WAKE_RESCAN_FLAG`] on the command line.
pub const WAKE_RESCAN_FLAG: &str = "intar.rescan";

/// Reserved for the stub (0x100000) and the saved ACPI tables (0x101000),
/// and where the VMM writes the command line at a wake.
const WAKE_RESERVATIONS: &str = "init_on_free=1 memmap=16K$0x100000 memmap=64K$0x20000";
const WAKE_CLOCK: &str = "clocksource=kvm-clock lapic=notscdeadline tsc=unstable";
/// The VMM loads the initrd right below 3 GiB.
const INITRD_LIMIT: u64 = 0xC000_0000;

/// The published command line of a wake image whose initrd is
/// `initrd_bytes` long: the cold one, the reservations, the rescan flag,
/// the clock, and the initrd's range, which the VMM fills at every wake.
#[must_use]
pub fn wake_cmdline(initrd_bytes: u64) -> String {
    let at = INITRD_LIMIT.saturating_sub(initrd_bytes) & !0xfff;
    format!(
        "{PUBLISHED_BOOT_CMDLINE} {WAKE_RESERVATIONS} {WAKE_RESCAN_FLAG} {WAKE_CLOCK} memmap=0x{:x}$0x{at:x}",
        INITRD_LIMIT - at
    )
}

/// An SSDT that adds `\_S3_ = {5, 5, 0, 0}` to cloud-hypervisor's ACPI
/// namespace: SLP_TYP 5 is what its sleep control register takes as
/// shutdown, so the guest's suspend ends the VMM. Linux loads it through
/// `ACPI_TABLE_UPGRADE` from an uncompressed newc cpio in front of the
/// initrd; this is that cpio, padded to 512 bytes.
#[must_use]
pub fn ssdt_initrd_prefix() -> Vec<u8> {
    // NameOp "\_S3_" PackageOp PkgLength 8, 4 elements: 5, 5, 0, 0.
    let body = [
        0x08, 0x5c, b'_', b'S', b'3', b'_', 0x12, 0x08, 0x04, 0x0a, 0x05, 0x0a, 0x05, 0x00, 0x00,
    ];
    let length = 36 + body.len();
    let mut table = Vec::with_capacity(length);
    table.extend_from_slice(b"SSDT");
    table.extend_from_slice(&u32::try_from(length).unwrap_or(0).to_le_bytes());
    table.extend_from_slice(&[2, 0]);
    table.extend_from_slice(b"INTAR S3SLEEP ");
    table.extend_from_slice(&1_u32.to_le_bytes());
    table.extend_from_slice(b"INTR");
    table.extend_from_slice(&1_u32.to_le_bytes());
    table.extend_from_slice(&body);
    let sum = table.iter().fold(0_u8, |sum, byte| sum.wrapping_add(*byte));
    table[9] = 0_u8.wrapping_sub(sum);

    let mut cpio = Vec::new();
    for (name, mode, data) in [
        ("kernel", 0o40755, &[][..]),
        ("kernel/firmware", 0o40755, &[][..]),
        ("kernel/firmware/acpi", 0o40755, &[][..]),
        ("kernel/firmware/acpi/intar-s3.aml", 0o100644, &table[..]),
        ("TRAILER!!!", 0, &[][..]),
    ] {
        let name_bytes = name.len() + 1;
        cpio.extend_from_slice(b"070701");
        for value in [0, mode, 0, 0, 1, 0, data.len(), 0, 0, 0, 0, name_bytes, 0] {
            cpio.extend_from_slice(format!("{value:08X}").as_bytes());
        }
        cpio.extend_from_slice(name.as_bytes());
        cpio.push(0);
        cpio.resize(cpio.len().next_multiple_of(4), 0);
        cpio.extend_from_slice(data);
        cpio.resize(cpio.len().next_multiple_of(4), 0);
    }
    cpio.resize(cpio.len().next_multiple_of(512), 0);
    cpio
}

/// One write of the stub through 0xcf8/0xcfc.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BarWrite {
    pub address: u32,
    pub value: u32,
}

/// The guest's BAR table: lines `<bb:dd.f> <config offset> <value>`, a
/// 64-bit BAR's lower half before its upper half.
///
/// # Errors
/// Returns an error on a line that does not parse.
pub fn parse_bar_table(text: &str) -> Result<Vec<BarWrite>> {
    let number = |field: &str| -> Result<u32> {
        let digits = field.strip_prefix("0x").unwrap_or(field);
        u32::from_str_radix(digits, 16).with_context(|| format!("`{field}` is not hex"))
    };
    let mut writes = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let [location, offset, value] = fields.as_slice() else {
            if fields.is_empty() || fields[0].starts_with('#') {
                continue;
            }
            bail!("BAR table line `{line}` is not `<bb:dd.f> <offset> <value>`");
        };
        let (bus, rest) = location
            .split_once(':')
            .context("BAR table location has no bus")?;
        let (device, function) = rest
            .split_once('.')
            .context("BAR table location has no function")?;
        let (bus, device, function) = (number(bus)?, number(device)?, number(function)?);
        ensure!(
            bus < 256 && device < 32 && function < 8,
            "BAR table location `{location}` is out of range"
        );
        writes.push(BarWrite {
            address: 0x8000_0000
                | bus << 16
                | device << 11
                | function << 8
                | (number(offset)? & 0xfc),
            value: number(value)?,
        });
    }
    Ok(writes)
}

fn find_once(bytes: &[u8], pattern: &[u8]) -> Result<usize> {
    let mut found = bytes
        .windows(pattern.len())
        .enumerate()
        .filter(|(_, window)| *window == pattern)
        .map(|(at, _)| at);
    match (found.next(), found.next()) {
        (Some(at), None) => Ok(at),
        _ => bail!("the stub template does not hold its pattern exactly once"),
    }
}

fn u32_at(bytes: &[u8], at: usize) -> Result<u32> {
    let slice = bytes
        .get(at..at + 4)
        .context("the stub template is cut short")?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn put(bytes: &mut [u8], at: usize, value: &[u8]) -> Result<()> {
    bytes
        .get_mut(at..at + value.len())
        .context("the stub template is cut short")?
        .copy_from_slice(value);
    Ok(())
}

/// The stub of a base: `template` (assembled for `bars.len()` BAR writes)
/// with the BAR table, the ACPI length and the far jump to `vector`. Byte
/// for byte what the assembler makes of the same inputs.
///
/// # Errors
/// Returns an error when the template is not one for this many writes.
pub fn patch_stub(
    template: &[u8],
    vector: u32,
    bars: &[BarWrite],
    acpi_len: u32,
) -> Result<Vec<u8>> {
    let mut stub = template.to_vec();
    // cli; cld; mov $0x29,%al; out %al,$0x80; mov $bartab,%esi
    let start = find_once(&stub, &[0xfa, 0xfc, 0xb0, 0x29, 0xe6, 0x80, 0xbe])?;
    let bartab = u32_at(&stub, start + 7)?;
    // _start is loaded at 1 MiB.
    let table = usize::try_from(bartab.checked_sub(0x10_0000).context("bartab")?)? + start;
    let mut count = 0;
    while u32_at(&stub, table + 8 * count)? != 0 {
        count += 1;
    }
    ensure!(
        count == bars.len() && count > 0,
        "the template has {count} BAR writes, the table {}",
        bars.len()
    );
    for (index, bar) in bars.iter().enumerate() {
        put(&mut stub, table + 8 * index, &bar.address.to_le_bytes())?;
        put(&mut stub, table + 8 * index + 4, &bar.value.to_le_bytes())?;
    }
    // mov $0xa0000,%edi; mov $len,%ecx; rep movsb
    let copy = find_once(&stub, &[0xbf, 0x00, 0x00, 0x0a, 0x00, 0xb9])?;
    ensure!(
        stub.get(copy + 10..copy + 12) == Some(&[0xf3, 0xa4][..]),
        "the template's ACPI copy is not `rep movsb`"
    );
    put(&mut stub, copy + 6, &acpi_len.to_le_bytes())?;
    // mov %eax,%cr0; ljmpw $seg,$off
    let jump = find_once(&stub, &[0x0f, 0x22, 0xc0, 0xea])?;
    ensure!(vector < 0x10_0000, "the wake vector is not below 1 MiB");
    let (offset, segment) = (vector & 15, vector >> 4);
    put(&mut stub, jump + 4, &u16::try_from(offset)?.to_le_bytes())?;
    put(&mut stub, jump + 6, &u16::try_from(segment)?.to_le_bytes())?;
    Ok(stub)
}

/// The template for `count` BAR writes out of the kernel build's tar.
///
/// # Errors
/// Returns an error when the tar has none for `count`.
pub fn stub_template(templates_tar: &[u8], count: usize) -> Result<Vec<u8>> {
    let wanted = format!("{count}.elf");
    let mut archive = tar::Archive::new(templates_tar);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        if path.file_name().and_then(|name| name.to_str()) == Some(wanted.as_str()) {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes)?;
            return Ok(bytes);
        }
    }
    bail!("the kernel build made no wake stub template for {count} BAR writes")
}

const MIB: usize = 1024 * 1024;
const WAKE_MAGIC: u32 = 0x1234_5678;
const WAKE_SIGNATURE: u32 = 0x51ee_1111;

/// The sleeping kernel's wake vector in the low MiB of a RAM file (guest
/// physical address = file offset): `real_mode_header->wakeup_start` of the
/// one `wakeup_header` whose `real_magic` is set, which must start with
/// `cli; cld; ljmpw`.
///
/// # Errors
/// Returns an error unless exactly one suspended image is found.
pub fn find_wake_vector(low: &[u8]) -> Result<u32> {
    let low = low.get(..MIB).unwrap_or(low);
    let read = |at: usize| u32_at(low, at).ok();
    let mut pair = Vec::with_capacity(8);
    pair.extend_from_slice(&WAKE_MAGIC.to_le_bytes());
    pair.extend_from_slice(&WAKE_SIGNATURE.to_le_bytes());
    let mut found = Vec::new();
    for position in low
        .windows(8)
        .enumerate()
        .filter(|(_, window)| *window == pair.as_slice())
        .map(|(at, _)| at)
    {
        let Some(header) = position.checked_sub(52) else {
            continue;
        };
        let header_u32 = u32::try_from(header)?;
        let page = header & !0xfff;
        let lowest = page.saturating_sub(0x20000);
        let mut base = page;
        loop {
            let fields: Option<Vec<u32>> = (0..12).map(|index| read(base + 4 * index)).collect();
            if let Some(fields) = fields {
                let base_u32 = u32::try_from(base)?;
                if let Some(index) = fields.iter().position(|field| *field == header_u32)
                    && index > 0
                    && base_u32 < fields[index - 1]
                    && fields[index - 1] < header_u32
                    && base_u32 < fields[0]
                    && fields[0] < header_u32
                {
                    found.push(fields[index - 1]);
                    break;
                }
            }
            if base < lowest + 0x1000 || base < 0x1000 {
                break;
            }
            base -= 0x1000;
        }
    }
    let [vector] = found.as_slice() else {
        bail!(
            "the RAM file holds {} suspended images, not one",
            found.len()
        );
    };
    let entry = usize::try_from(*vector)?;
    ensure!(
        low.get(entry..entry + 3) == Some(&[0xfa, 0xfc, 0xea][..]),
        "the wake vector {vector:#x} does not start with cli; cld; ljmpw"
    );
    Ok(*vector)
}

/// Where the VMM writes its RSDP and ACPI tables, and where the stub finds
/// the image's own copy.
const ACPI_TABLES: u64 = 0xa0000;
const ACPI_SAVE: u64 = 0x10_1000;
const ACPI_MAX: usize = 0x3000;

/// Copy the build VMM's ACPI tables (trailing zeros cut) into the reserved
/// page behind the stub, and return their length.
///
/// # Errors
/// Returns an error when the RAM file cannot be read or written, or holds
/// no tables.
pub fn save_acpi_tables(ram: &Path) -> Result<u32> {
    let mut file = fs::OpenOptions::new().read(true).write(true).open(ram)?;
    let mut tables = vec![0_u8; ACPI_MAX];
    file.seek(SeekFrom::Start(ACPI_TABLES))?;
    file.read_exact(&mut tables)?;
    let length = tables
        .iter()
        .rposition(|byte| *byte != 0)
        .map_or(0, |at| at + 1);
    ensure!(length > 0, "the RAM file holds no ACPI tables");
    file.seek(SeekFrom::Start(ACPI_SAVE))?;
    file.write_all(&tables[..length])?;
    file.sync_all()?;
    Ok(u32::try_from(length)?)
}

/// Bytes allocated on disk for `path`.
///
/// # Errors
/// Returns an error when `path` cannot be read.
#[cfg(unix)]
pub fn allocated_bytes(path: &Path) -> Result<u64> {
    use std::os::unix::fs::MetadataExt as _;
    Ok(fs::metadata(path)?.blocks().saturating_mul(512))
}

/// Copy `source` to `target` as a reflink where the file system can, else
/// sparse: only its data extents are written.
///
/// # Errors
/// Returns an error when a file cannot be read or written.
#[cfg(target_os = "linux")]
pub fn clone_or_sparse_copy(source: &Path, target: &Path) -> Result<()> {
    use rustix::fs::{SeekFrom as RawSeek, seek};
    if reflink_copy::reflink(source, target).is_ok() {
        return Ok(());
    }
    let mut input = fs::File::open(source)?;
    let mut output = fs::File::create(target)?;
    let size = input.metadata()?.len();
    output.set_len(size)?;
    let mut buffer = vec![0_u8; 4 * MIB];
    let mut at = 0_u64;
    while at < size {
        let Ok(data) = seek(&input, RawSeek::Data(at)) else {
            break;
        };
        let hole = seek(&input, RawSeek::Hole(data))?;
        let mut offset = data;
        input.seek(SeekFrom::Start(offset))?;
        output.seek(SeekFrom::Start(offset))?;
        while offset < hole {
            let take = usize::try_from((hole - offset).min(buffer.len() as u64))?;
            input.read_exact(&mut buffer[..take])?;
            output.write_all(&buffer[..take])?;
            offset += take as u64;
        }
        at = hole;
    }
    output.sync_all()?;
    Ok(())
}

/// Punch holes over every zero 4 KiB page of `path`, as `fallocate
/// --dig-holes` does; the guest's freed pages are zero (`init_on_free`).
///
/// # Errors
/// Returns an error when the file cannot be read or holes not punched.
#[cfg(target_os = "linux")]
pub fn punch_zero_pages(path: &Path) -> Result<()> {
    use rustix::fs::{FallocateFlags, SeekFrom as RawSeek, fallocate, seek};
    const PAGE: usize = 4096;
    let mut file = fs::OpenOptions::new().read(true).write(true).open(path)?;
    let size = file.metadata()?.len();
    let mut buffer = vec![0_u8; 4 * MIB];
    let flags = FallocateFlags::PUNCH_HOLE | FallocateFlags::KEEP_SIZE;
    let mut at = 0_u64;
    while at < size {
        let Ok(data) = seek(&file, RawSeek::Data(at)) else {
            break;
        };
        let hole = seek(&file, RawSeek::Hole(data))?;
        let mut offset = data;
        while offset < hole {
            let take = usize::try_from((hole - offset).min(buffer.len() as u64))?;
            file.seek(SeekFrom::Start(offset))?;
            file.read_exact(&mut buffer[..take])?;
            // Runs of zero pages, punched as one range each.
            let mut run: Option<u64> = None;
            for (index, page) in buffer[..take].chunks(PAGE).enumerate() {
                let page_at = offset + (index * PAGE) as u64;
                let zero = page.iter().all(|byte| *byte == 0) && page.len() == PAGE;
                match (zero, run) {
                    (true, None) => run = Some(page_at),
                    (false, Some(start)) => {
                        fallocate(&file, flags, start, page_at - start)?;
                        run = None;
                    }
                    _ => {}
                }
            }
            let end = offset + take as u64;
            if let Some(start) = run {
                fallocate(&file, flags, start, end - start)?;
            }
            offset = end;
        }
        at = hole;
    }
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest as _, Sha256};

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn the_ssdt_cpio_is_the_one_mkaml_writes() {
        let prefix = ssdt_initrd_prefix();
        assert_eq!(prefix.len(), 1024);
        let mut initrd = prefix;
        initrd.extend_from_slice(b"INITRD");
        // `mkaml.py s3.aml <"INITRD"> out` of the recipe.
        assert_eq!(
            hex(&Sha256::digest(&initrd)),
            "57069539f75f3300a9deabbc377f82a2477f2f3e661f110933d77a0f62f05b82"
        );
    }

    #[test]
    fn the_wake_command_line_reserves_the_initrd_below_3_gib() {
        // The recipe's initrd of 0x1e3c00 bytes.
        let cmdline = wake_cmdline(0x1e_3c00);
        assert_eq!(
            cmdline,
            "root=/dev/vda rw console=ttyS0 quiet loglevel=4 systemd.show_status=false init_on_free=1 memmap=16K$0x100000 memmap=64K$0x20000 intar.rescan clocksource=kvm-clock lapic=notscdeadline tsc=unstable memmap=0x1e4000$0xbfe1c000"
        );
        assert!(wake_cmdline(0x1e_4000).ends_with("memmap=0x1e4000$0xbfe1c000"));
        assert!(wake_cmdline(0x1e_4001).ends_with("memmap=0x1e5000$0xbfe1b000"));
    }

    const TABLE: &str = "00:01.0 0x10 0xc0000004
00:01.0 0x14 0x00000002
00:02.0 0x10 0xe0000000
00:03.0 0x10 0xe0080000
00:04.0 0x10 0xe0100000
00:05.0 0x10 0xc0080004
00:05.0 0x14 0x00000002
00:06.0 0x10 0xc0100004
00:06.0 0x14 0x00000002
00:07.0 0x10 0xc0180004
00:07.0 0x14 0x00000002
00:08.0 0x10 0xc0200004
00:08.0 0x14 0x00000002
";

    #[test]
    fn the_patched_template_is_what_mkstub_makes() {
        let template = include_bytes!("../tests/fixtures/wake-stub-template-13.elf");
        let bars = parse_bar_table(TABLE).expect("table");
        assert_eq!(
            bars[1],
            BarWrite {
                address: 0x8000_0814,
                value: 2
            }
        );
        let stub = patch_stub(template, 0x991d0, &bars, 5514).expect("stub");
        // `mkstub.py stub-template.elf out 0x991d0 bars.tbl 5514`.
        assert_eq!(
            hex(&Sha256::digest(&stub)),
            "6ba7de529445d6c1b0ea10e4e2e17dbefb6bf975cae8ee14d7b42fc06086265c"
        );
        let error = patch_stub(template, 0x991d0, &bars[..12], 5514).expect_err("count");
        assert!(error.to_string().contains("13 BAR writes"), "{error}");
        assert!(patch_stub(template, 0x10_0000, &bars, 1).is_err());
        assert!(parse_bar_table("00:01 0x10 0x1").is_err());
        assert!(parse_bar_table("00:20.0 0x10 0x1").is_err());
    }

    /// A low MiB with one real-mode blob at 0x99000: its header names
    /// `wakeup_start` at 0x991d0 and `wakeup_header` at 0x99400.
    fn low_mib(magic: bool) -> Vec<u8> {
        let mut low = vec![0_u8; MIB];
        let base = 0x99000;
        let fields: [u32; 12] = [
            0x99100, 0x99110, 0x99120, 0x991d0, 0x99400, 0, 0, 0, 0, 0, 0, 0,
        ];
        for (index, field) in fields.iter().enumerate() {
            low[base + 4 * index..base + 4 * index + 4].copy_from_slice(&field.to_le_bytes());
        }
        low[0x991d0..0x991d3].copy_from_slice(&[0xfa, 0xfc, 0xea]);
        if magic {
            low[0x99400 + 52..0x99400 + 56].copy_from_slice(&WAKE_MAGIC.to_le_bytes());
        }
        low[0x99400 + 56..0x99400 + 60].copy_from_slice(&WAKE_SIGNATURE.to_le_bytes());
        low
    }

    #[test]
    fn the_wake_vector_is_the_one_suspended_header() {
        assert_eq!(find_wake_vector(&low_mib(true)).expect("vector"), 0x991d0);
        // Not suspended: no magic.
        assert!(find_wake_vector(&low_mib(false)).is_err());
        // A vector that is not the wake-up code.
        let mut wrong = low_mib(true);
        wrong[0x991d2] = 0x90;
        assert!(find_wake_vector(&wrong).is_err());
        // Two suspended headers.
        let mut two = low_mib(true);
        let copy = two[0x99000..0x9a000].to_vec();
        two[0x59000..0x5a000].copy_from_slice(&copy);
        for (at, value) in [(0x59000, 0x59100), (0x5900c, 0x591d0), (0x59010, 0x59400)] {
            two[at..at + 4].copy_from_slice(&u32::to_le_bytes(value));
        }
        two[0x591d0..0x591d3].copy_from_slice(&[0xfa, 0xfc, 0xea]);
        assert!(find_wake_vector(&two).is_err());
    }

    #[test]
    fn the_acpi_tables_are_saved_behind_the_stub() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ram = dir.path().join("ram");
        let mut bytes = vec![0_u8; 0x20_0000];
        bytes[0xa0000..0xa0010].copy_from_slice(b"RSD PTR \x01\x02\x03\x04\x05\x06\x07\x08");
        bytes[0xa1000] = 9;
        fs::write(&ram, &bytes).expect("ram");
        assert_eq!(save_acpi_tables(&ram).expect("saved"), 0x1001);
        let after = fs::read(&ram).expect("ram");
        assert_eq!(after[0x101000..0x102001], bytes[0xa0000..0xa1001]);
        fs::write(&ram, vec![0_u8; 0x20_0000]).expect("ram");
        assert!(save_acpi_tables(&ram).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn zero_pages_become_holes_and_copies_stay_sparse() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ram = dir.path().join("ram");
        let mut bytes = vec![0_u8; 8 * MIB];
        bytes[5] = 1;
        bytes[6 * MIB + 7] = 2;
        fs::write(&ram, &bytes).expect("ram");
        punch_zero_pages(&ram).expect("holes");
        assert_eq!(fs::read(&ram).expect("ram"), bytes);
        assert!(allocated_bytes(&ram).expect("allocated") <= 64 * 1024);
        let copy = dir.path().join("copy");
        clone_or_sparse_copy(&ram, &copy).expect("copy");
        assert_eq!(fs::read(&copy).expect("copy"), bytes);
        assert!(allocated_bytes(&copy).expect("allocated") <= 64 * 1024);
    }
}
