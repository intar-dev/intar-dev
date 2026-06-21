#![forbid(unsafe_code)]

use std::fs;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, UdpSocket};
use std::path::Path;

use fs2::{available_space, total_space};
use serde::Serialize;

const PRIMARY_IPV4_PROBE: (Ipv4Addr, u16) = (Ipv4Addr::new(1, 1, 1, 1), 80);
const PRIMARY_IPV6_PROBE: (Ipv6Addr, u16) = (
    Ipv6Addr::new(0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111),
    80,
);
const BYTES_PER_MIB: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostProfile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_ipv4: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_ipv6: Option<String>,
    pub cpu_cores: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_total_mib: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_available_mib: Option<u64>,
    pub disk_probe_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_total_mib: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_available_mib: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_avg1m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_avg5m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_avg15m: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct LoadAverages {
    avg1m: f64,
    avg5m: f64,
    avg15m: f64,
}

pub fn collect(disk_probe_path: &Path) -> HostProfile {
    let cpu_cores = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1);
    let (memory_total_mib, memory_available_mib) = read_memory_mib();
    let (load_avg1m, load_avg5m, load_avg15m) = read_load_averages()
        .map(|load| (Some(load.avg1m), Some(load.avg5m), Some(load.avg15m)))
        .unwrap_or((None, None, None));
    let disk_probe_path_string = disk_probe_path.display().to_string();
    let disk_total_mib = total_space(disk_probe_path)
        .ok()
        .map(bytes_to_mib_floor)
        .filter(|value| *value > 0);
    let disk_available_mib = available_space(disk_probe_path)
        .ok()
        .map(bytes_to_mib_floor)
        .filter(|value| *value > 0);

    HostProfile {
        primary_ipv4: detect_primary_ipv4(),
        primary_ipv6: detect_primary_ipv6(),
        cpu_cores,
        memory_total_mib,
        memory_available_mib,
        disk_probe_path: disk_probe_path_string,
        disk_total_mib,
        disk_available_mib,
        load_avg1m,
        load_avg5m,
        load_avg15m,
    }
}

fn read_memory_mib() -> (Option<u64>, Option<u64>) {
    let meminfo = match fs::read_to_string("/proc/meminfo") {
        Ok(meminfo) => meminfo,
        Err(_) => return (None, None),
    };
    let parsed = parse_meminfo_kib(&meminfo);
    (
        parsed.0.map(kib_to_mib_floor).filter(|value| *value > 0),
        parsed.1.map(kib_to_mib_floor).filter(|value| *value > 0),
    )
}

fn parse_meminfo_kib(meminfo: &str) -> (Option<u64>, Option<u64>) {
    let mut total_kib = None;
    let mut available_kib = None;

    for line in meminfo.lines() {
        let mut parts = line.split_whitespace();
        let key = parts.next().unwrap_or_default();
        let value = parts.next().and_then(|raw| raw.parse::<u64>().ok());
        match key {
            "MemTotal:" => total_kib = value,
            "MemAvailable:" => available_kib = value,
            _ => {}
        }
    }

    (total_kib, available_kib)
}

fn read_load_averages() -> Option<LoadAverages> {
    let loadavg = fs::read_to_string("/proc/loadavg").ok()?;
    parse_load_averages(&loadavg)
}

fn parse_load_averages(loadavg: &str) -> Option<LoadAverages> {
    let mut parts = loadavg.split_whitespace();
    Some(LoadAverages {
        avg1m: parts.next()?.parse::<f64>().ok()?,
        avg5m: parts.next()?.parse::<f64>().ok()?,
        avg15m: parts.next()?.parse::<f64>().ok()?,
    })
}

fn detect_primary_ipv4() -> Option<String> {
    detect_primary_ip_v4().map(|ip| ip.to_string())
}

fn detect_primary_ipv6() -> Option<String> {
    detect_primary_ip_v6().map(|ip| ip.to_string())
}

fn detect_primary_ip_v4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect(PRIMARY_IPV4_PROBE).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

fn detect_primary_ip_v6() -> Option<Ipv6Addr> {
    let socket = UdpSocket::bind((Ipv6Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect(PRIMARY_IPV6_PROBE).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V6(ip) if !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

fn kib_to_mib_floor(kib: u64) -> u64 {
    kib / 1024
}

fn bytes_to_mib_floor(bytes: u64) -> u64 {
    bytes / BYTES_PER_MIB
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_meminfo_reads_total_and_available() {
        let (total, available) = parse_meminfo_kib(
            "MemTotal:       32768000 kB\nMemFree:         1024000 kB\nMemAvailable:   24576000 kB\n",
        );

        assert_eq!(total, Some(32_768_000));
        assert_eq!(available, Some(24_576_000));
    }

    #[test]
    fn parse_load_averages_reads_first_three_values() {
        let parsed = parse_load_averages("0.11 0.22 0.33 1/234 5678").expect("parse loadavg");

        assert_eq!(
            parsed,
            LoadAverages {
                avg1m: 0.11,
                avg5m: 0.22,
                avg15m: 0.33,
            }
        );
    }

    #[test]
    fn collect_populates_disk_probe_path_even_without_metrics() {
        let tempdir = tempfile::tempdir().expect("create tempdir");

        let profile = collect(tempdir.path());

        assert_eq!(
            profile.disk_probe_path,
            tempdir.path().display().to_string()
        );
        assert!(profile.cpu_cores >= 1);
    }
}
