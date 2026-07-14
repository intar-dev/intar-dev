#![forbid(unsafe_code)]

use getrandom::fill as getrandom_fill;

pub fn generate_local_unicast_mac() -> String {
    let mut tail = [0u8; 5];
    getrandom_fill(&mut tail).expect("OS randomness unavailable for MAC generation");

    format!(
        "02:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
        tail[0], tail[1], tail[2], tail[3], tail[4]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_mac_is_local_unicast() {
        let mac = generate_local_unicast_mac();
        let parts: Vec<u8> = mac
            .split(':')
            .map(|p| u8::from_str_radix(p, 16).expect("hex byte"))
            .collect();
        assert_eq!(parts.len(), 6);

        assert_eq!(parts[0], 0x02);
    }
}
